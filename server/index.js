import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { VARIANTS } from './variants.js';
import { exportDeckOrder } from './game.js';
import { GameError } from './rules.js';
import {
  applyAction,
  clearImportedDeck,
  configureRoom,
  importDeck,
  joinRoom,
  leaveRoom,
  movePlayer,
  renamePlayer,
  resumeRoom,
  returnToLobby,
  startGame,
  undoLast,
  viewFor,
  voteAbandon,
} from './room.js';
import { addRoom, createRoom, deleteRoom, getRoom, isRoomIdle, listRooms } from './rooms.js';
import { listIncompleteSaves, savedDir } from './savedGame.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.json': 'application/json',
};

// Order matters — first existing match wins (so a swapped-in .png beats an
// older .svg with the same basename).
const CARD_EXTS = ['.png', '.webp', '.jpg', '.jpeg', '.avif', '.svg', '.gif'];

async function tryServeCard(rel, res) {
  const base = rel.slice('/cards/'.length);
  if (!base || base.includes('/') || base.startsWith('.')) return false;
  const cardsDir = path.join(CLIENT_DIR, 'cards');
  for (const ext of CARD_EXTS) {
    const candidate = path.join(cardsDir, base + ext);
    if (!candidate.startsWith(cardsDir)) continue;
    try {
      const data = await fs.readFile(candidate);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return false;
}

const connections = new Map();

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function maybeResumeAtBoot() {
  if (process.env.HANABI_NO_RESUME_PROMPT === '1') return;
  const incomplete = await listIncompleteSaves();
  if (incomplete.length === 0) return;
  if (!process.stdin.isTTY) {
    console.log(
      `(${incomplete.length} incomplete save(s) in saved-games/; available for resume from the server lobby)`,
    );
    return;
  }
  const top = incomplete.slice(0, 3);
  console.log('\nIncomplete saved games found:');
  for (let i = 0; i < top.length; i++) {
    const s = top[i];
    const variant = s.variantId.padEnd(22);
    console.log(`  [${i + 1}] ${s.basename}  ${variant}  ${s.moves} moves  (${s.playerNames.join(', ')})`);
  }
  const ans = (await prompt('Resume any into a starter room? [1-3, filename, or Enter to skip]: ')).trim();
  if (!ans) return;
  let filePath = null;
  const n = Number(ans);
  if (Number.isInteger(n) && n >= 1 && n <= top.length) {
    filePath = top[n - 1].filePath;
  } else {
    filePath = path.isAbsolute(ans) ? ans : path.join(savedDir(), ans);
  }
  try {
    const resumed = await resumeRoom(filePath);
    const r = addRoom(resumed, `Resumed ${path.basename(filePath)}`);
    console.log(`Resumed ${path.basename(filePath)} into room ${r.id} — ${r.players.length} players, turn ${r.state.turn}.`);
  } catch (err) {
    console.error(`Could not resume ${filePath}: ${err.message}`);
  }
}

async function serverLobbyView() {
  const saves = (await listIncompleteSaves()).slice(0, 20).map((s) => ({
    basename: s.basename,
    variantId: s.variantId,
    playerNames: s.playerNames,
    moves: s.moves,
    startedAt: s.startedAt,
  }));
  return {
    kind: 'server-lobby',
    rooms: listRooms(),
    resumableSaves: saves,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    // Extensionless /cards/<name> requests probe the cards/ folder for any
    // supported image format (png, webp, jpg, svg, …) and serve whichever
    // file is present — so the host can swap formats without touching code.
    if (rel.startsWith('/cards/') && !path.extname(rel)) {
      if (await tryServeCard(rel, res)) return;
      res.writeHead(404).end('Not found');
      return;
    }
    const filePath = path.join(CLIENT_DIR, rel);
    if (!filePath.startsWith(CLIENT_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404).end('Not found');
    } else {
      console.error(err);
      res.writeHead(500).end('Server error');
    }
  }
});

// A dedicated path (rather than the root) keeps the WebSocket upgrade from
// colliding with a reverse proxy's static-file/index-file shortcut for '/'.
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function inRoomViewFor(room, playerId) {
  const v = viewFor(room, playerId);
  v.kind = 'in-room';
  v.roomId = room.id;
  v.roomName = room.name;
  return v;
}

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  for (const [ws, conn] of connections) {
    if (conn.roomId !== roomId) continue;
    send(ws, { type: 'sync', view: inRoomViewFor(room, conn.playerId) });
  }
}

async function broadcastServerLobby() {
  const view = await serverLobbyView();
  for (const [ws, conn] of connections) {
    if (conn.roomId) continue;
    send(ws, { type: 'sync', view });
  }
}

async function broadcastRoomAndLobby(roomId) {
  broadcastRoom(roomId);
  await broadcastServerLobby();
}

function sendError(ws, error, code = 'error') {
  send(ws, { type: 'error', error, code });
}

// Drops every connection seated in a (just-deleted) room back to the server
// lobby.
async function kickRoomConnections(roomId) {
  for (const [ws, conn] of connections) {
    if (conn.roomId === roomId) {
      conn.roomId = null;
      conn.playerId = null;
      send(ws, { type: 'sync', view: await serverLobbyView() });
    }
  }
}

function requireRoom(conn) {
  if (!conn.roomId) throw new GameError('Not in a room', 'no_room');
  const room = getRoom(conn.roomId);
  if (!room) throw new GameError('Room no longer exists', 'no_room');
  return room;
}

function requireSeat(conn) {
  const room = requireRoom(conn);
  if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
  return room;
}

