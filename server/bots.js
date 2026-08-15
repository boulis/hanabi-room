// Server-resident bot players. A bot is an ordinary seat in a room whose
// turns are driven in-process by botBrain.decide against the same filtered
// view a human client gets (viewFor) — no sockets, no child processes.
// bot.mjs remains available for running a bot from another machine.
import {
  alarmGuardTargets, alarmGuards, conventionsFromOptions, decide, defaultBotOptions,
  sanitizeBotOptions,
} from './botBrain.js';
import {
  BOT_PACE_SOLO_MS, applyAction, botDelayFor, joinRoom, leaveRoom, undoLast, viewFor,
} from './room.js';
import { GameError } from './rules.js';

export const MAX_TOTAL_BOTS = 10; // across all rooms

const BOT_NAMES = ['Robo', 'Hal', 'Data', 'Marvin', 'Gerty', 'Kitt', 'Eve', 'Chip', 'Astro', 'Tik-Tok'];
// How long this room's bots pause before moving is botDelayFor (room.js:
// per-room setting, HANABI_BOT_DELAY_MS, then the auto default), where null
// means 'manual' — no turn taken until someone presses Play now.
//
// replyDelay covers everything that isn't the bot taking its turn: honouring
// an undo request,
// and the lead-in to a guard reminder. Those are answers the table is waiting
// on rather than moves to read, so 'manual' must not park them forever — it
// paces play, not correctness.
const replyDelay = (room) => botDelayFor(room) ?? BOT_PACE_SOLO_MS;
// After a bot honors an undo request, it waits before re-acting so the
// requester has time to chain their own undo. Read per use, so a test can
// widen the window around the moment it wants to exercise.
const undoGraceMs = () => Number(process.env.HANABI_BOT_UNDO_GRACE_MS ?? 6000);
// Guard reminder (see remindGuards): the gap between the two ❗ reactions, and
// how long the bot then holds its turn open for the marks to appear.
const remindGapMs = () => Number(process.env.HANABI_BOT_REMIND_GAP_MS ?? 2000);
const remindWaitMs = () => Number(process.env.HANABI_BOT_REMIND_WAIT_MS ?? 12000);

// "<roomId>:<playerId>" -> { roomId, playerId, timer, pending: 'act' | 'undo' | 'remind' | null, graceUntil }
//
// Keyed by BOTH ids: a playerId is unique within a room but not across the
// server. Resuming a save (or branching one) reuses the ids in its header, so
// the same save open in two rooms — a resume plus a branch of it, say — gives
// two rooms a bot seat with identical ids. Keyed by playerId alone the second
// room's seat looked already-registered: adoption skipped it (leaving it
// offline) and the entry's roomId still pointed at the first room, so the
// post-move broadcast went to a room the move never happened in and the players
// watching the real one saw their bot freeze mid-turn.
const bots = new Map();
// Set by the transport: async (roomId) => broadcast the room's new state.
let notify = null;
// Set by the transport: (roomId, playerIndex, emoji) => relay an ephemeral
// reaction to the room, the same one a human's react message produces. Bots
// hold no connection, so they can't send one the ordinary way.
let react = null;

const seatKey = (roomId, playerId) => `${roomId}:${playerId}`;

export function initBots(notifyFn, reactFn = null) {
  notify = notifyFn;
  react = reactFn;
}

export function totalBots() {
  return bots.size;
}

export function isBotSeat(roomId, playerId) {
  return bots.has(seatKey(roomId, playerId));
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
  bots.set(seatKey(room.id, player.id), {
    roomId: room.id, playerId: player.id, timer: null, pending: null, graceUntil: 0, awaitingGuards: null,
  });
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
  dropBot(seatKey(room.id, playerId));
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
    if (!p.isBot || bots.has(seatKey(room.id, p.id))) continue;
    if (bots.size >= MAX_TOTAL_BOTS) {
      console.error(`bot limit reached; seat "${p.name}" in room ${room.id} stays offline`);
      p.isBot = false;
      continue;
    }
    p.online = true;
    p.botOptions ??= defaultBotOptions();
    bots.set(seatKey(room.id, p.id), {
      roomId: room.id, playerId: p.id, timer: null, pending: null, graceUntil: 0, awaitingGuards: null,
    });
  }
}

// Room got deleted/closed — free its bots against the global cap.
export function removeRoomBots(roomId) {
  for (const [key, b] of bots) {
    if (b.roomId === roomId) dropBot(key);
  }
}

