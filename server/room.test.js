import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GameError } from './rules.js';
import {
  applyAction,
  clearImportedDeck,
  configureRoom,
  createRoom,
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
import { exportDeckOrder } from './game.js';
import { viewState } from './view.js';
import {
  branchSave,
  deleteSave,
  listIncompleteSaves,
  listLibrary,
  loadSave,
  readAllTags,
  setSaveTags,
} from './savedGame.js';

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

async function setupRoom() {
  const room = createRoom();
  const alice = joinRoom(room, { name: 'Alice' });
  const bob = joinRoom(room, { name: 'Bob' });
  await startGame(room, alice.id, { seed: 12345 });
  return { room, alice, bob };
}

test('action reasoning is saved, shown on replay and finished games, hidden live', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const cur = room.state.currentPlayer;
    const actor = [alice, bob][cur];
    const value = room.state.players[1 - cur].hand[0].number;
    await applyAction(
      room,
      actor.id,
      { type: 'hint', toPlayerIndex: 1 - cur, hintType: 'number', value },
      'testing my hunch',
    );
    const lastHint = (log) => log.findLast((e) => e.type === 'hint');
    assert.equal(lastHint(room.state.log).reasoning, 'testing my hunch');
    // Live views hide it — it may reference cards players cannot see…
    for (const p of [alice, bob]) {
      assert.equal(lastHint(viewFor(room, p.id).log).reasoning, undefined);
    }
    // …but the save records it and reconstruction stamps it back on the log…
    const loaded = await loadSave(room.savePath);
    assert.equal(loaded.events.at(-1).reasoning, 'testing my hunch');
    assert.equal(lastHint(loaded.state.log).reasoning, 'testing my hunch');
    // …the omniscient replay viewer (viewerIndex -1) sees it…
    assert.equal(lastHint(viewState(loaded.state, -1).log).reasoning, 'testing my hunch');
    // …and so does everyone once the game is finished.
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    assert.equal(lastHint(viewFor(room, alice.id).log).reasoning, 'testing my hunch');
  });
});

test('abandon: single vote does not abandon the game', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    const result = await voteAbandon(room, alice.id);
    assert.equal(result.abandoned, false);
    assert.equal(room.phase, 'playing');
    assert.equal(room.abandonVotes.size, 1);
  });
});

test('abandon: two votes marks the game finished with reason=abandoned', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    const result = await voteAbandon(room, bob.id);
    assert.equal(result.abandoned, true);
    assert.equal(room.phase, 'playing', 'room stays in playing phase…');
    assert.equal(room.state.status, 'finished', '…but state is finished');
    assert.equal(room.state.endReason, 'abandoned');
    assert.ok(room.state.endedAt, 'endedAt is stamped');
    assert.equal(room.abandonVotes.size, 0);
    assert.equal(room.undoStack.length, 0);
  });
});

test('abandon: same player voting twice toggles their vote', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    await voteAbandon(room, alice.id);
    assert.equal(room.abandonVotes.size, 1);
    await voteAbandon(room, alice.id);
    assert.equal(room.abandonVotes.size, 0);
    assert.equal(room.phase, 'playing');
  });
});

test('abandon: rejected outside a playing game', async () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  await assert.rejects(() => voteAbandon(room, a.id), GameError);
});

test('abandon: votes reset when a new game starts', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    assert.equal(room.abandonVotes.size, 1);
    await voteAbandon(room, bob.id);
    await startGame(room, alice.id, { seed: 99 });
    assert.equal(room.abandonVotes.size, 0);
  });
});

test('viewFor exposes abandonVotes count and self-vote flag', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    const aliceView = viewFor(room, alice.id);
    assert.equal(aliceView.abandonVotes.count, 1);
    assert.equal(aliceView.abandonVotes.threshold, 2);
    assert.equal(aliceView.abandonVotes.me, true);
    const bobView = viewFor(room, bob.id);
    assert.equal(bobView.abandonVotes.me, false);
  });
});

