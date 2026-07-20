// Server-resident bot players. A bot is an ordinary seat in a room whose
// turns are driven in-process by botBrain.decide against the same filtered
// view a human client gets (viewFor) — no sockets, no child processes.
// bot.mjs remains available for running a bot from another machine.
import {
  alarmGuards, conventionsFromOptions, decide, defaultBotOptions, sanitizeBotOptions,
} from './botBrain.js';
import { applyAction, joinRoom, leaveRoom, undoLast, viewFor } from './room.js';
import { GameError } from './rules.js';

export const MAX_TOTAL_BOTS = 10; // across all rooms

const BOT_NAMES = ['Robo', 'Hal', 'Data', 'Marvin', 'Gerty', 'Kitt', 'Eve', 'Chip', 'Astro', 'Tik-Tok'];
// Overridable so tests don't wait out human-feeling pauses.
const BOT_DELAY_MS = Number(process.env.HANABI_BOT_DELAY_MS ?? 1200);
// After a bot honors an undo request, it waits before re-acting so the
// requester has time to chain their own undo.
const UNDO_GRACE_MS = Number(process.env.HANABI_BOT_UNDO_GRACE_MS ?? 6000);

// playerId -> { roomId, timer, graceUntil }
const bots = new Map();
// Set by the transport: async (roomId) => broadcast the room's new state.
let notify = null;

export function initBots(notifyFn) {
  notify = notifyFn;
}

export function totalBots() {
  return bots.size;
}

export function isBotSeat(playerId) {
  return bots.has(playerId);
}

function pickName(room) {
  const taken = new Set(room.players.map((p) => p.name));
  const free = BOT_NAMES.find((n) => !taken.has(n));
  if (free) return free;
  let i = 2;
  while (taken.has(`Robo ${i}`)) i++;
  return `Robo ${i}`;
}

export function addBot(room) {
  if (room.phase !== 'lobby') {
    throw new GameError('Bots can only be added in the room lobby', 'not_lobby');
  }
  if (bots.size >= MAX_TOTAL_BOTS) {
    throw new GameError(`Bot limit reached (${MAX_TOTAL_BOTS} bots across all rooms)`, 'bot_limit');
  }
  const player = joinRoom(room, { name: pickName(room) });
  player.isBot = true;
  player.botOptions = defaultBotOptions();
  bots.set(player.id, { roomId: room.id, timer: null, graceUntil: 0 });
  return player;
}

// Update a bot's convention options (host-side; lobby only). Merges the given
// flags over the current ones, ignoring anything that isn't a known boolean.
export function configureBot(room, playerId, options) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player || !player.isBot) throw new GameError('Not a bot', 'not_a_bot');
  if (room.phase !== 'lobby') {
    throw new GameError('Bots can only be configured in the room lobby', 'not_lobby');
  }
  player.botOptions = { ...(player.botOptions ?? defaultBotOptions()), ...sanitizeBotOptions(options) };
  return player;
}

export function removeBot(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player || !player.isBot) throw new GameError('Not a bot', 'not_a_bot');
  if (room.phase !== 'lobby') {
    throw new GameError('Bots can only be removed in the room lobby', 'not_lobby');
  }
  dropBot(playerId);
  leaveRoom(room, playerId);
}

// Re-staff bot seats in a room built from a save (resume or branch). New
// saves mark bot seats with isBot in the header; older saves lack the flag,
// so if no seat carries it we fall back to recognizing the built-in bot
// names. Seats beyond the global cap stay offline (a human can claim them).
export function adoptRoomBots(room) {
  const flagged = room.players.some((p) => p.isBot);
  for (const p of room.players) {
    if (!flagged && BOT_NAMES.includes(p.name)) p.isBot = true;
    if (!p.isBot || bots.has(p.id)) continue;
    if (bots.size >= MAX_TOTAL_BOTS) {
      console.error(`bot limit reached; seat "${p.name}" in room ${room.id} stays offline`);
      p.isBot = false;
      continue;
    }
    p.online = true;
    p.botOptions ??= defaultBotOptions();
    bots.set(p.id, { roomId: room.id, timer: null, graceUntil: 0 });
  }
}

