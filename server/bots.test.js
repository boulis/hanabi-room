import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Shrink the human-feeling pauses before the module reads them.
process.env.HANABI_BOT_DELAY_MS = '10';
process.env.HANABI_BOT_UNDO_GRACE_MS = '30';
process.env.HANABI_BOT_REMIND_GAP_MS = '20';
process.env.HANABI_BOT_REMIND_WAIT_MS = '200';
const {
  MAX_TOTAL_BOTS,
  addBot,
  adoptRoomBots,
  configureBot,
  hurryBot,
  initBots,
  isBotSeat,
  pokeBots,
  removeBot,
  removeRoomBots,
  resetBots,
  totalBots,
} = await import('./bots.js');
const { conventionsFromOptions } = await import('./botBrain.js');
const {
  applyAction, autoBotDelay, botDelayFor, joinRoom, requestUndo, resumeRoom, setBotPace, startGame,
  undoLast, viewFor,
} = await import('./room.js');
const { branchSave } = await import('./savedGame.js');
const { GameError } = await import('./rules.js');
const { createRoom, deleteRoom, allRooms, isRoomIdle } = await import('./rooms.js');

function purgeRooms() {
  for (const r of allRooms()) deleteRoom(r.id);
}

async function withTmpSaveDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanabi-saves-'));
  const prev = process.env.HANABI_SAVED_DIR;
  process.env.HANABI_SAVED_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HANABI_SAVED_DIR;
    else process.env.HANABI_SAVED_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// The budget is a safety net against a hang, not an assertion about speed:
// nine test files run at once and a loaded box can starve this process for
// seconds. No test should depend on how long the wait actually takes — see
// withRemindWait for the timer windows that used to be raced.
async function waitFor(pred, label, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(15);
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('addBot: seats a bot in the lobby; rejected mid-game', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Bots');
    const human = joinRoom(room, { name: 'Ann' });
    const bot = addBot(room);
    assert.equal(bot.isBot, true);
    assert.equal(bot.name, 'Robo');
    assert.equal(totalBots(), 1);
    await startGame(room, human.id, { seed: 1 });
    assert.throws(() => addBot(room), GameError, 'no bots mid-game');
    assert.throws(() => removeBot(room, bot.id), GameError, 'no removal mid-game');
    resetBots();
  });
});

test('configureBot: options default on, toggle in lobby, drive conventions', () => {
  purgeRooms();
  resetBots();
  const room = createRoom('Opts');
  joinRoom(room, { name: 'Ann' });
  const bot = addBot(room);
  assert.deepEqual(bot.botOptions, { alarmDiscards: true, forcedPlaySignals: true, zeroHintPlaysChop: true });

  configureBot(room, bot.id, { alarmDiscards: false, zeroHintPlaysChop: false, bogus: 5 });
  assert.deepEqual(bot.botOptions, { alarmDiscards: false, forcedPlaySignals: true, zeroHintPlaysChop: false });
  assert.equal('bogus' in bot.botOptions, false, 'unknown keys ignored');

  const conv = conventionsFromOptions(bot.botOptions);
  assert.equal(conv.alarmDiscards, false);
  assert.equal(conv.forcedPlaySignals, true);
  assert.equal(conv.zeroHintPlaysChop, false);
  assert.equal(conv.colorHintPlaysNewest, true, 'non-optional flags stay on');

  assert.throws(() => configureBot(room, 'nobody', {}), GameError, 'not a bot');
  resetBots();
});

test('addBot: global cap of MAX_TOTAL_BOTS across all rooms', () => {
  purgeRooms();
  resetBots();
  // Rooms seat at most 5, so spread the 10 bots across three rooms.
  const r1 = createRoom('One');
  const r2 = createRoom('Two');
  const r3 = createRoom('Three');
  joinRoom(r1, { name: 'Ann' });
  for (let i = 0; i < 4; i++) addBot(r1);
  for (let i = 0; i < 5; i++) addBot(r2);
  for (let i = 0; i < MAX_TOTAL_BOTS - 9; i++) addBot(r3);
  assert.equal(totalBots(), MAX_TOTAL_BOTS);
  assert.throws(() => addBot(r3), /Bot limit reached/);
  // Removing one frees a slot for any room.
  const bot = r2.players.find((p) => p.isBot);
  removeBot(r2, bot.id);
  assert.equal(totalBots(), MAX_TOTAL_BOTS - 1);
  assert.ok(addBot(r3));
  resetBots();
});