test('join: a second connection sharing an id reuses the same seat (duplicate tab)', () => {
  const room = createRoom();
  const first = joinRoom(room, { name: 'Alice' });
  const second = joinRoom(room, { name: 'Alice', playerId: first.id });
  assert.equal(second.id, first.id, 'duplicate tab takes the same seat');
  assert.equal(room.players.length, 1);
  assert.equal(room.hostId, first.id);
});

test('join: name-based recovery reclaims an offline seat mid-game', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, alice.id, { seed: 1 });
    leaveRoom(room, alice.id);
    assert.equal(alice.online, false);
    const recovered = joinRoom(room, { name: 'Alice' });
    assert.equal(recovered.id, alice.id, 'same seat returned');
    assert.equal(recovered.online, true);
    assert.equal(room.players.length, 2);
  });
});

test('join: name-based recovery is case-insensitive and trims whitespace', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, alice.id, { seed: 1 });
    leaveRoom(room, alice.id);
    const recovered = joinRoom(room, { name: '  alice ' });
    assert.equal(recovered.id, alice.id);
    assert.equal(recovered.name, '  alice ', 'name is updated to what the user typed');
  });
});

test('rename: updates the player name without changing the seat', async () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  await renamePlayer(room, a.id, '  Alicia ');
  assert.equal(a.name, 'Alicia');
  assert.equal(room.players.length, 1);
});

test('rename: rejects empty or whitespace-only names', async () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  await assert.rejects(() => renamePlayer(room, a.id, ''), GameError);
  await assert.rejects(() => renamePlayer(room, a.id, '   '), GameError);
  await assert.rejects(() => renamePlayer(room, a.id, null), GameError);
});

test('rename: rejects unknown player', async () => {
  const room = createRoom();
  await assert.rejects(() => renamePlayer(room, 'nobody', 'Anyone'), GameError);
});

test('rename: updates the in-game name when a game is in progress', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const a = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, a.id, { seed: 1 });
    await renamePlayer(room, a.id, 'Alicia');
    assert.equal(a.name, 'Alicia');
    const inGame = room.state.players.find((p) => p.id === a.id);
    assert.equal(inGame.name, 'Alicia');
  });
});

test('join: name-based recovery does not steal an online seat', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, alice.id, { seed: 1 });
    assert.throws(() => joinRoom(room, { name: 'Alice' }), GameError);
    assert.equal(room.players.length, 2);
  });
});

test('join: same id without an active conflict restores the seat (reconnect)', () => {
  const room = createRoom();
  const first = joinRoom(room, { name: 'Alice' });
  const reconnected = joinRoom(room, { name: 'Alice', playerId: first.id });
  assert.equal(reconnected.id, first.id);
  assert.equal(room.players.length, 1);
});

test('join: ids are non-sequential random tokens', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'A' });
  const b = joinRoom(room, { name: 'B' });
  assert.notEqual(a.id, 'p1');
  assert.notEqual(b.id, 'p2');
  assert.ok(a.id.length >= 6);
});

test('undo: play/discard/hint push snapshots; annotate does not', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    assert.equal(room.undoStack.length, 1);
    await applyAction(room, bob.id, { type: 'annotate', cardId: room.state.players[1].hand[0].id, note: 'hmm' });
    assert.equal(room.undoStack.length, 1);
  });
});

test('undo: only the player who took the last action can undo it', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    await assert.rejects(() => undoLast(room, bob.id), GameError);
    await undoLast(room, alice.id);
    assert.equal(room.state.currentPlayer, 0, 'turn restored to alice');
    assert.equal(room.undoStack.length, 0);
  });
});

test('undo: sequential undos walk back across players', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
    assert.equal(room.undoStack.length, 2);
    await undoLast(room, bob.id);
    assert.equal(room.state.currentPlayer, 1, 'bob is current again');
    await undoLast(room, alice.id);
    assert.equal(room.state.currentPlayer, 0, 'alice is current again');
    assert.equal(room.undoStack.length, 0);
  });
});

