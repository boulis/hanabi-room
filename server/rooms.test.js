import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addRoom,
  allRooms,
  createRoom,
  deleteRoom,
  getRoom,
  listRooms,
  summarizeRoom,
} from './rooms.js';
import { joinRoom, startGame, applyAction } from './room.js';

// Best-effort isolation: every test purges the registry before running.
function purge() {
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

test('createRoom returns a fresh room with a 6-hex id and default name', () => {
  purge();
  const r = createRoom('My table');
  assert.match(r.id, /^[0-9a-f]{6}$/);
  assert.equal(r.name, 'My table');
  assert.ok(r.createdAt);
  assert.equal(getRoom(r.id), r);
});

test('createRoom trims and caps user-supplied names, and falls back to Room <id>', () => {
  purge();
  const r = createRoom('   ');
  assert.equal(r.name, `Room ${r.id}`);
  const long = createRoom('x'.repeat(60));
  assert.equal(long.name.length, 40);
});

test('listRooms summarises players, status, and orders newest-first', async () => {
  purge();
  const r1 = createRoom('First');
  // Force createdAt so the sort is deterministic.
  r1.createdAt = 1000;
  const r2 = createRoom('Second');
  r2.createdAt = 2000;
  joinRoom(r1, { name: 'Alice' });
  joinRoom(r1, { name: 'Bob' });
  const list = listRooms();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, r2.id, 'newest first');
  const r1Summary = list.find((r) => r.id === r1.id);
  assert.equal(r1Summary.status, 'lobby');
  assert.deepEqual(r1Summary.players.map((p) => p.name), ['Alice', 'Bob']);
});

test('summarizeRoom reflects playing/finished status from state', async () => {
  await withTmpSaveDir(async () => {
    purge();
    const r = createRoom('Play');
    const alice = joinRoom(r, { name: 'Alice' });
    joinRoom(r, { name: 'Bob' });
    await startGame(r, alice.id, { seed: 1 });
    assert.equal(summarizeRoom(r).status, 'playing');
    r.state.status = 'finished';
    assert.equal(summarizeRoom(r).status, 'finished');
  });
});

test('addRoom accepts an externally-built room (e.g. from a resumed save)', () => {
  purge();
  const r = { players: [], options: {}, players: [], id: null, name: null, createdAt: null, hostId: null };
  const added = addRoom(r, 'Imported');
  assert.match(added.id, /^[0-9a-f]{6}$/);
  assert.equal(added.name, 'Imported');
  assert.equal(getRoom(added.id), added);
});

test('deleteRoom removes a room and getRoom returns undefined thereafter', () => {
  purge();
  const r = createRoom('Gone');
  const id = r.id;
  assert.ok(deleteRoom(id));
  assert.equal(getRoom(id), undefined);
  assert.equal(deleteRoom(id), false, 'second delete is a no-op');
});

test('rooms are isolated: actions in one do not affect another', async () => {
  await withTmpSaveDir(async () => {
    purge();
    const r1 = createRoom('R1');
    const alice = joinRoom(r1, { name: 'Alice' });
    joinRoom(r1, { name: 'Bob' });
    await startGame(r1, alice.id, { seed: 12345 });

    const r2 = createRoom('R2');
    const carol = joinRoom(r2, { name: 'Carol' });
    joinRoom(r2, { name: 'Dan' });
    await startGame(r2, carol.id, { seed: 12345 });

    // Same seed → same starting hands; the game states are still separate objects.
    assert.notEqual(r1.state, r2.state);
    // Apply a hint in r1; r2 is untouched.
    const bobN = r1.state.players[1].hand[0].number;
    await applyAction(r1, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    assert.equal(r1.state.hintTokens, 7);
    assert.equal(r2.state.hintTokens, 8, 'other room is untouched');
  });
});