test('removeBot: only removes bots; removeRoomBots frees a whole room', () => {
  purgeRooms();
  resetBots();
  const room = createRoom('R');
  const human = joinRoom(room, { name: 'Ann' });
  addBot(room);
  addBot(room);
  assert.throws(() => removeBot(room, human.id), /Not a bot/);
  assert.equal(totalBots(), 2);
  removeRoomBots(room.id);
  assert.equal(totalBots(), 0, 'cap slots freed');
  // Seats are cleaned up separately by room deletion; the registry is what
  // guards the cap.
  resetBots();
});

test('isRoomIdle: bots do not keep a room alive', () => {
  purgeRooms();
  resetBots();
  const room = createRoom('R');
  assert.equal(isRoomIdle(room), true);
  addBot(room);
  assert.equal(isRoomIdle(room), true, 'bot-only room is idle');
  const human = joinRoom(room, { name: 'Ann' });
  assert.equal(isRoomIdle(room), false);
  human.online = false;
  assert.equal(isRoomIdle(room), true);
  resetBots();
});

test('host handoff skips bots when a human leaves the lobby', async () => {
  purgeRooms();
  resetBots();
  const room = createRoom('Handoff');
  const ann = joinRoom(room, { name: 'Ann' });
  addBot(room);
  const ben = joinRoom(room, { name: 'Ben' });
  assert.equal(room.hostId, ann.id);
  const { leaveRoom } = await import('./room.js');
  leaveRoom(room, ann.id);
  assert.equal(room.hostId, ben.id, 'host skips the bot');
  resetBots();
});

test('bots take their turns automatically once poked', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Play');
    const human = joinRoom(room, { name: 'Ann' });
    addBot(room);
    addBot(room);
    initBots(async () => pokeBots(room)); // stand-in for the broadcast chain
    await startGame(room, human.id, { seed: 5 });

    // Turn 0 is the human's. Hint the first bot, then poke as broadcast would.
    const botHand = room.state.players[1].hand;
    await applyAction(room, human.id, {
      type: 'hint', toPlayerIndex: 1, hintType: 'number', value: botHand[0].number,
    });
    pokeBots(room);
    // Both bots act in sequence; the turn should come back to the human.
    await waitFor(() => room.state.currentPlayer === 0 && room.state.turn === 3, 'turn back to human');
    assert.equal(room.state.turn, 3, 'both bot turns taken');
    resetBots();
  });
});

test('adopt: branched/resumed rooms re-staff bot seats and they play on', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Original');
    const human = joinRoom(room, { name: 'Ann' });
    addBot(room);
    initBots(async () => {});
    await startGame(room, human.id, { seed: 5 });
    const botHand = room.state.players[1].hand;
    await applyAction(room, human.id, {
      type: 'hint', toPlayerIndex: 1, hintType: 'number', value: botHand[0].number,
    });
    const basename = path.basename(room.savePath);
    removeRoomBots(room.id);
    assert.equal(totalBots(), 0);

    // Branch after the first move; the bot seat comes back as a live bot.
    const branchedPath = await branchSave(basename, 1);
    const branched = await resumeRoom(branchedPath);
    branched.id = 'branch1';
    initBots(async () => pokeBots(branched));
    adoptRoomBots(branched);
    assert.equal(totalBots(), 1, 'bot seat adopted');
    const botSeat = branched.players[1];
    assert.equal(botSeat.isBot, true);
    assert.equal(botSeat.online, true, 'adopted bots are online');
    assert.equal(branched.players[0].online, false, 'human seat stays offline');

    // It's the bot's turn at the branch point — poking makes it act.
    assert.equal(branched.state.currentPlayer, 1);
    pokeBots(branched);
    await waitFor(() => branched.state.turn === 2, 'adopted bot took its turn');
    resetBots();
  });
});

