import test from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from './rules.js';
import {
  createRoom,
  joinRoom,
  startGame,
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

test('startGame stores the seed and lets it propagate to view when finished', () => {
  const { room, alice } = setupRoom();
  assert.equal(room.state.seed, 12345);
  room.state.status = 'finished';
  const v = viewFor(room, alice.id);
  assert.equal(v.seed, 12345);
});