test('undo: undone log entries stay in the log, struck out', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 4;
    const before = room.state.log.length;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    const added = room.state.log.slice(before);
    assert.ok(added.length >= 1, 'discard logged');
    await undoLast(room, alice.id);
    const tail = room.state.log.slice(before);
    assert.equal(tail.length, added.length, 'undone entries kept');
    assert.ok(tail.every((e) => e.undone === true), 'all flagged undone');
    assert.deepEqual(
      tail.map((e) => e.type),
      added.map((e) => e.type),
      'same entries, same order',
    );
    // Tokens and hand are rolled back even though the log remembers.
    assert.equal(room.state.hintTokens, 4);
  });
});

test('undo: the replacement action gets a fresh seq even though it reuses the same turn number', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    const undoneEntry = room.state.log.findLast((e) => e.type === 'discard');
    await undoLast(room, alice.id);
    const struckEntry = room.state.log.findLast((e) => e.type === 'discard');
    assert.equal(struckEntry.undone, true);
    assert.equal(struckEntry.seq, undoneEntry.seq, 'the struck copy keeps its original seq');

    // Alice plays instead this time — the replacement action lands on the
    // exact same turn number as the undone discard, but must still get a
    // higher seq, or a client's animation-dedupe (keyed on the log) would
    // wrongly treat it as already shown. This is the regression this test
    // guards: before seq existed, turn was the only signal and it repeats.
    await applyAction(room, alice.id, { type: 'play', cardIndex: 0 });
    const replacement = room.state.log.find((e) => e.type === 'play');
    assert.equal(replacement.turn, undoneEntry.turn, 'same turn number as the undone action');
    assert.ok(replacement.seq > undoneEntry.seq, 'but a strictly higher seq');
  });
});

test('undo: chained undos across players keep all struck entries in order', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    const before = room.state.log.length;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    const aliceCount = room.state.log.length - before;
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
    await undoLast(room, bob.id);
    await undoLast(room, alice.id);
    const tail = room.state.log.slice(before);
    assert.ok(tail.every((e) => e.undone === true));
    // Alice's struck entries come first, then Bob's.
    assert.equal(tail[0].playerIndex ?? tail[0].fromIndex, 0);
    assert.equal(tail[aliceCount].playerIndex ?? tail[aliceCount].fromIndex, 1);
  });
});

test('undo: resume replays struck log entries identically', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    // Spend a token legitimately (recorded in the save) so discarding is legal.
    const bobN = room.state.players[1].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
    await undoLast(room, bob.id);
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 1 });
    // Annotations reference card ids; they must survive the resume too.
    await applyAction(room, bob.id, {
      type: 'annotate', cardId: room.state.players[1].hand[2].id, note: 'save me',
    });
    const resumed = await resumeRoom(room.savePath);
    assert.deepEqual(resumed.state.log, room.state.log, 'resumed log matches live log');
    assert.ok(room.state.log.some((e) => e.undone), 'struck entry present');
    assert.equal(
      resumed.state.players[1].hand[2].annotations.note,
      'save me',
      'annotation lands on the same card after resume',
    );
  });
});

test('requestUndo: toggles, gates on ownership, clears on action and undo', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    // Nothing to undo yet.
    assert.throws(() => requestUndo(room, bob.id), GameError);
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    // Alice owns the undo — she can't request it from herself.
    assert.throws(() => requestUndo(room, alice.id), GameError);
    requestUndo(room, bob.id);
    let v = viewFor(room, alice.id);
    assert.equal(v.canUndo, true);
    assert.deepEqual(v.undoRequests, ['Bob']);
    assert.equal(viewFor(room, bob.id).undoRequestedByMe, true);
    assert.equal(viewFor(room, bob.id).canRequestUndo, true);
    assert.equal(viewFor(room, alice.id).canRequestUndo, false);
    // Toggle off and back on.
    requestUndo(room, bob.id);
    assert.deepEqual(viewFor(room, alice.id).undoRequests, []);
    requestUndo(room, bob.id);
    // The requested undo clears the request.
    await undoLast(room, alice.id);
    assert.deepEqual(viewFor(room, alice.id).undoRequests, []);
    // A fresh action also clears any pending requests.
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    requestUndo(room, bob.id);
    assert.equal(room.undoRequests.size, 1);
    await undoLast(room, alice.id);
    assert.equal(room.undoRequests.size, 0);
  });
});