test('adopt: legacy saves without isBot flags fall back to bot roster names', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    // "Robo" here is a plain human seat, producing a header without isBot
    // flags — like a save from before the flag existed.
    const room = createRoom('Legacy');
    const ann = joinRoom(room, { name: 'Ann' });
    joinRoom(room, { name: 'Robo' });
    await startGame(room, ann.id, { seed: 5 });
    const resumed = await resumeRoom(room.savePath);
    resumed.id = 'legacy1';
    adoptRoomBots(resumed);
    assert.equal(totalBots(), 1, 'roster-named seat adopted as a bot');
    assert.equal(resumed.players[1].isBot, true);
    resetBots();
  });
});

test('adopt: seats beyond the global cap stay offline and human-claimable', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Full');
    const ann = joinRoom(room, { name: 'Ann' });
    addBot(room);
    await startGame(room, ann.id, { seed: 5 });
    const resumed = await resumeRoom(room.savePath);
    resumed.id = 'capped1';
    removeRoomBots(room.id);
    // Fill the cap elsewhere before adopting.
    const filler = createRoom('Filler');
    for (let i = 0; i < 5; i++) addBot(filler);
    const filler2 = createRoom('Filler2');
    for (let i = 0; i < MAX_TOTAL_BOTS - 5; i++) addBot(filler2);
    adoptRoomBots(resumed);
    assert.equal(resumed.players[1].isBot, false, 'seat demoted, not adopted');
    assert.equal(resumed.players[1].online, false, 'left claimable by a human');
    resetBots();
  });
});

test('a bot honors an undo request and gives the requester time to chain', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Undo');
    const human = joinRoom(room, { name: 'Ann' });
    addBot(room);
    initBots(async () => pokeBots(room));
    await startGame(room, human.id, { seed: 5 });

    const botHand = room.state.players[1].hand;
    await applyAction(room, human.id, {
      type: 'hint', toPlayerIndex: 1, hintType: 'number', value: botHand[0].number,
    });
    pokeBots(room);
    await waitFor(() => room.state.turn === 2, 'bot acted');
    assert.equal(room.undoStack.length, 2);

    // The bot's action sits on top; the human requests, the bot undoes.
    requestUndo(room, human.id);
    pokeBots(room);
    await waitFor(() => room.state.turn === 1, 'bot undid its action');
    assert.equal(room.undoStack.length, 1, 'top of stack is the human hint again');
    assert.equal(room.undoRequests.size, 0, 'request consumed');
    // Grace period: within it, the human can undo their own action.
    assert.equal(room.undoStack[0].playerId, human.id);
    resetBots();
  });
});

test('a human can walk several moves back, alternating requests and own undos', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Chain');
    const human = joinRoom(room, { name: 'Ann' });
    addBot(room);
    initBots(async () => pokeBots(room));
    await startGame(room, human.id, { seed: 5 });

    // Four moves in: human, bot, human, bot.
    for (let i = 0; i < 2; i++) {
      const botHand = room.state.players[1].hand;
      await applyAction(room, human.id, {
        type: 'hint', toPlayerIndex: 1, hintType: 'number', value: botHand[0].number,
      });
      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 0, `bot took move ${i + 1}`);
    }
    assert.equal(room.undoStack.length, 4);
    const turn = room.state.turn;

    // A wide grace window puts the bot's queued replacement move in flight for
    // the whole walk back — the second request used to be dropped on the floor
    // because that queued action already held the bot's timer slot.
    const prevGrace = process.env.HANABI_BOT_UNDO_GRACE_MS;
    process.env.HANABI_BOT_UNDO_GRACE_MS = '5000';
    try {
      for (let i = 0; i < 2; i++) {
        requestUndo(room, human.id);
        pokeBots(room);
        await waitFor(() => room.undoStack[room.undoStack.length - 1]?.playerId === human.id,
          `bot honored undo request ${i + 1}`);
        await undoLast(room, human.id); // then the human's own move underneath it
        pokeBots(room);
      }
    } finally {
      if (prevGrace === undefined) delete process.env.HANABI_BOT_UNDO_GRACE_MS;
      else process.env.HANABI_BOT_UNDO_GRACE_MS = prevGrace;
    }
    assert.equal(room.undoStack.length, 0, 'all four moves rolled back');
    assert.equal(room.state.turn, turn - 4, 'four turns earlier');
    assert.equal(room.state.currentPlayer, 0, 'back on the human');
    resetBots();
  });
});

