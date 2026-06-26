import { randomUUID } from 'node:crypto';
import { createInitialState, validateDeckAgainstVariant } from './game.js';
import {
  GameError,
  annotateAction,
  discardAction,
  hintAction,
  playAction,
} from './rules.js';
import { lobbyView, viewState } from './view.js';
import {
  appendEvent,
  loadSave,
  openSave,
} from './savedGame.js';

const DEFAULT_OPTIONS = {
  variantId: 'simple',
  endRule: 'lax',
  shareGuarded: false,
  allowEmptyHints: false,
};

const ABANDON_THRESHOLD = 2;

export function createRoom() {
  return {
    phase: 'lobby',
    options: { ...DEFAULT_OPTIONS },
    players: [],
    hostId: null,
    state: null,
    sockets: new Map(),
    abandonVotes: new Set(),
    undoStack: [],
    savePath: null,
    importedDeck: null,
  };
}

const UNDOABLE_ACTIONS = new Set(['play', 'discard', 'hint']);

function newPlayerId() {
  return randomUUID().slice(0, 8);
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function playerIndex(room, playerId) {
  if (room.phase === 'lobby') return room.players.findIndex((p) => p.id === playerId);
  return room.state.players.findIndex((p) => p.id === playerId);
}

async function safeAppend(room, event) {
  if (!room.savePath) return;
  try {
    await appendEvent(room.savePath, event);
  } catch (err) {
    console.error('Failed to append save event:', err);
  }
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
  const normName = name ? name.trim().toLowerCase() : '';
  if (normName) {
    const offlineMatch = room.players.find(
      (p) => !p.online && p.name.trim().toLowerCase() === normName,
    );
    if (offlineMatch) {
      offlineMatch.name = name;
      offlineMatch.online = true;
      return offlineMatch;
    }
  }
  if (room.phase !== 'lobby') {
    throw new GameError('Game already in progress; cannot join', 'in_progress');
  }
  if (room.players.length >= 5) throw new GameError('Room is full', 'room_full');
  const id = newPlayerId();
  const player = { id, name: name || id, online: true };
  room.players.push(player);
  if (!room.hostId) room.hostId = id;
  return player;
}

export async function renamePlayer(room, playerId, newName) {
  const p = findPlayer(room, playerId);
  if (!p) throw new GameError('Not in this room', 'not_seated');
  const trimmed = typeof newName === 'string' ? newName.trim() : '';
  if (!trimmed) throw new GameError('Name cannot be empty', 'bad_name');
  const truncated = trimmed.slice(0, 24);
  p.name = truncated;
  if (room.state) {
    const inGame = room.state.players.find((sp) => sp.id === playerId);
    if (inGame) inGame.name = truncated;
    await safeAppend(room, { kind: 'rename', playerId, name: truncated });
  }
  return p;
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

export function movePlayer(room, hostId, targetId, direction) {
  if (room.phase !== 'lobby') {
    throw new GameError('Players can only be reordered in the lobby', 'not_lobby');
  }
  if (room.hostId !== hostId) {
    throw new GameError('Only the host can reorder players', 'not_host');
  }
  const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : null;
  if (delta === null) throw new GameError('direction must be up or down', 'bad_direction');
  const idx = room.players.findIndex((p) => p.id === targetId);
  if (idx < 0) throw new GameError('Unknown player', 'no_player');
  const j = idx + delta;
  if (j < 0 || j >= room.players.length) return; // at edge — no-op
  [room.players[idx], room.players[j]] = [room.players[j], room.players[idx]];
}

export function importDeck(room, playerId, deck) {
  if (room.phase !== 'lobby') {
    throw new GameError('Deck can only be imported in the lobby', 'not_lobby');
  }
  if (room.hostId !== playerId) {
    throw new GameError('Only the host can import a deck', 'not_host');
  }
  try {
    validateDeckAgainstVariant(room.options.variantId, deck);
  } catch (err) {
    throw new GameError(err.message, 'bad_deck');
  }
  room.importedDeck = deck.slice();
}

export function clearImportedDeck(room, playerId) {
  if (room.hostId !== playerId) {
    throw new GameError('Only the host can clear the imported deck', 'not_host');
  }
  room.importedDeck = null;
}

export function configureRoom(room, playerId, partial) {
  if (room.phase !== 'lobby') throw new GameError('Game already started', 'not_lobby');
  if (room.hostId !== playerId) throw new GameError('Only the host can configure', 'not_host');
  const next = { ...room.options, ...partial };
  if (next.variantId && typeof next.variantId !== 'string') throw new GameError('bad variantId');
  if (next.endRule && !['standard', 'lax'].includes(next.endRule)) {
    throw new GameError(`Unknown endRule: ${next.endRule}`, 'bad_endRule');
  }
  if (next.shareGuarded !== undefined && typeof next.shareGuarded !== 'boolean') {
    throw new GameError('shareGuarded must be boolean', 'bad_share');
  }
  if (next.allowEmptyHints !== undefined && typeof next.allowEmptyHints !== 'boolean') {
    throw new GameError('allowEmptyHints must be boolean', 'bad_empty_hints');
  }
  room.options = next;
}

export async function startGame(room, playerId, { seed } = {}) {
  const isLobby = room.phase === 'lobby';
  const isFinished = room.phase === 'playing' && room.state?.status === 'finished';
  if (!isLobby && !isFinished) throw new GameError('Game in progress', 'in_progress');
  if (room.hostId !== playerId) throw new GameError('Only the host can start', 'not_host');
  if (room.players.length < 2) throw new GameError('Need at least 2 players', 'too_few');
  // If a deck was imported, it must still match the (possibly changed) variant.
  let deckCards;
  if (room.importedDeck) {
    try {
      validateDeckAgainstVariant(room.options.variantId, room.importedDeck);
    } catch (err) {
      throw new GameError(
        `Imported deck doesn't fit variant ${room.options.variantId}: ${err.message}`,
        'bad_deck',
      );
    }
    deckCards = room.importedDeck;
  }
  room.state = createInitialState({
    variantId: room.options.variantId,
    endRule: room.options.endRule,
    shareGuarded: room.options.shareGuarded,
    allowEmptyHints: room.options.allowEmptyHints,
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    seed,
    deckCards,
  });
  room.phase = 'playing';
  room.abandonVotes.clear();
  room.undoStack = [];
  room.savePath = null;
  // Imported deck is one-shot — clear after the game starts using it.
  room.importedDeck = null;
  try {
    room.savePath = await openSave(room.state, room.hostId);
  } catch (err) {
    console.error('Failed to open save file:', err);
  }
}

export function returnToLobby(room, playerId) {
  if (room.phase !== 'playing' || room.state?.status !== 'finished') {
    throw new GameError('Game is not finished', 'not_finished');
  }
  if (room.hostId !== playerId) {
    throw new GameError('Only the host can return to lobby', 'not_host');
  }
  room.phase = 'lobby';
  room.state = null;
  room.undoStack = [];
  room.savePath = null;
  room.abandonVotes.clear();
}

export async function voteAbandon(room, playerId) {
  if (room.phase !== 'playing') throw new GameError('No active game', 'no_game');
  if (room.state.status !== 'playing') throw new GameError('Game is not in progress', 'not_playing');
  if (!findPlayer(room, playerId)) throw new GameError('Not in this game', 'not_seated');
  await safeAppend(room, { kind: 'abandon-vote', playerId });
  if (room.abandonVotes.has(playerId)) {
    room.abandonVotes.delete(playerId);
    return { abandoned: false };
  }
  room.abandonVotes.add(playerId);
  if (room.abandonVotes.size >= ABANDON_THRESHOLD) {
    // Mark the game as finished so the game-over screen takes over (with the
    // export-deck button, score, etc.). Same exit path as a natural end.
    room.state.status = 'finished';
    room.state.endReason = 'abandoned';
    room.state.endedAt = Date.now();
    room.abandonVotes.clear();
    room.undoStack = [];
    await safeAppend(room, { kind: 'end', endReason: 'abandoned' });
    return { abandoned: true };
  }
  return { abandoned: false };
}

export async function applyAction(room, playerId, action) {
  if (room.phase !== 'playing') throw new GameError('No active game', 'no_game');
  const idx = playerIndex(room, playerId);
  if (idx < 0) throw new GameError('Not in this game', 'not_seated');

  let snapshotPushed = false;
  if (UNDOABLE_ACTIONS.has(action.type)) {
    room.undoStack.push({ playerId, snapshot: structuredClone(room.state) });
    snapshotPushed = true;
  }
  try {
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
          guarded: action.guarded,
          note: action.note,
        });
        break;
      default:
        throw new GameError(`Unknown action: ${action.type}`, 'bad_action');
    }
  } catch (err) {
    if (snapshotPushed) room.undoStack.pop();
    throw err;
  }
  await safeAppend(room, { kind: 'action', playerId, action });
  if (room.state.status === 'finished') {
    // Keep savePath set: an undo + continuation after game-over should still
    // be persisted. The 'end' line is metadata; further events appended after
    // it supersede it on replay.
    await safeAppend(room, { kind: 'end', endReason: room.state.endReason });
  }
}

