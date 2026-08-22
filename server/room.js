import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInitialState, validateDeckAgainstVariant } from './game.js';
import {
  GameError,
  annotateAction,
  discardAction,
  hintAction,
  playAction,
  undoneLogEntries,
} from './rules.js';
import { lobbyView, viewState } from './view.js';
import { botScoreForState } from './botScore.js';
import { BOT_VERSION } from './botBrain.js';
import {
  appendEvent,
  loadSave,
  openSave,
  setBotScore,
} from './savedGame.js';

const DEFAULT_OPTIONS = {
  variantId: 'simple',
  endRule: 'lax',
  shareGuarded: false,
  allowEmptyHints: false,
  allowSpectators: false,
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
    undoRequests: new Set(),
    savePath: null,
    importedDeck: null,
    // What a table of bots scores on this game's deck; filled in once the game
    // ends (see recordBotScore).
    botScore: null,
    // How long resident bots pause before moving: null = auto (see
    // autoBotDelay), a number of ms, or 'manual'. Not part of options — it's a
    // watching comfort, not a game rule, so it isn't host-gated, isn't
    // lobby-only, and never reaches a save.
    botPaceMs: null,
    // Spectators get an omniscient, read-only view — never part of
    // state.players, so game logic (rules.js) never has to know about them.
    spectators: new Map(),
  };
}

const UNDOABLE_ACTIONS = new Set(['play', 'discard', 'hint']);

function newPlayerId() {
  return randomUUID().slice(0, 8);
}