// A 50-card `simple` draw order dealing hands[p][i] round-robin, with the rest
// of the multiset trailing in a stable order (the same trick botBrain.test.js
// uses to pin a position).
function craftedDeck(hands, next = []) {
  const order = [];
  for (let i = 0; i < 5; i++) for (const hand of hands) order.push(hand[i]);
  order.push(...next);
  const owed = new Map();
  for (const color of ['red', 'yellow', 'green', 'blue', 'white']) {
    for (const n of [1, 1, 1, 2, 2, 3, 3, 4, 4, 5]) {
      const k = `${color}_${n}`;
      owed.set(k, (owed.get(k) || 0) + 1);
    }
  }
  for (const k of order) owed.set(k, owed.get(k) - 1);
  for (const [k, count] of owed) for (let i = 0; i < count; i++) order.push(k);
  return order;
}

// Seat a bot (index 0, host) and a human (index 1) on a deck where the bot's
// next decision is an alarm discard, and run the game up to that point. Guards
// are shared, so the bot can see whether the human answers.
async function alarmSetup(reacted) {
  const room = createRoom('Alarm');
  const bot = addBot(room);
  const human = joinRoom(room, { name: 'Ann' });
  room.options.endRule = 'lax';
  room.options.shareGuarded = true;
  room.importedDeck = craftedDeck([
    ['red_2', 'blue_3', 'white_1', 'green_3', 'yellow_1'], // bot
    ['red_2', 'blue_3', 'yellow_4', 'green_4', 'white_4'], // human
  ]);
  initBots(async () => pokeBots(room), (roomId, playerIndex, emoji) => {
    reacted.push({ roomId, playerIndex, emoji });
  });
  await startGame(room, bot.id, {});
  // Walk to the position from botBrain.test.js's two-critical alarm: the
  // human's red_2 and blue_3 are both last copies on different colours and
  // numbers, so no single hint protects both. Applied directly (no poke), so
  // the bot doesn't start playing mid-setup.
  const hint = (from, to, value) => applyAction(room, from, {
    type: 'hint', toPlayerIndex: to, hintType: 'number', value,
  });
  await hint(bot.id, 1, 4);
  await hint(human.id, 0, 1);
  await applyAction(room, bot.id, { type: 'discard', cardIndex: 0 });
  await hint(human.id, 0, 1);
  await applyAction(room, bot.id, { type: 'discard', cardIndex: 0 });
  await hint(human.id, 0, 1);
  assert.equal(room.state.currentPlayer, 0, 'the bot is on turn');
  return { room, bot, human };
}

// Run `fn` with the bot's post-nag hold set to `ms`. Tests pick a window long
// enough that they never race it: one that checks the bot HOLDS its turn wants
// a window it cannot outlive, one that checks the bot moves on wants a window
// that expires immediately. Asserting both across one middling window is what
// made this file flaky — under load the process can stall past any window a
// test could pick.
async function withRemindWait(ms, fn) {
  const prev = process.env.HANABI_BOT_REMIND_WAIT_MS;
  process.env.HANABI_BOT_REMIND_WAIT_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HANABI_BOT_REMIND_WAIT_MS;
    else process.env.HANABI_BOT_REMIND_WAIT_MS = prev;
  }
}