// Room got deleted/closed — free its bots against the global cap.
export function removeRoomBots(roomId) {
  for (const [id, b] of bots) {
    if (b.roomId === roomId) dropBot(id);
  }
}

function dropBot(playerId) {
  const b = bots.get(playerId);
  if (b?.timer) clearTimeout(b.timer);
  bots.delete(playerId);
}

// Test hook: forget every bot (clears pending timers; doesn't touch rooms).
export function resetBots() {
  for (const id of [...bots.keys()]) dropBot(id);
}

// Called after every state broadcast for a room. Schedules at most one
// pending bot task; everything is re-validated when the timer fires, so
// stale schedules (undo rolled the turn back, game ended) are harmless.
export function pokeBots(room) {
  if (!room || room.phase !== 'playing' || room.state?.status !== 'playing') return;

  // A human requested an undo and the most recent action is a bot's: the bot
  // obliges. (Without this, a bot's action on top of the stack would block
  // the previous human from ever undoing their own move.)
  const top = room.undoStack[room.undoStack.length - 1];
  if (top && bots.has(top.playerId) && room.undoRequests.size > 0) {
    const b = bots.get(top.playerId);
    if (!b.timer) {
      b.timer = setTimeout(() => {
        b.timer = null;
        botUndo(room, top.playerId).catch((err) => console.error('bot undo failed:', err));
      }, BOT_DELAY_MS);
    }
    return;
  }

  const current = room.state.players[room.state.currentPlayer];
  const b = current ? bots.get(current.id) : undefined;
  if (!b || b.timer) return;
  const delay = Math.max(BOT_DELAY_MS, b.graceUntil - Date.now());
  b.timer = setTimeout(() => {
    b.timer = null;
    botAct(room, current.id).catch((err) => console.error('bot action failed:', err));
  }, delay);
}

async function botUndo(room, playerId) {
  const b = bots.get(playerId);
  if (!b) return;
  const top = room.undoStack[room.undoStack.length - 1];
  if (room.phase !== 'playing' || !top || top.playerId !== playerId || room.undoRequests.size === 0) {
    return;
  }
  await undoLast(room, playerId);
  // It's the bot's turn again now; give the requester room to chain their
  // own undo before the bot re-takes (likely the same) action.
  b.graceUntil = Date.now() + UNDO_GRACE_MS;
  if (notify) await notify(b.roomId);
}

async function botAct(room, playerId) {
  const b = bots.get(playerId);
  if (!b) return;
  if (room.phase !== 'playing' || room.state.status !== 'playing') return;
  const idx = room.state.players.findIndex((p) => p.id === playerId);
  if (idx !== room.state.currentPlayer) return; // stale schedule
  let view = viewFor(room, playerId);
  try {
    // Per-bot convention options, chosen by whoever created the bot.
    const conventions = conventionsFromOptions(room.players[idx].botOptions);
    // Alarm convention: guard first (annotate is turn-free), then act on a
    // fresh view that reflects the moved chop.
    const guards = alarmGuards(view, conventions);
    for (const cardId of guards) {
      await applyAction(room, playerId, { type: 'annotate', cardId, guarded: true }, 'alarm received: guarding');
    }
    if (guards.length > 0) view = viewFor(room, playerId);
    b.memory ??= {};
    const { action, reason } = decide(view, conventions, b.memory);
    await applyAction(room, playerId, action, reason);
  } catch (err) {
    console.error(`bot ${playerId} move rejected (${err.message}); using fallback`);
    try {
      await applyAction(room, playerId, fallbackAction(view), 'fallback (primary move rejected)');
    } catch (err2) {
      console.error(`bot ${playerId} fallback rejected too: ${err2.message}`);
      return; // give up this turn; humans can abandon the game
    }
  }
  if (notify) await notify(b.roomId);
}

// The safest legal move with no cleverness — mirrors bot.mjs's fallback.
function fallbackAction(view) {
  if (view.hintTokens < 8) return { type: 'discard', cardIndex: 0 };
  const other = view.players.findIndex((p, i) => i !== view.viewerIndex && p.hand.length > 0);
  if (other >= 0) {
    const hand = view.players[other].hand;
    return { type: 'hint', toPlayerIndex: other, hintType: 'number', value: hand[hand.length - 1].number };
  }
  return { type: 'play', cardIndex: 0 };
}