test('undo: starting a new game clears the undo stack', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    room.state.status = 'finished';
    await startGame(room, alice.id, { seed: 7 });
    assert.equal(room.undoStack.length, 0);
  });
});

test('undo: viewFor exposes canUndo only to the player at the top of the stack', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    assert.equal(viewFor(room, alice.id).canUndo, true);
    assert.equal(viewFor(room, bob.id).canUndo, false);
  });
});

test('undo: failed action does not leave a stale snapshot behind', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 8;
    await assert.rejects(applyAction(room, alice.id, { type: 'discard', cardIndex: 0 }));
    assert.equal(room.undoStack.length, 0);
  });
});

function buildVariantDeckStrings(variantId) {
  // Mimic buildDeck without importing it: enumerate suits in their declared
  // distribution order. The actual order doesn't matter for these tests as
  // long as it's a valid multiset.
  const variants = {
    simple: [
      ['red', [1, 1, 1, 2, 2, 3, 3, 4, 4, 5]],
      ['yellow', [1, 1, 1, 2, 2, 3, 3, 4, 4, 5]],
      ['green', [1, 1, 1, 2, 2, 3, 3, 4, 4, 5]],
      ['blue', [1, 1, 1, 2, 2, 3, 3, 4, 4, 5]],
      ['white', [1, 1, 1, 2, 2, 3, 3, 4, 4, 5]],
    ],
  };
  const out = [];
  for (const [color, dist] of variants[variantId]) {
    for (const n of dist) out.push(`${color}_${n}`);
  }
  return out;
}

test('importDeck: host can import a valid deck; clears after start', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const a = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    const deck = buildVariantDeckStrings('simple');
    importDeck(room, a.id, deck);
    assert.equal(room.importedDeck.length, 50);
    await startGame(room, a.id, {});
    assert.equal(room.importedDeck, null, 'imported deck is one-shot');
    // The actual game state should reflect the imported draw order.
    assert.deepEqual(room.state.initialDeckCards, deck);
  });
});

test('importDeck: rejects a deck with wrong size for the variant', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  joinRoom(room, { name: 'Bob' });
  assert.throws(() => importDeck(room, a.id, ['red_1']), /doesn't match variant/);
});

test('importDeck: rejects a deck with the wrong multiset for the variant', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  joinRoom(room, { name: 'Bob' });
  const deck = buildVariantDeckStrings('simple');
  // Swap a red_1 for an extra red_5 (now wrong multiset).
  const i = deck.indexOf('red_1');
  deck[i] = 'red_5';
  assert.throws(() => importDeck(room, a.id, deck), /expects/);
});

test('importDeck: rejects when the host changes variant after import', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const a = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    importDeck(room, a.id, buildVariantDeckStrings('simple'));
    configureRoom(room, a.id, { variantId: 'rainbow' });
    await assert.rejects(() => startGame(room, a.id, {}), /Imported deck doesn't fit/);
    assert.equal(room.importedDeck.length, 50, 'import stays until cleared or accepted');
  });
});

test('importDeck: clearImportedDeck removes the pending import', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  joinRoom(room, { name: 'Bob' });
  importDeck(room, a.id, buildVariantDeckStrings('simple'));
  clearImportedDeck(room, a.id);
  assert.equal(room.importedDeck, null);
});

test('importDeck: non-host cannot import or clear', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  const b = joinRoom(room, { name: 'Bob' });
  assert.throws(() => importDeck(room, b.id, buildVariantDeckStrings('simple')), GameError);
  importDeck(room, a.id, buildVariantDeckStrings('simple'));
  assert.throws(() => clearImportedDeck(room, b.id), GameError);
});

