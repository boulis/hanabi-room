import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { VARIANTS } from './variants.js';
import { GameError } from './rules.js';
import {
  applyAction,
  configureRoom,
  createRoom,
  joinRoom,
  leaveRoom,
  startGame,
  undoLast,
  viewFor,
  voteAbandon,
} from './room.js';

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
  '.json': 'application/json',
};

const room = createRoom();
const connections = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
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

const wss = new WebSocketServer({ server });

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
          startGame(room, conn.playerId, { seed: msg.seed });
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
          voteAbandon(room, conn.playerId);
          broadcastSync();
          break;
        }
        case 'undo': {
          if (!conn.playerId) throw new GameError('Not joined', 'not_joined');
          undoLast(room, conn.playerId);
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

server.listen(PORT, HOST, () => {
  console.log(`hanabi-room listening on http://${HOST}:${PORT}`);
});