function dropBot(key) {
  const b = bots.get(key);
  if (b?.timer) clearTimeout(b.timer);
  bots.delete(key);
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

  // A nag belongs to the turn it was raised on. When an undo rolls that turn
  // away, drop the pending chain now instead of letting it sit out its 12s hold
  // — otherwise a turn that comes back round mid-hold gets played rather than
  // re-nagged. The alarm stays armed: it is still unanswered, and the move it
  // warned about is being replayed.
  const onTurnId = room.state.players[room.state.currentPlayer]?.id;
  for (const b of bots.values()) {
    if (b.roomId !== room.id || b.pending !== 'remind' || b.playerId === onTurnId) continue;
    clearTimeout(b.timer);
    b.timer = null;
    b.pending = null;
  }

  // A human requested an undo and the most recent action is a bot's: the bot
  // obliges. (Without this, a bot's action on top of the stack would block
  // the previous human from ever undoing their own move.)
  const top = room.undoStack[room.undoStack.length - 1];
  if (top && bots.has(seatKey(room.id, top.playerId)) && room.undoRequests.size > 0) {
    const b = bots.get(seatKey(room.id, top.playerId));
    // A queued task must not swallow the request. Honouring an undo puts the
    // bot back on turn, so the very next poke queues its replacement move (after
    // the grace pause) — and a request to walk one move further back arrives
    // while that timer is pending. Refusing to schedule then left the request
    // hanging for good: when the queued action finally fired it found the turn
    // rolled away, returned as a stale schedule, and nothing poked again. So an
    // undo request preempts whatever is queued; going back is always what the
    // player asked for most recently. That includes a nag in flight (which held
    // the request for its full 14 seconds and then stranded it the same way) —
    // asking about guards is moot on a turn we are about to roll back, and the
    // alarm stays armed for when it comes round again.
    if (b.timer && b.pending !== 'undo') {
      clearTimeout(b.timer);
      b.timer = null;
      b.pending = null;
    }
    if (!b.timer) {
      b.pending = 'undo';
      b.timer = setTimeout(() => {
        b.timer = null;
        b.pending = null;
        botUndo(room, top.playerId).catch((err) => console.error('bot undo failed:', err));
      }, replyDelay(room));
    }
    return;
  }

  const current = room.state.players[room.state.currentPlayer];
  const b = current ? bots.get(seatKey(room.id, current.id)) : undefined;
  if (!b) return;
  // Mid-reminder and the marks have appeared: stop waiting and play on. (An
  // annotate broadcasts like any other action, so this poke is how the bot
  // hears the answer.)
  if (b.pending === 'remind' && !guardReminderDue(room, b)) {
    clearTimeout(b.timer);
    b.timer = null;
    b.pending = null;
    b.awaitingGuards = null;
  }
  if (b.timer) return;
  if (guardReminderDue(room, b)) {
    b.pending = 'remind';
    b.timer = setTimeout(() => remindGuards(room, current.id), replyDelay(room));
    return;
  }
  const pace = botDelayFor(room);
  // Manual pace: the bot is on turn and simply waits to be released. Nothing
  // is scheduled, so a Play now (hurryBot) is the only thing that moves it —
  // which is the point, and why pending is still marked: the client shows the
  // button off the seat being a bot's, and hurryBot needs a bot to release.
  if (pace === null) {
    b.pending = 'act';
    return;
  }
  const delay = Math.max(pace, b.graceUntil - Date.now());
  b.pending = 'act';
  b.timer = setTimeout(() => {
    b.timer = null;
    b.pending = null;
    botAct(room, current.id).catch((err) => console.error('bot action failed:', err));
  }, delay);
}

// "Play now": stop waiting out the pause (or the manual hold, or the tail of a
// guard reminder) and take the turn. Anyone at the table may press it — it
// only ever brings forward a move the bot was already going to make.
export function hurryBot(room) {
  if (!room || room.phase !== 'playing' || room.state?.status !== 'playing') return false;
  const current = room.state.players[room.state.currentPlayer];
  const b = current ? bots.get(seatKey(room.id, current.id)) : undefined;
  if (!b || b.pending === 'undo') return false;
  if (b.timer) clearTimeout(b.timer);
  b.timer = null;
  b.pending = null;
  // Whatever the bot was waiting on, someone has now said go: the post-undo
  // grace ends here, and a guard reminder in flight is settled the ordinary
  // way by the move itself (whoever pressed has seen the ❗s).
  b.graceUntil = 0;
  botAct(room, current.id).catch((err) => console.error('bot action failed:', err));
  return true;
}

async function botUndo(room, playerId) {
  const b = bots.get(seatKey(room.id, playerId));
  if (!b) return;
  const top = room.undoStack[room.undoStack.length - 1];
  if (room.phase !== 'playing' || !top || top.playerId !== playerId || room.undoRequests.size === 0) {
    return;
  }
  await undoLast(room, playerId);
  // Taking our move back unmakes whatever it asked for. An armed alarm always
  // refers to our most recent action — noteAlarm sets it as we act, botAct
  // clears it as we act again — which is precisely the move being undone here,
  // so the guards it asked for are no longer owed and must not be nagged about.
  b.awaitingGuards = null;
  // It's the bot's turn again now; give the requester room to chain their
  // own undo before the bot re-takes (likely the same) action.
  b.graceUntil = Date.now() + undoGraceMs();
  if (notify) await notify(b.roomId);
}