test('exportDeckOrder of an imported game round-trips the imported list', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const a = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    const deck = buildVariantDeckStrings('simple');
    importDeck(room, a.id, deck);
    await startGame(room, a.id, {});
    const out = exportDeckOrder(room.state);
    assert.deepEqual(out.cards, deck);
  });
});

test('movePlayer: host can reorder the player list in the lobby', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  const b = joinRoom(room, { name: 'Bob' });
  const c = joinRoom(room, { name: 'Carol' });
  // a is host (first to join).
  movePlayer(room, a.id, c.id, 'up'); // Carol moves above Bob
  assert.deepEqual(room.players.map((p) => p.name), ['Alice', 'Carol', 'Bob']);
  movePlayer(room, a.id, a.id, 'down'); // Alice moves below Carol
  assert.deepEqual(room.players.map((p) => p.name), ['Carol', 'Alice', 'Bob']);
});

test('movePlayer: moving past an edge is a silent no-op', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  const b = joinRoom(room, { name: 'Bob' });
  movePlayer(room, a.id, a.id, 'up'); // already at top
  assert.deepEqual(room.players.map((p) => p.name), ['Alice', 'Bob']);
  movePlayer(room, a.id, b.id, 'down'); // already at bottom
  assert.deepEqual(room.players.map((p) => p.name), ['Alice', 'Bob']);
});

test('movePlayer: non-host cannot reorder', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  const b = joinRoom(room, { name: 'Bob' });
  assert.throws(() => movePlayer(room, b.id, a.id, 'down'), GameError);
});

test('movePlayer: refused after the game has started', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    assert.throws(() => movePlayer(room, alice.id, bob.id, 'up'), GameError);
  });
});

test('returnToLobby: host can drop back to lobby after a finished game', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    assert.equal(room.state.status, 'finished');
    returnToLobby(room, alice.id);
    assert.equal(room.phase, 'lobby');
    assert.equal(room.state, null);
    assert.equal(room.savePath, null);
    assert.equal(room.undoStack.length, 0);
    assert.equal(room.players.length, 2, 'players stay in the room');
  });
});

test('returnToLobby: non-host cannot trigger', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    assert.throws(() => returnToLobby(room, bob.id), GameError);
    assert.equal(room.phase, 'playing');
  });
});

test('returnToLobby: refused while the game is still in progress', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    assert.throws(() => returnToLobby(room, alice.id), GameError);
  });
});

test('startGame stores the seed and lets it propagate to view when finished', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    assert.equal(room.state.seed, 12345);
    room.state.status = 'finished';
    const v = viewFor(room, alice.id);
    assert.equal(v.seed, 12345);
  });
});

test('save: starting a game creates a JSONL file with a header line', async () => {
  await withTmpSaveDir(async (dir) => {
    const { room } = await setupRoom();
    assert.ok(room.savePath, 'savePath set');
    assert.ok(room.savePath.startsWith(dir), 'save lives under tmp dir');
    const raw = await fs.readFile(room.savePath, 'utf8');
    const [headerLine] = raw.split('\n');
    const header = JSON.parse(headerLine);
    assert.equal(header.kind, 'start');
    assert.equal(header.seed, 12345);
    assert.equal(header.variantId, 'simple');
    assert.equal(header.hostId, room.hostId);
    assert.deepEqual(
      header.players.map((p) => p.name),
      ['Alice', 'Bob'],
    );
  });
});

test('save: each action appends an event line', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    const raw = await fs.readFile(room.savePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'header + 1 action');
    const ev = JSON.parse(lines[1]);
    assert.equal(ev.kind, 'action');
    assert.equal(ev.playerId, alice.id);
    assert.equal(ev.action.type, 'discard');
  });
});