export async function undoLast(room, playerId) {
  if (room.phase !== 'playing') throw new GameError('No active game', 'no_game');
  const top = room.undoStack[room.undoStack.length - 1];
  if (!top) throw new GameError('Nothing to undo', 'nothing_to_undo');
  if (top.playerId !== playerId) {
    throw new GameError('Only the player who took the most recent action can undo it', 'not_your_undo');
  }
  room.undoStack.pop();
  room.state = top.snapshot;
  await safeAppend(room, { kind: 'undo', playerId });
}

export function viewFor(room, playerId) {
  if (room.phase === 'lobby') {
    return lobbyView(room);
  }
  const idx = playerIndex(room, playerId);
  const v = viewState(room.state, idx);
  v.hostId = room.hostId;
  v.options = room.options;
  v.abandonVotes = {
    count: room.abandonVotes.size,
    threshold: ABANDON_THRESHOLD,
    me: playerId ? room.abandonVotes.has(playerId) : false,
  };
  const topUndo = room.undoStack[room.undoStack.length - 1];
  v.canUndo = !!(topUndo && topUndo.playerId === playerId);
  return v;
}

export async function resumeRoom(filePath) {
  const { header, state, undoStack, abandonVotes } = await loadSave(filePath);
  if (state.status !== 'playing') {
    throw new Error(
      `Cannot resume ${filePath}: game already ended (${state.endReason || 'unknown'})`,
    );
  }
  const room = createRoom();
  room.phase = 'playing';
  room.options = {
    variantId: header.variantId,
    endRule: header.endRule,
    shareGuarded: header.shareGuarded,
    allowEmptyHints: header.allowEmptyHints,
  };
  room.players = state.players.map((p) => ({ id: p.id, name: p.name, online: false }));
  room.hostId = header.hostId;
  room.state = state;
  room.undoStack = undoStack;
  room.abandonVotes = abandonVotes;
  room.savePath = filePath;
  return room;
}