// --- Guard reminder ---
// An alarm discard is only half a signal: it works because the next player
// answers it by guarding their oldest unclued card(s), which is what moves
// their chop off the danger. A human can simply forget to click, and the
// forgotten mark is invisible as a mistake — the bot reads the shared guard
// flags, sees none, and goes on believing the criticals are still exposed
// while the human goes on believing they were warned. So when the alarm went
// unanswered, the bot says so before its next move instead of moving into the
// misunderstanding: two ❗ reactions two seconds apart, then it holds its turn
// open long enough for the marks to appear.
//
// Only with shareGuarded on. With guards private the bot can't see the answer
// at all, so there is nothing to detect — it infers the marks instead
// (inferredGuards in botBrain.js) and nagging would fire on every alarm.

// Called after every bot decision: remember what an alarm we just raised asks
// of its receiver, so the next turn can check whether they answered.
function noteAlarm(room, b, view, idx, reason) {
  if (!reason?.startsWith('ALARM') || !view.shareGuarded) return;
  const rIdx = (idx + 1) % room.state.players.length;
  const receiver = room.state.players[rIdx];
  const seat = room.players.find((p) => p.id === receiver.id);
  // A bot receiver guards on its own; an absent human can't be reminded, and
  // waiting on one would just stall the table.
  if (!seat || seat.isBot || !seat.online) return;
  // The discard restores a token, so the receiver reads one more than we hold
  // now — the same arithmetic alarmGuards does from the other side.
  const ids = alarmGuardTargets(view, rIdx, view.hintTokens > 0 ? 2 : 1);
  if (ids.length === 0) return;
  b.awaitingGuards = {
    playerId: receiver.id,
    ids,
    already: new Set(view.players[rIdx].hand.filter((c) => c.annotations?.guarded).map((c) => c.id)),
  };
}

// Did the alarm's receiver answer it? Any newly guarded card counts, not just
// the ones the convention names: a human may reasonably mark a different card
// (they can see their own hints), and the failure this catches is forgetting
// entirely. Once every card the alarm pointed at has left the hand there is
// nothing left to guard — and nothing left to save — so the reminder lapses.
function guardReminderDue(room, b) {
  const owed = b.awaitingGuards;
  if (!owed) return false;
  const p = room.state?.players.find((pl) => pl.id === owed.playerId);
  if (!p) return false;
  if (p.hand.some((c) => c.annotations.guarded && !owed.already.has(c.id))) return false;
  // A card someone has since clued is off the chop too — the alarm's danger is
  // handled, just not by a guard mark.
  return p.hand.some((c) => owed.ids.includes(c.id) && !c.colorClued && !c.numberClued);
}

function remindGuards(room, playerId) {
  const b = bots.get(seatKey(room.id, playerId));
  if (!b) return;
  b.timer = null;
  const idx = room.state?.players.findIndex((p) => p.id === playerId) ?? -1;
  const onTurn = () => room.phase === 'playing' && room.state?.status === 'playing'
    && idx === room.state.currentPlayer;
  // The turn rolled away under us: an undo put the receiver back on the very
  // move we are nagging about. Drop the nag — exclaiming out of turn is noise —
  // but KEEP the alarm armed. It is still unanswered, and the turn that was
  // going to settle it is being replayed, so the reminder is owed again. (Left
  // to `settle`, an undo mid-nag silently spent the alarm and the replayed turn
  // went unwarned, which is exactly the mistake the reminder exists to catch.)
  const abandon = () => { b.timer = null; b.pending = null; };
  // Answered, or the turn taken: nothing more is owed for this alarm.
  const settle = () => { b.timer = null; b.pending = null; b.awaitingGuards = null; };
  // Re-checked before each step, since 2s + 12s is plenty of time for the
  // guards to appear or for the table to move under us.
  const step = () => {
    if (!onTurn()) { abandon(); return false; }
    if (!guardReminderDue(room, b)) {
      settle();
      pokeBots(room); // reschedule as an ordinary move
      return false;
    }
    return true;
  };
  if (!step()) return;
  react?.(room.id, idx, '❗');
  b.timer = setTimeout(() => {
    b.timer = null;
    if (!step()) return;
    react?.(room.id, idx, '❗');
    b.timer = setTimeout(() => {
      // One nag per turn: unanswered, take the turn rather than hold the table
      // up again. botAct settles the alarm — but only once it is really our
      // move, so a turn rolled away in the meantime keeps it armed.
      b.timer = null;
      b.pending = null;
      botAct(room, playerId).catch((err) => console.error('bot action failed:', err));
    }, remindWaitMs());
  }, remindGapMs());
}

async function botAct(room, playerId) {
  const b = bots.get(seatKey(room.id, playerId));
  if (!b) return;
  if (room.phase !== 'playing' || room.state.status !== 'playing') return;
  const idx = room.state.players.findIndex((p) => p.id === playerId);
  if (idx !== room.state.currentPlayer) return; // stale schedule
  b.awaitingGuards = null; // whatever the last alarm asked for, this turn settles it
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
    // Recorded off the pre-action view, which is the right one: our own discard
    // leaves the receiver's hand untouched, and the token count they'll read is
    // the one we decided with.
    noteAlarm(room, b, view, idx, reason);
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