test('save: deleteSave moves the file to trash/ and it stops being listed', async () => {
  await withTmpSaveDir(async (dir) => {
    const { room } = await setupRoom();
    const basename = path.basename(room.savePath);
    assert.equal((await listIncompleteSaves()).length, 1);
    const dest = await deleteSave(basename);
    assert.equal(dest, path.join(dir, 'trash', basename));
    const trashed = await fs.readFile(dest, 'utf8');
    assert.ok(trashed.includes('"kind":"start"'), 'file content preserved in trash');
    assert.equal((await listIncompleteSaves()).length, 0, 'no longer listed');
    await assert.rejects(() => deleteSave(basename), /ENOENT/, 'second delete fails cleanly');
  });
});

test('save: deleteSave rejects path traversal and non-save filenames', async () => {
  await withTmpSaveDir(async () => {
    await assert.rejects(() => deleteSave('../escape.jsonl'), /Bad save filename/);
    await assert.rejects(() => deleteSave('.hidden.jsonl'), /Bad save filename/);
    await assert.rejects(() => deleteSave('notes.txt'), /Bad save filename/);
    await assert.rejects(() => deleteSave(''), /Bad save filename/);
  });
});

test('library: loadSave maxEvents truncates; totalEvents counts everything', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
    const aliceN = room.state.players[0].hand[0].number;
    await applyAction(room, bob.id, { type: 'annotate', cardId: room.state.players[1].hand[0].id, note: 'x' });
    const partial = await loadSave(room.savePath, { maxEvents: 2 });
    assert.equal(partial.totalEvents, 3);
    assert.equal(partial.events.length, 2);
    assert.equal(partial.state.turn, 2, 'state reflects only the applied events');
    const full = await loadSave(room.savePath);
    assert.equal(full.totalEvents, 3);
    assert.equal(full.events.length, 3);
  });
});

test('replay: lastAppliedAt tracks the newest applied event, for elapsed-time display', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
    const atStart = await loadSave(room.savePath, { maxEvents: 0 });
    assert.equal(atStart.lastAppliedAt, null, 'no event applied — replay falls back to startedAt');
    const partial = await loadSave(room.savePath, { maxEvents: 1 });
    const full = await loadSave(room.savePath);
    const eventTime = (i) => Date.parse(full.events[i].t);
    assert.equal(partial.lastAppliedAt, eventTime(0));
    assert.equal(full.lastAppliedAt, eventTime(1));
    assert.ok(full.lastAppliedAt >= full.state.startedAt);
  });
});

test('library: listLibrary summarizes score, status, players; hides live seeds', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    let lib = await listLibrary();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].status, 'in-progress');
    assert.equal(lib[0].seed, null, 'seed hidden while unfinished');
    assert.deepEqual(lib[0].playerNames, ['Alice', 'Bob']);
    assert.equal(lib[0].moves, 1);
    // Finish by abandon votes → seed becomes visible, status reflects reason.
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    lib = await listLibrary();
    assert.equal(lib[0].status, 'abandoned');
    assert.equal(lib[0].seed, 12345);
    assert.equal(typeof lib[0].score, 'number');
  });
});

test('library: tags round-trip and vanish when the save is deleted', async () => {
  await withTmpSaveDir(async () => {
    const { room } = await setupRoom();
    const basename = path.basename(room.savePath);
    await setSaveTags(basename, [' epic ', 'epic', 'close call', '']);
    assert.deepEqual((await listLibrary())[0].tags, ['epic', 'close call']);
    room.savePath = null; // release the file so deleteSave's caller may act
    await deleteSave(basename);
    assert.deepEqual(await readAllTags(), {}, 'tags entry dropped');
  });
});

test('branch: copies header + first N events into a fresh resumable save', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
    const original = await fs.readFile(room.savePath, 'utf8');

    const branched = await branchSave(path.basename(room.savePath), 1);
    const resumed = await resumeRoom(branched);
    assert.equal(resumed.state.turn, 1, 'branched game sits after the first event');
    assert.equal(resumed.players.length, 2);
    assert.ok(resumed.players.every((p) => !p.online));
    assert.equal(await fs.readFile(room.savePath, 'utf8'), original, 'original untouched');

    // The branch is a normal save: playing continues in its own file.
    const carol = resumed.players[1];
    await applyAction(resumed, carol.id, { type: 'discard', cardIndex: 0 });
    const branchedLines = (await fs.readFile(branched, 'utf8')).split('\n').filter(Boolean);
    assert.equal(branchedLines.length, 3, 'header + copied event + new action');
  });
});

