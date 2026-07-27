import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { VARIANTS } from './variants.js';
import { deckExportPayload } from './game.js';
import { GameError } from './rules.js';
import {
  applyAction,
  clearImportedDeck,
  configureRoom,
  importDeck,
  joinRoom,
  joinSpectator,
  leaveRoom,
  leaveSpectator,
  movePlayer,
  renamePlayer,
  requestUndo,
  resumeRoom,
  returnToLobby,
  startGame,
  undoLast,
  viewFor,
  voteAbandon,
} from './room.js';
import { addRoom, allRooms, createRoom, deleteRoom, getRoom, isRoomIdle, listRooms } from './rooms.js';
import {
  MAX_TOTAL_BOTS,
  addBot,
  adoptRoomBots,
  configureBot,
  initBots,
  pokeBots,
  removeBot,
  removeRoomBots,
  totalBots,
} from './bots.js';
import {
  backfillBotScores,
  botScoreFor,
  branchSave,
  deckExportFromSave,
  deleteSave,
  gameDetail,
  listGameStats,
  listIncompleteSaves,
  listLibrary,
  loadSave,
  savedDir,
  setSaveTags,
} from './savedGame.js';
import { aggregateStats } from './stats.js';
import { viewState } from './view.js';

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

// Ephemeral reactions: validated and relayed to the room, never stored —
// they are not game state and don't appear in saves.
const REACTION_EMOJI = ['👏', '🤔', '❓', '😱', '❗'];
const REACTION_THROTTLE_MS = 500;

// How many tags the stats page offers (most-used first) — enough to cover the
// tags in real use without turning the filter into a wall of chips.
const STATS_TAG_LIMIT = 20;

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
    adoptRoomBots(r);
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
    playerBots: s.playerBots,
    moves: s.moves,
    startedAt: s.startedAt,
  }));
  return {
    kind: 'server-lobby',
    rooms: listRooms(),
    resumableSaves: saves,
    library: await listLibrary(),
  };
}

// A save file an open room is still appending to must not be deleted,
// replayed (it would reveal live hidden information), or branched.
function saveInUse(basename) {
  const filePath = path.resolve(savedDir(), basename);
  return allRooms().some((r) => r.savePath && path.resolve(r.savePath) === filePath);
}

function requireSaveBasename(file) {
  const basename = path.basename(String(file || ''));
  if (!basename.endsWith('.jsonl') || basename.startsWith('.')) {
    throw new GameError('Bad save filename', 'bad_save');
  }
  return basename;
}

// 'YYYY-MM-DD' -> local-time ms at the first (or last) instant of that day.
// Anything else (empty, malformed) means "no bound".
function parseFilterDay(day, edge) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(edge === 'end' ? `${day}T23:59:59.999` : `${day}T00:00:00`);
  return Number.isNaN(t) ? null : t;
}

function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  if (v.status === 'lobby') v.botSlotsFree = MAX_TOTAL_BOTS - totalBots();
  return v;
}

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  for (const [ws, conn] of connections) {
    if (conn.roomId !== roomId) continue;
    send(ws, { type: 'sync', view: inRoomViewFor(room, conn.playerId) });
  }
  // Every state change flows through here — let resident bots react.
  pokeBots(room);
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
      conn.isSpectator = false;
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
  // Spectators hold conn.playerId (their spectator id, for view lookups and
  // cleanup) but never a seat — this single guard keeps every action
  // handler below (play/hint/undo/react/configure/...) off-limits to them.
  if (!conn.playerId || conn.isSpectator) throw new GameError('Not joined', 'not_joined');
  return room;
}

