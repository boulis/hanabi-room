import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Shrink the human-feeling pauses before the module reads them.
process.env.HANABI_BOT_DELAY_MS = '10';
process.env.HANABI_BOT_UNDO_GRACE_MS = '30';
const {
  MAX_TOTAL_BOTS,
  addBot,
  adoptRoomBots,
  configureBot,
  initBots,
  isBotSeat,
  pokeBots,
  removeBot,
  removeRoomBots,
  resetBots,
  totalBots,
} = await import('./bots.js');
const { conventionsFromOptions } = await import('./botBrain.js');
const { applyAction, joinRoom, requestUndo, resumeRoom, startGame, undoLast } = await import('./room.js');
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

async function waitFor(pred, label, timeoutMs = 2000) {
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
