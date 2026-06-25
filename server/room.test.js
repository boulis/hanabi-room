import test from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from './rules.js';
import {
  applyAction,
  createRoom,
  joinRoom,
  startGame,
  undoLast,
  viewFor,
  voteAbandon,
} from './room.js';

function setupRoom() {
  const room = createRoom();
  const alice = joinRoom(room, { name: 'Alice' });
  const bob = joinRoom(room, { name: 'Bob' });
  startGame(room, alice.id, { seed: 12345 });
  return { room, alice, bob };
}

test('abandon: single vote does not abandon the game', () => {
  const { room, alice } = setupRoom();
  const result = voteAbandon(room, alice.id);
  assert.equal(result.abandoned, false);
  assert.equal(room.phase, 'playing');
  assert.equal(room.abandonVotes.size, 1);
});

test('abandon: two votes returns the room to lobby', () => {
  const { room, alice, bob } = setupRoom();
  voteAbandon(room, alice.id);
  const result = voteAbandon(room, bob.id);
  assert.equal(result.abandoned, true);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.state, null);
  assert.equal(room.abandonVotes.size, 0);
});

test('abandon: same player voting twice toggles their vote', () => {
  const { room, alice } = setupRoom();
  voteAbandon(room, alice.id);
  assert.equal(room.abandonVotes.size, 1);
  voteAbandon(room, alice.id);
  assert.equal(room.abandonVotes.size, 0);
  assert.equal(room.phase, 'playing');
});

test('abandon: rejected outside a playing game', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  assert.throws(() => voteAbandon(room, a.id), GameError);
});

test('abandon: votes reset when a new game starts', () => {
  const { room, alice, bob } = setupRoom();
  voteAbandon(room, alice.id);
  assert.equal(room.abandonVotes.size, 1);
  voteAbandon(room, bob.id);
  startGame(room, alice.id, { seed: 99 });
  assert.equal(room.abandonVotes.size, 0);
});

test('viewFor exposes abandonVotes count and self-vote flag', () => {
  const { room, alice, bob } = setupRoom();
  voteAbandon(room, alice.id);
  const aliceView = viewFor(room, alice.id);
  assert.equal(aliceView.abandonVotes.count, 1);
  assert.equal(aliceView.abandonVotes.threshold, 2);
  assert.equal(aliceView.abandonVotes.me, true);
  const bobView = viewFor(room, bob.id);
  assert.equal(bobView.abandonVotes.me, false);
});

test('join: a second connection sharing an id reuses the same seat (duplicate tab)', () => {
  const room = createRoom();
  const first = joinRoom(room, { name: 'Alice' });
  const second = joinRoom(room, { name: 'Alice', playerId: first.id });
  assert.equal(second.id, first.id, 'duplicate tab takes the same seat');
  assert.equal(room.players.length, 1);
  assert.equal(room.hostId, first.id);
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
  const { room, alice, bob } = setupRoom();
  // Force a hand position we know we can act on.
  room.state.hintTokens = 4;
  await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
  assert.equal(room.undoStack.length, 1);
  const aliceCardId = room.state.players[1].hand[0].id; // bob's hand now visible to whoever
  // Annotate by bob; should not push a snapshot.
  await applyAction(room, bob.id, { type: 'annotate', cardId: room.state.players[1].hand[0].id, note: 'hmm' });
  assert.equal(room.undoStack.length, 1);
});

test('undo: only the player who took the last action can undo it', async () => {
  const { room, alice, bob } = setupRoom();
  room.state.hintTokens = 4;
  await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
  assert.throws(() => undoLast(room, bob.id), GameError);
  undoLast(room, alice.id);
  assert.equal(room.state.currentPlayer, 0, 'turn restored to alice');
  assert.equal(room.undoStack.length, 0);
});

test('undo: sequential undos walk back across players', async () => {
  const { room, alice, bob } = setupRoom();
  room.state.hintTokens = 4;
  await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
  await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
  assert.equal(room.undoStack.length, 2);
  // Bob undoes; now alice can undo because she is back on top.
  undoLast(room, bob.id);
  assert.equal(room.state.currentPlayer, 1, 'bob is current again');
  undoLast(room, alice.id);
  assert.equal(room.state.currentPlayer, 0, 'alice is current again');
  assert.equal(room.undoStack.length, 0);
});

test('undo: starting a new game clears the undo stack', async () => {
  const { room, alice } = setupRoom();
  room.state.hintTokens = 4;
  await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
  room.state.status = 'finished';
  startGame(room, alice.id, { seed: 7 });
  assert.equal(room.undoStack.length, 0);
});

test('undo: viewFor exposes canUndo only to the player at the top of the stack', async () => {
  const { room, alice, bob } = setupRoom();
  room.state.hintTokens = 4;
  await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
  assert.equal(viewFor(room, alice.id).canUndo, true);
  assert.equal(viewFor(room, bob.id).canUndo, false);
});

test('undo: failed action does not leave a stale snapshot behind', async () => {
  const { room, alice } = setupRoom();
  room.state.hintTokens = 8;
  await assert.rejects(applyAction(room, alice.id, { type: 'discard', cardIndex: 0 }));
  assert.equal(room.undoStack.length, 0);
});

test('startGame stores the seed and lets it propagate to view when finished', () => {
  const { room, alice } = setupRoom();
  assert.equal(room.state.seed, 12345);
  room.state.status = 'finished';
  const v = viewFor(room, alice.id);
  assert.equal(v.seed, 12345);
});