wss.on('connection', async (ws) => {
  const conn = { playerId: null, roomId: null, isSpectator: false };
  connections.set(ws, conn);
  send(ws, {
    type: 'hello',
    variants: Object.values(VARIANTS).map((v) => ({ id: v.id, name: v.name })),
  });
  // The message listener must be attached before any await: a client that
  // sends right after connecting (reconnect, bot, script) would otherwise
  // have its message dropped while the saves directory is being scanned.
  // Handlers await `greeted` so the initial lobby sync still arrives first.
  const greeted = serverLobbyView()
    .then((view) => send(ws, { type: 'sync', view }))
    .catch((err) => console.error('initial lobby sync failed:', err));

  ws.on('message', async (raw) => {
    await greeted;
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
          conn.isSpectator = false;
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
          conn.isSpectator = false;
          send(ws, { type: 'identity', playerId: player.id, roomId: r.id, roomName: r.name });
          await broadcastRoomAndLobby(r.id);
          break;
        }
        case 'spectateRoom': {
          const r = getRoom(msg.roomId);
          if (!r) throw new GameError('Room not found', 'no_room');
          const spectator = joinSpectator(r, { name: msg.playerName });
          conn.playerId = spectator.id;
          conn.roomId = r.id;
          conn.isSpectator = true;
          send(ws, {
            type: 'identity',
            playerId: spectator.id,
            roomId: r.id,
            roomName: r.name,
            isSpectator: true,
          });
          await broadcastRoomAndLobby(r.id);
          break;
        }
        case 'leaveRoom': {
          const prevRoomId = conn.roomId;
          if (prevRoomId) {
            const r = getRoom(prevRoomId);
            if (r && conn.playerId) {
              if (conn.isSpectator) leaveSpectator(r, conn.playerId);
              else leaveRoom(r, conn.playerId);
            }
          }
          conn.roomId = null;
          conn.playerId = null;
          conn.isSpectator = false;
          send(ws, { type: 'sync', view: await serverLobbyView() });
          if (prevRoomId) broadcastRoom(prevRoomId);
          await broadcastServerLobby();
          break;
        }
        case 'resumeSave': {
          const fileArg = String(msg.file || '');
          const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(savedDir(), fileArg);
          // One room per save, like delete/replay/branch: two rooms resumed
          // from one file would both append to it, interleaving two divergent
          // games into a log that can never be replayed back apart.
          if (saveInUse(path.basename(filePath))) {
            throw new GameError('Save is already open in a room', 'save_in_use');
          }
          const resumed = await resumeRoom(filePath);
          const r = addRoom(resumed, msg.roomName);
          adoptRoomBots(r);
          send(ws, { type: 'roomCreated', roomId: r.id, roomName: r.name });
          await broadcastServerLobby();
          break;
        }
        case 'closeRoom': {
          const r = requireRoom(conn);
          if (r.hostId !== conn.playerId) throw new GameError('Only the host can close a room', 'not_host');
          deleteRoom(r.id);
          removeRoomBots(r.id);
          await kickRoomConnections(r.id);
          await broadcastServerLobby();
          break;
        }
        case 'addBot': {
          const room = requireSeat(conn);
          addBot(room);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'removeBot': {
          const room = requireSeat(conn);
          removeBot(room, msg.playerId);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'configureBot': {
          const room = requireSeat(conn);
          configureBot(room, msg.playerId, msg.options || {});
          await broadcastRoomAndLobby(room.id);
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
          removeRoomBots(r.id);
          await kickRoomConnections(r.id);
          await broadcastServerLobby();
          break;
        }
        case 'deleteSave': {
          // Anyone on the tailnet may delete a saved game: saves carry no
          // durable owner identity, and the move-to-trash keeps it reversible
          // by the host. Refuse while an open room is appending to the file —
          // appendFile would silently recreate a headerless save.
          const basename = requireSaveBasename(msg.file);
          if (saveInUse(basename)) {
            throw new GameError('Save is in use by an open room', 'save_in_use');
          }
          try {
            await deleteSave(basename);
          } catch (err) {
            if (err.code === 'ENOENT') throw new GameError('Save not found', 'no_save');
            throw err;
          }
          await broadcastServerLobby();
          break;
        }
        case 'replaySave': {
          // Stateless step-through of a saved game: rebuild the state after
          // the first `upto` events and return an omniscient view (viewer -1
          // sees every hand — it's a review, not a live game).
          const basename = requireSaveBasename(msg.file);
          if (saveInUse(basename)) {
            throw new GameError('Game is still being played in a room', 'save_in_use');
          }
          const upto = Math.max(0, Math.floor(Number(msg.upto) || 0));
          let loaded;
          try {
            loaded = await loadSave(path.join(savedDir(), basename), { maxEvents: upto });
          } catch (err) {
            throw new GameError(`Cannot replay ${basename}: ${err.message}`, 'bad_save');
          }
          const v = viewState(loaded.state, -1);
          v.kind = 'replay';
          // Same banner as a live game-over, so it gets the same par line.
          v.botScore = loaded.state.status === 'finished' ? await botScoreFor(basename) : null;
          // Freeze the clock at the replayed position: elapsed time is the gap
          // between the original start and the last applied event, not "now"
          // (which would count every day since the game was played).
          v.endedAt = loaded.lastAppliedAt ?? v.startedAt;
          send(ws, {
            type: 'replayView',
            file: basename,
            upto: Math.min(upto, loaded.totalEvents),
            total: loaded.totalEvents,
            view: v,
          });
          break;
        }
        case 'branchSave': {
          // "Start again after move N": copy header + first N events into a
          // fresh save, then open it in a new room via the resume path. The
          // original save is untouched; the branch persists on its own.
          const basename = requireSaveBasename(msg.file);
          if (saveInUse(basename)) {
            throw new GameError('Game is still being played in a room', 'save_in_use');
          }
          const upto = Math.max(0, Math.floor(Number(msg.upto) || 0));
          let branched;
          try {
            branched = await branchSave(basename, upto);
            const resumed = await resumeRoom(branched);
            const r = addRoom(resumed, msg.roomName || `Branch of ${basename}`);
            adoptRoomBots(r);
            send(ws, { type: 'roomCreated', roomId: r.id, roomName: r.name });
          } catch (err) {
            // Don't leave a junk branch file behind (e.g. branching past the
            // game's end resumes to 'finished' and is rejected).
            if (branched) await fs.rm(branched, { force: true });
            throw new GameError(`Cannot branch ${basename}: ${err.message}`, 'bad_branch');
          }
          await broadcastServerLobby();
          break;
        }
        case 'statsSummary': {
          // Aggregate per-player stats over the saves matching the filter.
          // Requested explicitly (not part of the lobby broadcast) because it
          // means reading every save, and only the stats page wants it.
          const games = await listGameStats();
          const namesOf = (g) => g.stats.players.map((p) => p.name);
          const playerCounts = [...new Set(games.map((g) => g.playerCount))].sort((a, b) => a - b);
          const variantIds = [...new Set(games.map((g) => g.variantId))].sort();
          const playerNames = [...new Set(games.flatMap(namesOf))].sort((a, b) => a.localeCompare(b));
          const startTimes = games.map((g) => Date.parse(g.startedAt)).filter((t) => !Number.isNaN(t));
          // Tags, most-used first — the page only offers the top handful.
          const tagCounts = new Map();
          for (const g of games) {
            for (const t of g.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
          }
          const tags = [...tagCounts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
            .slice(0, STATS_TAG_LIMIT);
          const wantPlayers = Number(msg.players) || null;
          const wantVariant = typeof msg.variantId === 'string' && msg.variantId ? msg.variantId : null;
          // Named players must ALL be in the game; combined with a player count
          // that pins an exact table ("3-player games with Ann, Bob and Cid").
          const wantNames = Array.isArray(msg.withPlayers)
            ? msg.withPlayers.filter((n) => typeof n === 'string' && n).slice(0, 8)
            : [];
          // Dates come from <input type="date"> as YYYY-MM-DD and are read in
          // the host's local time (that's the day the players remember),
          // inclusive at both ends.
          const from = parseFilterDay(msg.from, 'start');
          const to = parseFilterDay(msg.to, 'end');
          // Tag filter: untagged games only, or games carrying ANY of the
          // named tags (tags are categories — a game rarely has two of them,
          // so requiring all would mostly match nothing). Neither = any tag.
          const untaggedOnly = msg.untaggedOnly === true;
          const wantTags = !untaggedOnly && Array.isArray(msg.tags)
            ? msg.tags.filter((t) => typeof t === 'string' && t).slice(0, STATS_TAG_LIMIT)
            : [];
          const matching = games.filter((g) => {
            if (wantPlayers && g.playerCount !== wantPlayers) return false;
            if (wantVariant && g.variantId !== wantVariant) return false;
            const startedAt = Date.parse(g.startedAt);
            if (from != null && !(startedAt >= from)) return false;
            if (to != null && !(startedAt <= to)) return false;
            if (untaggedOnly && g.tags.length) return false;
            if (wantTags.length && !wantTags.some((t) => g.tags.includes(t))) return false;
            if (wantNames.length) {
              const names = new Set(namesOf(g));
              if (!wantNames.every((n) => names.has(n))) return false;
            }
            return true;
          });
          send(ws, {
            type: 'statsView',
            filter: {
              players: wantPlayers,
              variantId: wantVariant,
              withPlayers: wantNames,
              from: from != null ? msg.from : null,
              to: to != null ? msg.to : null,
              tags: wantTags,
              untaggedOnly,
            },
            available: {
              playerCounts,
              variantIds,
              playerNames,
              tags,
              // Bounds for the date inputs, so they can't be set outside the
              // range any save covers.
              firstDay: startTimes.length ? localDay(Math.min(...startTimes)) : null,
              lastDay: startTimes.length ? localDay(Math.max(...startTimes)) : null,
            },
            gamesMatched: matching.length,
            gamesTotal: games.length,
            summary: aggregateStats(matching.map((g) => g.stats)),
          });
          break;
        }
        case 'gameDetail': {
          // Everything about one saved game: the library row, its per-player
          // stats table, the bot par for its deck, and the other games dealt
          // from the same deck. Asked for when a library row is opened, so it
          // stays out of the lobby broadcast.
          const basename = requireSaveBasename(msg.file);
          let detail;
          try {
            detail = await gameDetail(basename);
          } catch (err) {
            throw new GameError(`Cannot read ${basename}: ${err.message}`, 'bad_save');
          }
          if (!detail) throw new GameError('Save not found or unreadable', 'no_save');
          send(ws, { type: 'gameDetailView', detail });
          break;
        }
        case 'tagSave': {
          const basename = requireSaveBasename(msg.file);
          try {
            await setSaveTags(basename, msg.tags);
          } catch (err) {
            throw new GameError(err.message, 'bad_tags');
          }
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
          await applyAction(room, conn.playerId, msg.action,
            typeof msg.reasoning === 'string' ? msg.reasoning : undefined);
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
        case 'requestUndo': {
          const room = requireSeat(conn);
          requestUndo(room, conn.playerId);
          broadcastRoom(room.id);
          break;
        }
        case 'returnToLobby': {
          const room = requireSeat(conn);
          returnToLobby(room, conn.playerId);
          await broadcastRoomAndLobby(room.id);
          break;
        }
        case 'exportDeck': {
          // With a file: the export button on a replay's game-over banner. The
          // replaying connection holds no seat (it isn't in a room at all), so
          // the seat-scoped path below can never serve it.
          if (msg.file) {
            const basename = requireSaveBasename(msg.file);
            const payload = await deckExportFromSave(path.join(savedDir(), basename));
            if (!payload) throw new GameError('No finished game to export', 'no_finished_game');
            send(ws, { type: 'deckExport', ...payload });
            break;
          }
          const room = requireSeat(conn);
          if (room.phase !== 'playing' || room.state?.status !== 'finished') {
            throw new GameError('No finished game to export', 'no_finished_game');
          }
          send(ws, { type: 'deckExport', ...deckExportPayload(room.state) });
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
        case 'react': {
          const room = requireSeat(conn);
          if (room.phase !== 'playing') {
            throw new GameError('Reactions need a game on screen', 'not_playing');
          }
          if (!REACTION_EMOJI.includes(msg.emoji)) {
            throw new GameError('Unknown reaction', 'bad_reaction');
          }
          const idx = room.state.players.findIndex((p) => p.id === conn.playerId);
          if (idx < 0) throw new GameError('Not in this game', 'not_seated');
          const now = Date.now();
          if (now - (conn.lastReactionAt || 0) < REACTION_THROTTLE_MS) break; // drop spam silently
          conn.lastReactionAt = now;
          for (const [otherWs, otherConn] of connections) {
            if (otherConn.roomId === room.id) {
              send(otherWs, { type: 'reaction', playerIndex: idx, emoji: msg.emoji });
            }
          }
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
    const { roomId, playerId, isSpectator } = conn;
    if (roomId && playerId) {
      const room = getRoom(roomId);
      if (room) {
        if (isSpectator) leaveSpectator(room, playerId);
        else leaveRoom(room, playerId);
      }
    }
    connections.delete(ws);
    if (roomId) broadcastRoom(roomId);
    try { await broadcastServerLobby(); } catch (err) { console.error(err); }
  });
});

// No top-level await here: some hosts (e.g. Phusion Passenger) load this
// ESM file via require(), which Node refuses for a module with top-level
// await. Keeping the await inside main() avoids that restriction.
// Give every save a bot par, in the background: a game is ~25ms to simulate,
// but a library of hundreds shouldn't hold up the port. Runs after the server
// is listening and re-broadcasts the lobby once, so the library picks up the
// numbers without a reload. Nothing here is fatal — a par that fails to
// compute is simply not shown.
function fillBotScoresInBackground() {
  setTimeout(() => {
    backfillBotScores()
      .then(async ({ computed, total }) => {
        if (!computed) return;
        console.log(`Bot par computed for ${computed} of ${total} saved games.`);
        await broadcastServerLobby();
      })
      .catch((err) => console.error('Bot par backfill failed:', err));
  }, 100).unref?.();
}

async function main() {
  initBots(async (roomId) => broadcastRoomAndLobby(roomId));
  await maybeResumeAtBoot();

  server.listen(PORT, HOST, () => {
    console.log(`hanabi-room listening on http://${HOST}:${PORT}`);
    fillBotScoresInBackground();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