// The nag: raised, and the turn held open while it stands. The window is set
// far longer than the test can take, so "still holding" is never a race.
test('alarm: the bot nags an unanswered guard and holds its turn', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    await withRemindWait(600000, async () => {
      const reacted = [];
      const { room, human } = await alarmSetup(reacted);

      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 1, 'bot took its alarm turn');
      const alarm = room.state.log.filter((e) => e.type === 'discard').pop();
      assert.ok(alarm.reasoning?.startsWith('ALARM'), `expected an alarm (got: ${alarm.reasoning})`);
      assert.deepEqual(reacted, [], 'nothing to nag about yet');

      // The human answers with a move instead of a guard — exactly the slip the
      // reminder exists for.
      await applyAction(room, human.id, {
        type: 'hint', toPlayerIndex: 0, hintType: 'number', value: 1,
      });
      pokeBots(room);
      await waitFor(() => reacted.length === 2, 'two reminder reactions');
      assert.deepEqual(reacted.map((r) => r.emoji), ['❗', '❗']);
      assert.deepEqual(reacted.map((r) => r.playerIndex), [0, 0], 'the bot is the one exclaiming');
      assert.equal(room.state.currentPlayer, 0, 'the bot holds its turn while it waits');
    });
    resetBots();
  });
});

// …and the other half, with a window that expires at once, so "it moved on"
// needs no guess about how long the wait was.
test('alarm: an unanswered nag lapses — it plays on, and nags only once', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    await withRemindWait(1, async () => {
      const reacted = [];
      const { room, human } = await alarmSetup(reacted);

      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 1, 'bot took its alarm turn');
      await applyAction(room, human.id, {
        type: 'hint', toPlayerIndex: 0, hintType: 'number', value: 1,
      });
      pokeBots(room);
      await waitFor(() => reacted.length === 2, 'two reminder reactions');
      await waitFor(() => room.state.currentPlayer === 1, 'bot moved after the wait');

      // Next turn it does not nag again: an unanswered nag is dropped, not
      // repeated every turn that follows.
      await applyAction(room, human.id, { type: 'discard', cardIndex: 4 });
      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 1, 'bot took its next turn');
      assert.equal(reacted.length, 2, 'one nag per alarm');
    });
    resetBots();
  });
});

test('alarm: a human who guards is never nagged', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const reacted = [];
    const { room, human } = await alarmSetup(reacted);
    pokeBots(room);
    await waitFor(() => room.state.currentPlayer === 1, 'bot took its alarm turn');

    // The convention answered properly: guard the oldest unclued cards, then move.
    const hand = room.state.players[1].hand;
    for (const c of [hand[0], hand[1]]) {
      await applyAction(room, human.id, { type: 'annotate', cardId: c.id, guarded: true });
    }
    await applyAction(room, human.id, {
      type: 'hint', toPlayerIndex: 0, hintType: 'number', value: 1,
    });
    pokeBots(room);
    await waitFor(() => room.state.currentPlayer === 1, 'bot took its next turn');
    assert.deepEqual(reacted, [], 'no reminder when the alarm was answered');
    resetBots();
  });
});

test('alarm: guarding during the nag lets the bot move on at once', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    // Ten minutes of hold: the bot moving on at all is then proof the guard
    // released it, with no stopwatch to lose a race with.
    await withRemindWait(600000, async () => {
      const reacted = [];
      const { room, human } = await alarmSetup(reacted);
      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 1, 'bot took its alarm turn');
      await applyAction(room, human.id, {
        type: 'hint', toPlayerIndex: 0, hintType: 'number', value: 1,
      });
      pokeBots(room);
      await waitFor(() => reacted.length === 2, 'two reminder reactions');
      assert.equal(room.state.currentPlayer, 0, 'still holding its turn open');

      // Annotate is turn-free: the human marks their chop mid-nag, and the
      // broadcast that follows pokes the bot out of its wait.
      await applyAction(room, human.id, {
        type: 'annotate', cardId: room.state.players[1].hand[0].id, guarded: true,
      });
      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 1, 'bot moved once guarded');
    });
    resetBots();
  });
});

