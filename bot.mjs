#!/usr/bin/env node
// Self-contained Hanabi bot: connects to a hanabi-room server as a normal
// WebSocket client, joins (or creates) a room, and plays by the conventions
// implemented in server/botBrain.js. It only ever sees its own filtered view —
// the same information a human player gets — so it cannot cheat.
//
// Usage:
//   node bot.mjs                          join the newest lobby room on localhost
//   node bot.mjs --room ab12cd            join a specific room
//   node bot.mjs --create --room-name X   create a room and wait for players
//   node bot.mjs --autostart 2            start the game when 2+ players are
//                                         seated (only if the bot is host)
//   node bot.mjs --server http://host:3000 --name Robo --delay 1200
import WebSocket from 'ws';
import { alarmGuards, decide, CONVENTION_SETS } from './server/botBrain.js';

// Cross-turn state for the memory-based conventions (forced-play pointer).
const brainMemory = {};

function parseArgs(argv) {
  const args = {
    server: 'http://127.0.0.1:3000',
    name: 'Robo',
    delay: 900,
    room: null,
    create: false,
    roomName: null,
    autostart: 0,
    seed: undefined,
    conventions: 'standard',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--server': args.server = next(); break;
      case '--name': args.name = next(); break;
      case '--delay': args.delay = Number(next()); break;
      case '--room': args.room = next(); break;
      case '--create': args.create = true; break;
      case '--room-name': args.roomName = next(); break;
      case '--autostart': args.autostart = Number(next()); break;
      case '--seed': args.seed = Number(next()) >>> 0; break;
      case '--conventions': args.conventions = next(); break;
      case '--help':
        console.log('Options: --server URL --name N --delay MS --room ID | --create [--room-name X] --autostart N --seed S --conventions standard');
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${a} (try --help)`);
        process.exit(1);
    }
  }
  if (!CONVENTION_SETS[args.conventions]) {
    console.error(`Unknown convention set "${args.conventions}". Available: ${Object.keys(CONVENTION_SETS).join(', ')}`);
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv);
const conventions = CONVENTION_SETS[args.conventions];
const wsUrl = args.server.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
const log = (...parts) => console.log(`[${args.name}]`, ...parts);

let ws = null;
let playerId = null;   // survives reconnects so we reclaim the same seat
let roomId = args.room;
let entered = false;
let actTimer = null;
let actedTurn = -1;    // last turn we sent an action for
let fallbackTurn = -1; // turn we already retried with a safe fallback
let startRequested = false;
let announcedGameOver = false;
let stopping = false;

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function connect() {
  log(`connecting to ${wsUrl}…`);
  ws = new WebSocket(wsUrl);
  ws.on('open', () => {
    entered = false;
    if (roomId) enterRoom();
    // Otherwise wait for the server-lobby sync to pick/create a room.
  });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handle(msg);
  });
  ws.on('close', () => {
    if (stopping) return;
    log('disconnected — retrying in 2s');
    clearTimeout(actTimer);
    setTimeout(connect, 2000);
  });
  ws.on('error', (err) => log(`socket error: ${err.message}`));
}

function enterRoom() {
  entered = true;
  send({ type: 'enterRoom', roomId, playerName: args.name, playerId });
}

function handle(msg) {
  switch (msg.type) {
    case 'identity':
      playerId = msg.playerId;
      roomId = msg.roomId || roomId;
      log(`seated in room ${roomId} as ${msg.playerId}`);
      break;
    case 'sync':
      onSync(msg.view);
      break;
    case 'error':
      onError(msg);
      break;
    default:
      break;
  }
}

let lastRejected = -1; // turn whose action the server rejected

function onError(msg) {
  log(`server error: ${msg.code} — ${msg.error}`);
  if (msg.code === 'no_room') {
    // Room vanished; drop back to the lobby and wait for the next sync.
    roomId = null;
    playerId = null;
    entered = false;
    return;
  }
  lastRejected = actedTurn;
}

function onSync(view) {
  if (view.kind === 'server-lobby') {
    if (entered) return; // enterRoom in flight
    const lobbyRoom = (view.rooms || []).find((r) => r.status === 'lobby');
    if (roomId) {
      enterRoom();
    } else if (args.create || !lobbyRoom) {
      entered = true;
      log('creating a room…');
      send({ type: 'createRoom', roomName: args.roomName || `${args.name}'s table`, playerName: args.name, playerId });
    } else {
      roomId = lobbyRoom.id;
      log(`joining room "${lobbyRoom.name}" (${lobbyRoom.id})`);
      enterRoom();
    }
    return;
  }

  // In-room views.
  if (view.status === 'lobby') {
    actedTurn = -1;
    announcedGameOver = false;
    const me = view.players.find((p) => p.id === playerId);
    if (
      args.autostart > 0 &&
      me && view.hostId === playerId &&
      view.players.length >= args.autostart &&
      !startRequested
    ) {
      startRequested = true;
      log(`autostart: ${view.players.length} players seated — starting`);
      send({ type: 'start', seed: args.seed });
    }
    return;
  }
  startRequested = false;

  if (view.status === 'finished') {
    if (!announcedGameOver) {
      announcedGameOver = true;
      log(`game over: ${view.score}/${view.maxScore} (${view.endReason || 'done'})`);
    }
    return;
  }

  if (view.status !== 'playing') return;
  announcedGameOver = false;
  if (view.viewerIndex < 0 || view.currentPlayer !== view.viewerIndex) return;
  if (view.turn === actedTurn) return; // already acted for this turn
  actedTurn = view.turn;
  clearTimeout(actTimer);
  actTimer = setTimeout(() => act(view), args.delay);
}