test('resume: a partially-played game can be reconstructed from its save', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    const aliceN = room.state.players[0].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'hint', toPlayerIndex: 0, hintType: 'number', value: aliceN });
    await renamePlayer(room, alice.id, 'Alicia');
    const bobN2 = room.state.players[1].hand[1].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN2 });

    const savePath = room.savePath;
    const liveTurn = room.state.turn;
    const liveScore = Object.values(room.state.playedPiles).reduce((s, p) => s + p.length, 0);
    const liveHints = room.state.hintTokens;

    const resumed = await resumeRoom(savePath);
    assert.equal(resumed.phase, 'playing');
    assert.equal(resumed.hostId, alice.id);
    assert.equal(resumed.state.turn, liveTurn);
    assert.equal(resumed.state.hintTokens, liveHints);
    assert.deepEqual(
      resumed.state.players.map((p) => p.name),
      ['Alicia', 'Bob'],
      'rename event replayed',
    );
    const resumedScore = Object.values(resumed.state.playedPiles).reduce((s, p) => s + p.length, 0);
    assert.equal(resumedScore, liveScore);
    assert.equal(resumed.undoStack.length, 3, 'undo snapshots reconstructed');
    assert.ok(resumed.players.every((p) => p.online === false));
  });
});

test('resume: undo events in the save are honored on replay', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    const aliceN = room.state.players[0].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'hint', toPlayerIndex: 0, hintType: 'number', value: aliceN });
    await undoLast(room, bob.id);
    const liveTurn = room.state.turn;
    const liveCurrent = room.state.currentPlayer;

    const resumed = await resumeRoom(room.savePath);
    assert.equal(resumed.state.turn, liveTurn);
    assert.equal(resumed.state.currentPlayer, liveCurrent);
    assert.equal(resumed.undoStack.length, 1, 'one snapshot remains after undo replay');
  });
});

test('resume: continuation after a natural game-end (e.g. undo the final fuse) is persisted', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    // With seed 12345 + 2 players, three misplays of card 0 walk fuses 3→0.
    await applyAction(room, alice.id, { type: 'play', cardIndex: 0 });
    await applyAction(room, bob.id, { type: 'play', cardIndex: 0 });
    await applyAction(room, alice.id, { type: 'play', cardIndex: 0 });
    assert.equal(room.state.status, 'finished');
    assert.equal(room.state.endReason, 'fuses');
    assert.ok(room.savePath, 'savePath retained after natural end so undo can continue');

    await undoLast(room, alice.id);
    assert.equal(room.state.status, 'playing');

    // Alice hints instead of misplaying. Persisted past the prior 'end' line.
    const bobN = room.state.players[1].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });

    const raw = await fs.readFile(room.savePath, 'utf8');
    const kinds = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);
    assert.deepEqual(
      kinds,
      ['start', 'action', 'action', 'action', 'end', 'undo', 'action'],
      'file has events after the end marker',
    );

    const liveTurn = room.state.turn;
    const liveFuses = room.state.fuseTokens;
    const resumed = await resumeRoom(room.savePath);
    assert.equal(resumed.state.status, 'playing');
    assert.equal(resumed.state.turn, liveTurn);
    assert.equal(resumed.state.fuseTokens, liveFuses);
  });
});

test('resume: refuses a save that has already ended', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    const files = await fs.readdir(process.env.HANABI_SAVED_DIR);
    const filePath = path.join(process.env.HANABI_SAVED_DIR, files[0]);
    await assert.rejects(() => resumeRoom(filePath), /already ended/);
  });
});

