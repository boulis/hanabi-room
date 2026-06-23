import { createInitialState } from './game.js';
import {
  GameError,
  annotateAction,
  discardAction,
  hintAction,
  playAction,
} from './rules.js';
import { lobbyView, viewState } from './view.js';
import { writeReplay } from './replay.js';

const DEFAULT_OPTIONS = {
  variantId: 'simple',
  endRule: 'standard',
  shareAnnotations: false,
};

export function createRoom() {
  return {
    phase: 'lobby',
    options: { ...DEFAULT_OPTIONS },
    players: [],
    hostId: null,
    state: null,
    sockets: new Map(),
    replayWritten: false,
  };
}

function nextPlayerId(room) {
  let i = 1;
  const used = new Set(room.players.map((p) => p.id));
  while (used.has(`p${i}`)) i++;
  return `p${i}`;
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function playerIndex(room, playerId) {
  if (room.phase === 'lobby') return room.players.findIndex((p) => p.id === playerId);
  return room.state.players.findIndex((p) => p.id === playerId);
}

export function joinRoom(room, { name, playerId }) {
  if (playerId) {
    const existing = findPlayer(room, playerId);
    if (existing) {
      existing.name = name || existing.name;
      existing.online = true;
      return existing;
    }
  }
  if (room.phase !== 'lobby') {
    throw new GameError('Game already in progress; cannot join', 'in_progress');
  }
  if (room.players.length >= 5) throw new GameError('Room is full', 'room_full');
  const id = nextPlayerId(room);
  const player = { id, name: name || id, online: true };
  room.players.push(player);
  if (!room.hostId) room.hostId = id;
  return player;
}

export function leaveRoom(room, playerId) {
  const p = findPlayer(room, playerId);
  if (!p) return;
  if (room.phase === 'lobby') {
    room.players = room.players.filter((x) => x.id !== playerId);
    if (room.hostId === playerId) {
      room.hostId = room.players[0]?.id ?? null;
    }
  } else {
    p.online = false;
  }
}

export function configureRoom(room, playerId, partial) {
  if (room.phase !== 'lobby') throw new GameError('Game already started', 'not_lobby');
  if (room.hostId !== playerId) throw new GameError('Only the host can configure', 'not_host');
  const next = { ...room.options, ...partial };
  if (next.variantId && typeof next.variantId !== 'string') throw new GameError('bad variantId');
  if (next.endRule && !['standard', 'lax'].includes(next.endRule)) {
    throw new GameError(`Unknown endRule: ${next.endRule}`, 'bad_endRule');
  }
  if (next.shareAnnotations !== undefined && typeof next.shareAnnotations !== 'boolean') {
    throw new GameError('shareAnnotations must be boolean', 'bad_share');
  }
  room.options = next;
}

export function startGame(room, playerId, { seed } = {}) {
  const isLobby = room.phase === 'lobby';
  const isFinished = room.phase === 'playing' && room.state?.status === 'finished';
  if (!isLobby && !isFinished) throw new GameError('Game in progress', 'in_progress');
  if (room.hostId !== playerId) throw new GameError('Only the host can start', 'not_host');
  if (room.players.length < 2) throw new GameError('Need at least 2 players', 'too_few');
  room.state = createInitialState({
    variantId: room.options.variantId,
    endRule: room.options.endRule,
    shareAnnotations: room.options.shareAnnotations,
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    seed,
  });
  room.phase = 'playing';
  room.replayWritten = false;
}

async function maybeWriteReplay(room) {
  if (room.phase !== 'playing') return;
  if (room.state.status !== 'finished') return;
  if (room.replayWritten) return;
  room.replayWritten = true;
  try {
    await writeReplay(room.state);
  } catch (err) {
    console.error('Failed to write replay:', err);
  }
}

export async function applyAction(room, playerId, action) {
  if (room.phase !== 'playing') throw new GameError('No active game', 'no_game');
  const idx = playerIndex(room, playerId);
  if (idx < 0) throw new GameError('Not in this game', 'not_seated');
  switch (action.type) {
    case 'play':
      playAction(room.state, idx, action.cardIndex);
      break;
    case 'discard':
      discardAction(room.state, idx, action.cardIndex);
      break;
    case 'hint':
      hintAction(room.state, idx, action.toPlayerIndex, action.hintType, action.value);
      break;
    case 'annotate':
      annotateAction(room.state, idx, action.cardId, {
        manualColors: action.manualColors,
        manualNumbers: action.manualNumbers,
        note: action.note,
      });
      break;
    default:
      throw new GameError(`Unknown action: ${action.type}`, 'bad_action');
  }
  await maybeWriteReplay(room);
}

export function viewFor(room, playerId) {
  if (room.phase === 'lobby') {
    return lobbyView(room);
  }
  const idx = playerIndex(room, playerId);
  const v = viewState(room.state, idx);
  v.hostId = room.hostId;
  v.options = room.options;
  return v;
}