wss.on('connection', async (ws) => {
  const conn = { playerId: null, roomId: null };
  connections.set(ws, conn);
  send(ws, {
    type: 'hello',
    variants: Object.values(VARIANTS).map((v) => ({ id: v.id, name: v.name })),
  });
  send(ws, { type: 'sync', view: await serverLobbyView() });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendError(ws, 'invalid_json');
      return;
    }
    try {
      switch (msg.type) {
        case 'createRoom': {
          const r = createRoom(msg.roomName);
          const player = joinRoom(r, { name: msg.playerName, playerId: msg.playerId });
          r.creatorId = player.id;
          conn.playerId = player.id;
          conn.roomId = r.id;
          send(ws, { type: 'identity', playerId: player.id, roomId: r.id, roomName: r.name });
          await broadcastRoomAndLobby(r.id);
          break;
        }
        case 'enterRoom': {
          const r = getRoom(msg.roomId);
          if (!r) throw new GameError('Room not found', 'no_room');
          const player = joinRoom(r, { name: msg.playerName, playerId: msg.playerId });
          conn.playerId = player.id;
          conn.roomId = r.id;
          send(ws, { type: 'identity', playerId: player.id, roomId: r.id, roomName: r.name });
          await broadcastRoomAndLobby(r.id);
          break;
        }
        case 'leaveRoom': {
          const prevRoomId = conn.roomId;
          if (prevRoomId) {
            const r = getRoom(prevRoomId);
            if (r && conn.playerId) leaveRoom(r, conn.playerId);
          }
          conn.roomId = null;
          conn.playerId = null;
          send(ws, { type: 'sync', view: await serverLobbyView() });
          if (prevRoomId) broadcastRoom(prevRoomId);
          await broadcastServerLobby();
          break;
        }
        case 'resumeSave': {
          const fileArg = String(msg.file || '');
          const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(savedDir(), fileArg);
          const resumed = await resumeRoom(filePath);
          const r = addRoom(resumed, msg.roomName);
          send(ws, { type: 'roomCreated', roomId: r.id, roomName: r.name });
          await broadcastServerLobby();
          break;
        }
        case 'closeRoom': {
          const r = requireRoom(conn);
          if (r.hostId !== conn.playerId) throw new GameError('Only the host can close a room', 'not_host');
          deleteRoom(r.id);
          await kickRoomConnections(r.id);
          await broadcastServerLobby();
          break;
        }
        case 'deleteRoom': {
          // Sent from the server lobby, where the connection holds no seat —
          // the client passes its persistent playerId to prove creatorship.
          const r = getRoom(msg.roomId);
          if (!r) throw new GameError('Room not found', 'no_room');
          const isCreator = !!msg.playerId && r.creatorId === msg.playerId;
          if (!isCreator && !isRoomIdle(r)) {
            throw new GameError('Only the creator can delete a room with players in it', 'not_creator');
          }
          deleteRoom(r.id);
          await kickRoomConnections(r.id);
          await broadcastServerLobby();
          break;
        }
        case 'configure': {
          const room = requireSeat(conn);
          configureRoom(room, conn.playerId, msg.options || {});
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'start': {
          const room = requireSeat(conn);
          await startGame(room, conn.playerId, { seed: msg.seed });
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'action': {
          const room = requireSeat(conn);
          await applyAction(room, conn.playerId, msg.action);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'abandon': {
          const room = requireSeat(conn);
          await voteAbandon(room, conn.playerId);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'undo': {
          const room = requireSeat(conn);
          await undoLast(room, conn.playerId);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'returnToLobby': {
          const room = requireSeat(conn);
          returnToLobby(room, conn.playerId);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'exportDeck': {
          const room = requireSeat(conn);
          if (room.phase !== 'playing' || room.state?.status !== 'finished') {
            throw new GameError('No finished game to export', 'no_finished_game');
          }
          const data = exportDeckOrder(room.state);
          const slug = data.date.replace(/[T:]/g, '-');
          const filename = `hanabi-deck-${slug}-${room.state.variantId}.json`;
          send(ws, { type: 'deckExport', data, filename });
          break;
        }
        case 'importDeck': {
          const room = requireSeat(conn);
          importDeck(room, conn.playerId, msg.deck);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'clearImportedDeck': {
          const room = requireSeat(conn);
          clearImportedDeck(room, conn.playerId);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'movePlayer': {
          const room = requireSeat(conn);
          movePlayer(room, conn.playerId, msg.targetId, msg.direction);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'rename': {
          const room = requireSeat(conn);
          await renamePlayer(room, conn.playerId, msg.name);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        default:
          sendError(ws, `Unknown message type: ${msg.type}`, 'unknown_type');
      }
    } catch (err) {
      if (err instanceof GameError) {
        sendError(ws, err.message, err.code);
      } else {
        console.error(err);
        sendError(ws, 'Server error', 'internal');
      }
    }
  });

  ws.on('close', async () => {
    const { roomId, playerId } = conn;
    if (roomId && playerId) {
      const room = getRoom(roomId);
      if (room) leaveRoom(room, playerId);
    }
    connections.delete(ws);
    if (roomId) broadcastRoom(roomId);
    try { await broadcastServerLobby(); } catch (err) { console.error(err); }
  });
});

// No top-level await here: some hosts (e.g. Phusion Passenger) load this
// ESM file via require(), which Node refuses for a module with top-level
// await. Keeping the await inside main() avoids that restriction.
async function main() {
  await maybeResumeAtBoot();

  server.listen(PORT, HOST, () => {
    console.log(`hanabi-room listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