test('spectate: disallowed by default; enabling it via configure lets anyone watch', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    assert.throws(() => joinSpectator(room, { name: 'Watcher' }), /not allowed/);
    configureRoom(room, alice.id, { allowSpectators: true });
    const watcher = joinSpectator(room, { name: 'Watcher' });
    assert.ok(watcher.id);
    assert.equal(watcher.name, 'Watcher');
    assert.equal(room.spectators.size, 1);
  });
});

test('spectate: configureRoom validates allowSpectators as boolean', () => {
  const room = createRoom();
  const alice = joinRoom(room, { name: 'Alice' });
  assert.throws(() => configureRoom(room, alice.id, { allowSpectators: 'yes' }), GameError);
});

test('spectate: a spectator gets an omniscient, read-only view during play', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    const bob = joinRoom(room, { name: 'Bob' });
    configureRoom(room, alice.id, { allowSpectators: true });
    await startGame(room, alice.id, { seed: 12345 });
    const watcher = joinSpectator(room, { name: 'Watcher' });

    const v = viewFor(room, watcher.id);
    assert.equal(v.isSpectator, true);
    assert.equal(v.viewerIndex, -1, 'omniscient viewer index, like replay');
    // Every hand is fully revealed — including what would be "your own" hand
    // for a seated player.
    for (const p of v.players) {
      for (const c of p.hand) {
        assert.ok(c.color, `card should be revealed: ${JSON.stringify(c)}`);
        assert.ok(c.number);
      }
    }
    // No seat means no undo/abandon rights.
    assert.equal(v.canUndo, false);
    assert.equal(v.canRequestUndo, false);
    assert.equal(v.abandonVotes.me, false);
    // The spectator list is visible to everyone in the room.
    assert.deepEqual(v.spectators.map((s) => s.name), ['Watcher']);
    assert.deepEqual(viewFor(room, alice.id).spectators.map((s) => s.name), ['Watcher']);
  });
});

test('spectate: cannot act — every seat-gated action rejects a spectator id', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    const bob = joinRoom(room, { name: 'Bob' });
    configureRoom(room, alice.id, { allowSpectators: true });
    await startGame(room, alice.id, { seed: 12345 });
    const watcher = joinSpectator(room, { name: 'Watcher' });

    await assert.rejects(
      () => applyAction(room, watcher.id, { type: 'discard', cardIndex: 0 }),
      GameError,
      'spectator id is not a seat, so applyAction rejects it the same way an unknown id would',
    );
    await assert.rejects(() => voteAbandon(room, watcher.id), GameError);
    await assert.rejects(() => undoLast(room, watcher.id), GameError);
    assert.throws(() => requestUndo(room, watcher.id), GameError);
  });
});

test('spectate: can join and watch a room still in its pre-game lobby', () => {
  const room = createRoom();
  const alice = joinRoom(room, { name: 'Alice' });
  configureRoom(room, alice.id, { allowSpectators: true });
  const watcher = joinSpectator(room, { name: 'Watcher' });
  const v = viewFor(room, watcher.id);
  assert.equal(v.status, 'lobby');
  assert.equal(v.isSpectator, true);
  assert.deepEqual(v.spectators.map((s) => s.name), ['Watcher']);
});

test('spectate: leaveSpectator removes them; joinSpectator without a name falls back to the id', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    configureRoom(room, alice.id, { allowSpectators: true });
    const watcher = joinSpectator(room, {});
    assert.equal(watcher.name, watcher.id, 'falls back to id when no name given');
    assert.equal(room.spectators.size, 1);
    leaveSpectator(room, watcher.id);
    assert.equal(room.spectators.size, 0);
    // Idempotent — leaving twice (e.g. a duplicate close event) is a no-op.
    leaveSpectator(room, watcher.id);
    assert.equal(room.spectators.size, 0);
  });
});

test('spectate: resumeRoom defaults allowSpectators back off', async () => {
  await withTmpSaveDir(async () => {
    const { room } = await setupRoom();
    const resumed = await resumeRoom(room.savePath);
    assert.equal(resumed.options.allowSpectators, false);
  });
});