test('alarm: an undo mid-nag replays the turn, and the nag with it', async () => {
  // Taking the move back puts the human on the very turn they were warned
  // about. The alarm is still unanswered, so the reminder is owed again — it
  // used to be spent by the undo and the replayed turn went unwarned.
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const prevWait = process.env.HANABI_BOT_REMIND_WAIT_MS;
    process.env.HANABI_BOT_REMIND_WAIT_MS = '5000';
    try {
      const reacted = [];
      const { room, human } = await alarmSetup(reacted);
      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 1, 'bot took its alarm turn');
      const nagged = () => applyAction(room, human.id, {
        type: 'hint', toPlayerIndex: 0, hintType: 'number', value: 1,
      });

      await nagged(); // moving on without guarding
      pokeBots(room);
      await waitFor(() => reacted.length === 2, 'nagged once');

      await undoLast(room, human.id); // ...taken back mid-nag
      pokeBots(room);
      assert.equal(room.state.currentPlayer, 1, 'the human is on the move again');
      await nagged(); // and made again, still without guarding
      pokeBots(room);
      await waitFor(() => reacted.length === 4, 'nagged again on the replayed turn');
      assert.deepEqual(reacted.map((r) => r.emoji), ['❗', '❗', '❗', '❗']);
    } finally {
      if (prevWait === undefined) delete process.env.HANABI_BOT_REMIND_WAIT_MS;
      else process.env.HANABI_BOT_REMIND_WAIT_MS = prevWait;
      resetBots();
    }
  });
});

test('alarm: an undo request mid-nag is honoured, not held for the whole nag', async () => {
  // The nag holds the bot's turn open for 12s. A request to undo the bot's
  // alarm arriving in that window used to be dropped outright — pokeBots would
  // not schedule past the pending timer, and when it fired the turn had rolled
  // away, so nothing rescheduled and the request hung until some other
  // broadcast happened along (9 minutes, in the game that turned this up).
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const prevWait = process.env.HANABI_BOT_REMIND_WAIT_MS;
    process.env.HANABI_BOT_REMIND_WAIT_MS = '5000';
    try {
      const reacted = [];
      const { room, human } = await alarmSetup(reacted);
      pokeBots(room);
      await waitFor(() => room.state.currentPlayer === 1, 'bot took its alarm turn');
      const alarmTurn = room.state.turn;
      await applyAction(room, human.id, {
        type: 'hint', toPlayerIndex: 0, hintType: 'number', value: 1,
      });
      pokeBots(room);
      await waitFor(() => reacted.length === 2, 'nagged, and now holding its turn');

      // Ann walks back: her own move first, then the bot's alarm behind it.
      await undoLast(room, human.id);
      assert.equal(room.undoStack[room.undoStack.length - 1].playerId, room.players[0].id,
        'the bot alarm is on top of the stack');
      requestUndo(room, human.id);
      pokeBots(room);
      await waitFor(() => room.state.turn === alarmTurn - 1, 'bot undid its alarm');
      assert.equal(room.undoRequests.size, 0, 'request consumed');
    } finally {
      if (prevWait === undefined) delete process.env.HANABI_BOT_REMIND_WAIT_MS;
      else process.env.HANABI_BOT_REMIND_WAIT_MS = prevWait;
      resetBots();
    }
  });
});