function act(view) {
  // Alarm convention: guard first (annotate is turn-free), and patch the
  // local view so the decision below already sees the moved chop.
  try {
    for (const cardId of alarmGuards(view, conventions)) {
      log(`alarm received — guarding card ${cardId}`);
      send({ type: 'action', action: { type: 'annotate', cardId, guarded: true }, reasoning: 'alarm received: guarding' });
      const mine = view.players[view.viewerIndex].hand.find((c) => c.id === cardId);
      if (mine) mine.annotations = { ...mine.annotations, guarded: true };
    }
  } catch (err) {
    log(`alarm check failed (${err.message}) — continuing`);
  }
  let decision;
  try {
    decision = decide(view, conventions, brainMemory);
  } catch (err) {
    log(`brain error (${err.message}) — falling back`);
    decision = fallback(view);
  }
  const { action, reason } = decision;
  log(`turn ${view.turn}: ${describe(view, action)} — ${reason}`);
  send({ type: 'action', action });
  // If the server rejects the action we receive an error message (onError
  // records the turn); retry once with the safest legal move.
  const turn = view.turn;
  setTimeout(() => {
    if (lastRejected === turn && fallbackTurn !== turn) {
      fallbackTurn = turn;
      const fb = fallback(view);
      log(`retrying turn ${turn} with safe fallback: ${describe(view, fb.action)} — ${fb.reason}`);
      send({ type: 'action', action: fb.action });
    }
  }, 1500);
}

// The safest legal move available without any cleverness.
function fallback(view) {
  if (view.hintTokens < 8) {
    return { action: { type: 'discard', cardIndex: 0 }, reason: 'fallback discard' };
  }
  const other = view.players.findIndex((p, i) => i !== view.viewerIndex && p.hand.length > 0);
  const hand = view.players[other].hand;
  return {
    action: { type: 'hint', toPlayerIndex: other, hintType: 'number', value: hand[hand.length - 1].number },
    reason: 'fallback stall hint',
  };
}

function describe(view, action) {
  if (action.type === 'play') return `play card ${action.cardIndex}`;
  if (action.type === 'discard') return `discard card ${action.cardIndex}`;
  return `hint ${view.players[action.toPlayerIndex].name}: ${action.hintType} ${action.value}`;
}

process.on('SIGINT', () => {
  stopping = true;
  log('leaving');
  send({ type: 'leaveRoom' });
  setTimeout(() => process.exit(0), 200);
});

connect();
