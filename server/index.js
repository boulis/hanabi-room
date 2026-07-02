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
  createRoom,
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

let room = createRoom();
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

async function maybeResumeRoom() {
  if (process.env.HANABI_NO_RESUME_PROMPT === '1') return null;
  const incomplete = await listIncompleteSaves();
  if (incomplete.length === 0) return null;
  if (!process.stdin.isTTY) {
    console.log(
      `(${incomplete.length} incomplete save(s) in saved-games/; skipping resume prompt — no TTY)`,
    );
    return null;
  }
  const top = incomplete.slice(0, 3);
  console.log('\nIncomplete saved games found:');
  for (let i = 0; i < top.length; i++) {
    const s = top[i];
    const variant = s.variantId.padEnd(22);
    console.log(`  [${i + 1}] ${s.basename}  ${variant}  ${s.moves} moves  (${s.playerNames.join(', ')})`);
  }
  const ans = (await prompt('Resume which? [1-3, filename, or Enter to skip]: ')).trim();
  if (!ans) return null;
  let filePath = null;
  const n = Number(ans);
  if (Number.isInteger(n) && n >= 1 && n <= top.length) {
    filePath = top[n - 1].filePath;
  } else {
    filePath = path.isAbsolute(ans) ? ans : path.join(savedDir(), ans);
  }
  try {
    const resumed = await resumeRoom(filePath);
    console.log(`Resumed ${path.basename(filePath)} — ${resumed.players.length} players, turn ${resumed.state.turn}.`);
    return resumed;
  } catch (err) {
    console.error(`Could not resume ${filePath}: ${err.message}`);
    return null;
  }
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

function broadcastSync() {
  for (const [ws, conn] of connections) {
    if (conn.playerId) {
      send(ws, { type: 'sync', view: viewFor(room, conn.playerId) });
    } else {
      send(ws, { type: 'sync', view: viewFor(room, null) });
    }
  }
}

function sendError(ws, error, code = 'error') {
  send(ws, { type: 'error', error, code });
}

wss.on('connection', (ws) => {
  const conn = { playerId: null };
  connections.set(ws, conn);
  send(ws, {
    type: 'hello',
    variants: Object.values(VARIANTS).map((v) => ({ id: v.id, name: v.name })),
  });
  send(ws, { type: 'sync', view: viewFor(room, null) });

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
        case 'join': {
          const player = joinRoom(room, { name: msg.name, playerId: msg.playerId });
          conn.playerId = player.id;
          send(ws, { type: 'identity', playerId: player.id });
          broadcastSync();
          break;
        }
        case 'configure': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          configureRoom(room, conn.playerId, msg.options || {});
          broadcastSync();
          break;
        }
        case 'start': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          await startGame(room, conn.playerId, { seed: msg.seed });
          broadcastSync();
          break;
        }
        case 'action': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          await applyAction(room, conn.playerId, msg.action);
          broadcastSync();
          break;
        }
        case 'abandon': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          await voteAbandon(room, conn.playerId);
          broadcastSync();
          break;
        }
        case 'undo': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          await undoLast(room, conn.playerId);
          broadcastSync();
          break;
        }
        case 'returnToLobby': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          returnToLobby(room, conn.playerId);
          broadcastSync();
          break;
        }
        case 'exportDeck': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
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
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          importDeck(room, conn.playerId, msg.deck);
          broadcastSync();
          break;
        }
        case 'clearImportedDeck': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          clearImportedDeck(room, conn.playerId);
          broadcastSync();
          break;
        }
        case 'movePlayer': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          movePlayer(room, conn.playerId, msg.targetId, msg.direction);
          broadcastSync();
          break;
        }
        case 'rename': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          await renamePlayer(room, conn.playerId, msg.name);
          broadcastSync();
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

  ws.on('close', () => {
    if (conn.playerId) leaveRoom(room, conn.playerId);
    connections.delete(ws);
    broadcastSync();
  });
});

// No top-level await here: some hosts (e.g. Phusion Passenger) load this
// ESM file via require(), which Node refuses for a module with top-level
// await. Keeping the await inside main() avoids that restriction.
async function main() {
  const resumed = await maybeResumeRoom();
  if (resumed) room = resumed;

  server.listen(PORT, HOST, () => {
    console.log(`hanabi-room listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