test('alarm: the free trash alarm is nagged like any other', async () => {
  // The cheapest alarm — throwing a provably dead card while holding a play —
  // is also the easiest for a human to sit through: on the table it looks like
  // the most routine move in the game. So the reminder has to cover it, which
  // it does by keying off the reason rather than the kind of card thrown.
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const reacted = [];
    const room = createRoom('Trash alarm');
    const bot = addBot(room);
    const human = joinRoom(room, { name: 'Ann' });
    room.options.endRule = 'lax';
    room.options.shareGuarded = true;
    room.importedDeck = craftedDeck([
      ['red_1', 'red_2', 'blue_1', 'white_3', 'green_2'], // bot
      ['red_2', 'yellow_5', 'blue_4', 'green_4', 'white_4'], // human
    ], ['green_5', 'yellow_1']);
    initBots(async () => pokeBots(room), (roomId, playerIndex, emoji) => {
      reacted.push({ roomId, playerIndex, emoji });
    });
    await startGame(room, bot.id, {});
    // Applied directly (no poke) so the bot doesn't start playing mid-setup:
    // both red 1 and one red 2 go down, leaving the bot's own red 2 dead, and
    // Ann pins it (number, then colour — so it slides out of the play targets)
    // before clueing the blue 1 the bot is then obliged to play.
    const hint = (from, to, hintType, value) => applyAction(room, from, {
      type: 'hint', toPlayerIndex: to, hintType, value,
    });
    await applyAction(room, bot.id, { type: 'play', cardIndex: 0 });
    await applyAction(room, human.id, { type: 'play', cardIndex: 0 });
    await hint(bot.id, 1, 'number', 4);
    await hint(human.id, 0, 'number', 2);
    await hint(bot.id, 1, 'number', 4);
    await hint(human.id, 0, 'color', 'red');
    await hint(bot.id, 1, 'number', 4);
    await hint(human.id, 0, 'color', 'blue');
    room.state.hintTokens = 0; // no way to hint Ann's critical yellow_5 chop
    assert.equal(room.state.currentPlayer, 0, 'the bot is on turn');

    pokeBots(room);
    await waitFor(() => room.state.currentPlayer === 1, 'bot took its alarm turn');
    const alarm = room.state.log.filter((e) => e.type === 'discard').pop();
    assert.match(alarm.reasoning ?? '', /^ALARM: discarding trash/, alarm.reasoning);

    // Ann moves on without guarding — the slip the reminder exists for.
    await hint(human.id, 0, 'number', 2);
    pokeBots(room);
    await waitFor(() => reacted.length === 2, 'two reminder reactions');
    assert.deepEqual(reacted.map((r) => r.emoji), ['❗', '❗']);
    assert.deepEqual(reacted.map((r) => r.playerIndex), [0, 0], 'the bot is the one exclaiming');
    resetBots();
  });
});

test('adopt: a save and its branch open as two rooms with independent bot seats', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Original');
    const human = joinRoom(room, { name: 'Ann' });
    addBot(room);
    initBots(async () => {});
    await startGame(room, human.id, { seed: 5 });
    const botHand = room.state.players[1].hand;
    await applyAction(room, human.id, {
      type: 'hint', toPlayerIndex: 1, hintType: 'number', value: botHand[0].number,
    });
    const basename = path.basename(room.savePath);
    removeRoomBots(room.id);
    deleteRoom(room.id);

    // Both rooms come from the same header, so both bot seats carry the SAME
    // playerId. Registered by playerId alone, the second room's seat looked
    // already-staffed and its moves were broadcast to the first room.
    const first = await resumeRoom(await branchSave(basename, 1));
    first.id = 'first';
    const second = await resumeRoom(path.join(process.env.HANABI_SAVED_DIR, basename));
    second.id = 'second';
    assert.equal(first.players[1].id, second.players[1].id, 'same bot playerId in both rooms');

    const notified = [];
    initBots(async (roomId) => {
      notified.push(roomId);
      pokeBots(roomId === first.id ? first : second);
    });
    adoptRoomBots(first);
    adoptRoomBots(second);
    assert.equal(totalBots(), 2, 'each room staffs its own bot seat');
    assert.equal(second.players[1].online, true, 'the second room\'s bot is live, not skipped');

    // A move in the second room must be announced to the second room.
    assert.equal(second.state.currentPlayer, 1);
    pokeBots(second);
    await waitFor(() => second.state.turn === 2, 'second room\'s bot took its turn');
    // Wait for the announcement itself, not just for the move: botAct applies
    // the action and only then awaits notify, so the state is already changed
    // while `notified` is still empty. Polling the state and asserting on the
    // callback caught that gap about one run in six.
    await waitFor(() => notified.length > 0, 'the move was announced');
    assert.deepEqual([...new Set(notified)], [second.id], 'broadcast went to the room that moved');
    assert.equal(first.state.turn, 1, 'the other room did not move');

    // Closing one room frees only its own seat.
    removeRoomBots(first.id);
    assert.equal(totalBots(), 1);
    const botId = second.players[1].id;
    assert.equal(isBotSeat(second.id, botId), true, 'the surviving room keeps its bot');
    assert.equal(isBotSeat(first.id, botId), false, 'the closed room released its own');
    resetBots();
  });
});

