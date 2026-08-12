import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInitialState } from './game.js';
import { branchSave, listSaves, loadSave, openSave } from './savedGame.js';

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

function stateFor(seed, variantId = 'simple') {
  return createInitialState({
    variantId,
    endRule: 'lax',
    seed,
    players: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }],
  });
}

// The save name is the start time to the millisecond plus the variant, so two
// games opened in the same millisecond in the same variant want the same file.
// Freezing the clock makes that certain rather than a matter of luck. Both
// readings of "now" are frozen — `Date.now()` and a bare `new Date()` — while
// an explicit `new Date(ms)` keeps working, since that is how the naming
// retry walks forward to a free millisecond.
const FROZEN_MS = 1_770_000_000_000;

async function withFrozenClock(fn) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [FROZEN_MS]));
    }

    static now() {
      return FROZEN_MS;
    }
  };
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

test('saves: two games opened in the same millisecond get separate files', async () => {
  await withTmpSaveDir(async () => {
    const [first, second] = await withFrozenClock(async () => [
      await openSave(stateFor(101), 'a'),
      await openSave(stateFor(202), 'a'),
    ]);
    assert.notEqual(first, second, 'the second game must not take the first one\'s name');
    assert.equal((await listSaves()).length, 2);
    // And the first game's header is still its own — the danger here isn't a
    // clash, it's the second write silently truncating a game in progress.
    assert.equal((await loadSave(first)).header.seed, 101);
    assert.equal((await loadSave(second)).header.seed, 202);
  });
});

test('saves: a branch taken in the same millisecond gets its own file too', async () => {
  await withTmpSaveDir(async () => {
    const origin = await openSave(stateFor(303), 'a');
    const base = path.basename(origin);
    const [a, b] = await withFrozenClock(async () => [
      await branchSave(base, 0),
      await branchSave(base, 0),
    ]);
    assert.notEqual(a, b);
    assert.equal((await loadSave(a)).header.seed, 303);
    assert.equal((await loadSave(b)).header.seed, 303);
    assert.equal((await loadSave(origin)).header.seed, 303, 'the original is untouched');
  });
});