function newSpectatorId() {
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

// Par for the deck this game was dealt from — "what would the bots have
// scored with these cards?" — computed once, when the game ends, and kept on
// the room so the game-over view can carry it without re-simulating on every
// broadcast. Also written to the saves' sidecar, so the library shows the same
// number without recomputing it. A bot game is ~25ms and the result depends
// only on the deck, which never changes; failure is never fatal (a missing par
// just isn't displayed).
async function recordBotScore(room) {
  try {
    room.botScore = botScoreForState(room.state);
  } catch (err) {
    console.error('Bot par simulation failed:', err.message);
    return;
  }
  if (!room.savePath) return;
  try {
    await setBotScore(path.basename(room.savePath), {
      ...room.botScore,
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to store bot par:', err.message);
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

// Spectators may join in any phase (lobby or playing) — watching the lobby
// fill up has no hidden information to protect, and once the game starts
// they get an omniscient view via viewFor (playerIndex resolves to -1 for a
// spectator id, which is exactly the "reveal everything" viewer index).
export function joinSpectator(room, { name }) {
  if (!room.options.allowSpectators) {
    throw new GameError('Spectating is not allowed in this room', 'spectators_disabled');
  }
  const id = newSpectatorId();
  const spectator = { id, name: name || id };
  room.spectators.set(id, spectator);
  return spectator;
}

export function leaveSpectator(room, spectatorId) {
  room.spectators.delete(spectatorId);
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
      // Prefer a human host — a bot host could neither configure nor start.
      room.hostId = (room.players.find((x) => !x.isBot) ?? room.players[0])?.id ?? null;
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
  if (next.allowSpectators !== undefined && typeof next.allowSpectators !== 'boolean') {
    throw new GameError('allowSpectators must be boolean', 'bad_allow_spectators');
  }
  room.options = next;
}

// --- Bot pacing ---
// A lone bot at ~1.2s reads fine: a human moves between every one of its
// turns, so there is always a pause to read the table in. Two or more bots
// play back-to-back, and at that speed the moves blur into one another before
// a watching human can follow what happened — hence a slower default as soon
// as a second bot is seated.
export const BOT_PACE_SOLO_MS = 1200;
export const BOT_PACE_CROWD_MS = 4000;
export const BOT_PACE_MAX_MS = 60000;

export function autoBotDelay(room) {
  const bots = room.players.filter((p) => p.isBot).length;
  return bots >= 2 ? BOT_PACE_CROWD_MS : BOT_PACE_SOLO_MS;
}

// The effective pause before a bot's move, or null for 'manual' (the bot holds
// its turn until someone presses Play now). An explicit room pace outranks
// HANABI_BOT_DELAY_MS, which is only the default for 'auto': that ordering is
// what lets the test suite drive the whole bot loop at 10ms while a test that
// cares about pacing still gets the pace it asked for.
export function botDelayFor(room) {
  const pace = room?.botPaceMs;
  if (pace === 'manual') return null;
  if (typeof pace === 'number') return pace;
  const env = process.env.HANABI_BOT_DELAY_MS;
  if (env !== undefined && env !== '' && Number.isFinite(Number(env))) return Number(env);
  return autoBotDelay(room);
}

// Any seated player, in either phase: pacing is about keeping up with the
// table, so whoever can't keep up is exactly who should be able to change it.
export function setBotPace(room, pace) {
  if (pace === null || pace === 'auto') {
    room.botPaceMs = null;
    return;
  }
  if (pace === 'manual') {
    room.botPaceMs = 'manual';
    return;
  }
  const ms = Number(pace);
  if (!Number.isFinite(ms) || ms < 0 || ms > BOT_PACE_MAX_MS) {
    throw new GameError('Bot pace must be auto, manual, or 0–60000 ms', 'bad_bot_pace');
  }
  room.botPaceMs = Math.round(ms);
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
  room.undoRequests.clear();
  room.savePath = null;
  room.botScore = null;
  // Imported deck is one-shot — clear after the game starts using it.
  room.importedDeck = null;
  try {
    const botIds = new Set(room.players.filter((p) => p.isBot).map((p) => p.id));
    room.savePath = await openSave(room.state, room.hostId, botIds);
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
  room.undoRequests.clear();
  room.savePath = null;
  room.botScore = null;
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
    await safeAppend(room, {
      kind: 'end',
      endReason: 'abandoned',
      t: new Date(room.state.endedAt).toISOString(), // when it ended, not when it was written
    });
    await recordBotScore(room);
    return { abandoned: true };
  }
  return { abandoned: false };
}

// `reasoning` is optional free text explaining WHY the player (bot or,
// later, human) took this action. It's recorded in the save file alongside
// the action and stamped on the action's log entry — but the live view only
// reveals it on finished games and to the omniscient replay viewer, because
// it can reference cards the players aren't allowed to see ("save rainbow 2
// on chop").
export async function applyAction(room, playerId, action, reasoning) {
  if (room.phase !== 'playing') throw new GameError('No active game', 'no_game');
  const idx = playerIndex(room, playerId);
  if (idx < 0) throw new GameError('Not in this game', 'not_seated');
  const why = typeof reasoning === 'string' ? reasoning.trim().slice(0, 200) : '';

  let snapshotPushed = false;
  if (UNDOABLE_ACTIONS.has(action.type)) {
    room.undoStack.push({ playerId, snapshot: structuredClone(room.state) });
    snapshotPushed = true;
  }
  const logLenBefore = room.state.log.length;
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
  // A new action changes who can undo, so pending requests are stale.
  if (action.type !== 'annotate') room.undoRequests.clear();
  if (why && room.state.log.length > logLenBefore) {
    room.state.log[logLenBefore].reasoning = why;
  }
  const event = { kind: 'action', playerId, action };
  if (why) event.reasoning = why;
  // Timestamp the event with when the move was made, not when the write got
  // around to starting. Replay stamps the reconstructed log from this, so any
  // gap between the two clock reads is a resumed log that differs from the
  // live one it replays — which is exactly what it used to be.
  const movedAt = room.state.log[logLenBefore]?.at;
  if (movedAt != null) event.t = new Date(movedAt).toISOString();
  await safeAppend(room, event);
  if (room.state.status === 'finished') {
    // Keep savePath set: an undo + continuation after game-over should still
    // be persisted. The 'end' line is metadata; further events appended after
    // it supersede it on replay.
    await safeAppend(room, {
      kind: 'end',
      endReason: room.state.endReason,
      // Same reasoning: replay restores endedAt from this line.
      ...(room.state.endedAt != null ? { t: new Date(room.state.endedAt).toISOString() } : {}),
    });
    await recordBotScore(room);
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
  // Keep the undone action visible: its log entries (everything past the
  // snapshot's log) come back flagged so clients can strike them out.
  const struck = undoneLogEntries(room.state.log, top.snapshot.log);
  // The snapshot's nextLogSeq is the pre-action value — restoring it wholesale
  // would let the replacement action's pushLog calls reuse seqs already used
  // by the struck entries above. Keep it monotonic across the whole game.
  const nextLogSeq = Math.max(room.state.nextLogSeq, top.snapshot.nextLogSeq);
  room.state = top.snapshot;
  room.state.nextLogSeq = nextLogSeq;
  room.state.log.push(...struck);
  room.undoRequests.clear();
  await safeAppend(room, { kind: 'undo', playerId });
}

export function requestUndo(room, playerId) {
  if (room.phase !== 'playing') throw new GameError('No active game', 'no_game');
  if (room.state.status !== 'playing') throw new GameError('Game is not in progress', 'not_playing');
  if (!findPlayer(room, playerId)) throw new GameError('Not in this game', 'not_seated');
  const top = room.undoStack[room.undoStack.length - 1];
  if (!top) throw new GameError('Nothing to undo', 'nothing_to_undo');
  if (top.playerId === playerId) {
    throw new GameError('You can undo yourself — no need to request', 'own_undo');
  }
  // Toggle, so a request can be retracted with a second click.
  if (room.undoRequests.has(playerId)) room.undoRequests.delete(playerId);
  else room.undoRequests.add(playerId);
}

function spectatorList(room) {
  return [...room.spectators.values()].map((s) => ({ id: s.id, name: s.name }));
}

// The pace control needs both halves: the raw setting (so the picker can show
// "auto" as auto rather than as whatever it currently resolves to) and what
// that setting actually comes to right now.
function attachBotPace(room, v) {
  v.botPaceMs = room.botPaceMs ?? null;
  v.botDelayMs = botDelayFor(room);
  v.hasBots = room.players.some((p) => p.isBot);
}

export function viewFor(room, playerId) {
  if (room.phase === 'lobby') {
    const v = lobbyView(room);
    v.spectators = spectatorList(room);
    v.isSpectator = room.spectators.has(playerId);
    attachBotPace(room, v);
    return v;
  }
  const idx = playerIndex(room, playerId);
  const v = viewState(room.state, idx);
  // Game-state players don't carry the bot flag; the room roster does.
  const botIds = new Set(room.players.filter((p) => p.isBot).map((p) => p.id));
  for (const p of v.players) {
    p.isBot = botIds.has(p.id);
    if (p.isBot) p.botVersion = BOT_VERSION;
  }
  // Same for the post-game stats rows (seat order matches v.players).
  for (const row of v.stats?.players ?? []) row.isBot = !!v.players[row.index]?.isBot;
  // Par for this deck, shown next to the final score. Same gate as the seed:
  // it's a fact about a deck, so it waits until there's nothing left to hide.
  v.botScore = room.state.status === 'finished' ? room.botScore ?? null : null;
  v.hostId = room.hostId;
  v.options = room.options;
  attachBotPace(room, v);
  v.spectators = spectatorList(room);
  v.isSpectator = room.spectators.has(playerId);
  v.abandonVotes = {
    count: room.abandonVotes.size,
    threshold: ABANDON_THRESHOLD,
    me: playerId ? room.abandonVotes.has(playerId) : false,
  };
  const topUndo = room.undoStack[room.undoStack.length - 1];
  v.canUndo = !!(topUndo && topUndo.playerId === playerId);
  v.canRequestUndo = !!(
    topUndo &&
    topUndo.playerId !== playerId &&
    idx >= 0 &&
    room.state.status === 'playing'
  );
  v.undoRequestedByMe = playerId ? room.undoRequests.has(playerId) : false;
  v.undoRequests = [...room.undoRequests]
    .map((id) => room.state.players.find((p) => p.id === id)?.name)
    .filter(Boolean);
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
    // Not persisted in the save header (it's a room-social setting, not
    // game state) — resumed/branched rooms default it back off, same as a
    // freshly created room; the host can re-enable it from the lobby.
    allowSpectators: false,
  };
  room.players = state.players.map((p) => {
    const h = header.players.find((x) => x.id === p.id);
    return { id: p.id, name: p.name, online: false, isBot: !!h?.isBot };
  });
  room.hostId = header.hostId;
  room.state = state;
  room.undoStack = undoStack;
  room.abandonVotes = abandonVotes;
  room.savePath = filePath;
  return room;
}