test('bot pace: auto slows down as soon as a second bot is seated', () => {
  purgeRooms();
  resetBots();
  const room = createRoom('Pace');
  joinRoom(room, { name: 'Ann' });
  addBot(room);
  assert.equal(autoBotDelay(room), 1200, 'one bot keeps the brisk pace');
  addBot(room);
  assert.equal(autoBotDelay(room), 4000, 'two bots play back-to-back, so slower');
  resetBots();
});

test('bot pace: an explicit setting outranks HANABI_BOT_DELAY_MS, auto defers to it', () => {
  purgeRooms();
  resetBots();
  const room = createRoom('Pace');
  joinRoom(room, { name: 'Ann' });
  addBot(room);
  // The env var is the default for 'auto' only — which is exactly what lets
  // this suite run every other test at 10ms.
  assert.equal(botDelayFor(room), 10, 'auto takes the env override');
  setBotPace(room, 2500);
  assert.equal(botDelayFor(room), 2500);
  setBotPace(room, 'manual');
  assert.equal(botDelayFor(room), null, 'manual is "no timer at all"');
  setBotPace(room, 'auto');
  assert.equal(botDelayFor(room), 10, 'back to the default');
  assert.throws(() => setBotPace(room, -1), GameError);
  assert.throws(() => setBotPace(room, 60001), GameError);
  assert.throws(() => setBotPace(room, 'quick'), GameError);
  // The view carries both halves: the raw setting and what it comes to.
  setBotPace(room, 3000);
  const v = viewFor(room, room.players[0].id);
  assert.equal(v.botPaceMs, 3000);
  assert.equal(v.botDelayMs, 3000);
  assert.equal(v.hasBots, true);
  resetBots();
});

test('bot pace manual: the bot holds its turn until hurryBot releases it', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Manual');
    const human = joinRoom(room, { name: 'Ann' });
    addBot(room);
    initBots(async () => pokeBots(room));
    await startGame(room, human.id, { seed: 5 });
    setBotPace(room, 'manual');

    const botHand = room.state.players[1].hand;
    await applyAction(room, human.id, {
      type: 'hint', toPlayerIndex: 1, hintType: 'number', value: botHand[0].number,
    });
    assert.equal(room.state.currentPlayer, 1);
    pokeBots(room);
    // Everything else in this file runs at a 10ms pace, so a move would have
    // landed many times over by now.
    await sleep(120);
    assert.equal(room.state.turn, 1, 'the bot is still waiting to be released');

    assert.equal(hurryBot(room), true);
    await waitFor(() => room.state.turn === 2, 'released bot took its turn');
    assert.equal(room.state.currentPlayer, 0, 'turn came back to the human');
    // Nothing on turn to hurry now that it's the human's move.
    assert.equal(hurryBot(room), false);
    resetBots();
  });
});

test('bot pace: hurryBot skips the remaining wait at a slow pace', async () => {
  await withTmpSaveDir(async () => {
    purgeRooms();
    resetBots();
    const room = createRoom('Hurry');
    const human = joinRoom(room, { name: 'Ann' });
    addBot(room);
    initBots(async () => pokeBots(room));
    await startGame(room, human.id, { seed: 5 });
    setBotPace(room, 30000); // far longer than this test may take

    const botHand = room.state.players[1].hand;
    await applyAction(room, human.id, {
      type: 'hint', toPlayerIndex: 1, hintType: 'number', value: botHand[0].number,
    });
    pokeBots(room);
    assert.equal(room.state.turn, 1, 'nothing happens on its own at 30s');
    hurryBot(room);
    await waitFor(() => room.state.turn === 2, 'hurried bot took its turn');
    resetBots();
  });
});
