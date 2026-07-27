import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BOT_SCORE_VERSION, botScoreForState, simulateBotGame } from './botScore.js';
import { createInitialState } from './game.js';
import { applyAction, createRoom, joinRoom, startGame, viewFor, voteAbandon } from './room.js';
import {
  backfillBotScores,
  botScoreFor,
  gameDetail,
  deleteSave,
  listLibrary,
  readAllBotScores,
  setBotScore,
} from './savedGame.js';

async function withTmpSaveDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanabi-par-'));
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

// Two seats, a fixed seed, and the game driven to its end by abandon votes —
// enough to produce a finished save without playing a real game out.
async function setupRoom({ seed = 12345, variantId = 'simple' } = {}) {
  const room = createRoom();
  const alice = joinRoom(room, { name: 'Alice' });
  const bob = joinRoom(room, { name: 'Bob' });
  room.options.variantId = variantId;
  await startGame(room, alice.id, { seed });
  return { room, alice, bob };
}

test('par: the same deck always yields the same score (pure and deterministic)', () => {
  const config = { variantId: 'simple', endRule: 'lax', playerCount: 3, seed: 4242 };
  const a = simulateBotGame(config);
  const b = simulateBotGame(config);
  assert.deepEqual(a, b);
  assert.equal(a.version, BOT_SCORE_VERSION);
  assert.equal(a.maxScore, 25);
  assert.ok(a.score >= 0 && a.score <= 25);
  assert.equal(a.playerCount, 3);
  assert.ok(a.moves > 0);
});

test('par: an explicit draw order scores the same as the seed that shuffles it', () => {
  const seeded = createInitialState({
    variantId: 'rainbowCritical', endRule: 'lax', seed: 777,
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  });
  const fromSeed = simulateBotGame({
    variantId: 'rainbowCritical', endRule: 'lax', playerCount: 2, seed: 777,
  });
  const fromDeck = simulateBotGame({
    variantId: 'rainbowCritical', endRule: 'lax', playerCount: 2,
    deckCards: seeded.initialDeckCards,
  });
  assert.deepEqual(fromDeck, fromSeed);
  // …and the state helper takes the deck off the state, so it agrees too.
  assert.deepEqual(botScoreForState(seeded), fromSeed);
});

test('par: the player count is part of the deal, so it moves par', () => {
  const two = simulateBotGame({ variantId: 'simple', endRule: 'lax', playerCount: 2, seed: 99 });
  const four = simulateBotGame({ variantId: 'simple', endRule: 'lax', playerCount: 4, seed: 99 });
  assert.equal(two.playerCount, 2);
  assert.equal(four.playerCount, 4);
  // Different hands out of the same deck — the games are simply not the same.
  assert.notDeepEqual(
    { score: two.score, moves: two.moves },
    { score: four.score, moves: four.moves },
  );
});

test('par: a finished game records its deck par on the room and in the sidecar', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    assert.equal(viewFor(room, alice.id).botScore, null, 'nothing while the game is on');
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);

    const par = room.botScore;
    assert.ok(par, 'par computed when the game ended');
    assert.equal(par.version, BOT_SCORE_VERSION);
    assert.deepEqual(viewFor(room, alice.id).botScore, par, 'and it rides in the view');

    const stored = (await readAllBotScores())[path.basename(room.savePath)];
    assert.equal(stored.score, par.score);
    assert.ok(stored.computedAt, 'stamped with when it was computed');
    // Same deck, same answer — the save's header is enough to reproduce it.
    const recomputed = await botScoreFor(path.basename(room.savePath));
    assert.equal(recomputed.score, par.score);
  });
});

test('par: the library carries it for finished games and withholds it while playing', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await backfillBotScores();
    let lib = await listLibrary();
    assert.equal(lib[0].status, 'in-progress');
    assert.equal(lib[0].botScore, null, 'par says something about a deck still in play');
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    lib = await listLibrary();
    assert.equal(lib[0].botScore.score, room.botScore.score);
  });
});

test('par: a stale entry (older brain) is recomputed, a current one is kept', async () => {
  await withTmpSaveDir(async () => {
    const { room } = await setupRoom();
    const basename = path.basename(room.savePath);
    await setBotScore(basename, { version: 'ancient', score: -1, maxScore: 25 });
    const fresh = await botScoreFor(basename);
    assert.equal(fresh.version, BOT_SCORE_VERSION);
    assert.notEqual(fresh.score, -1, 'stale par replaced');

    // A current entry is returned untouched — note the deliberately wrong
    // score, which only survives if nothing recomputed it.
    await setBotScore(basename, { version: BOT_SCORE_VERSION, score: 3, maxScore: 25 });
    assert.equal((await botScoreFor(basename)).score, 3);
  });
});

test('par: backfill scores every save once and skips them on a second pass', async () => {
  await withTmpSaveDir(async () => {
    await setupRoom({ seed: 1 });
    await setupRoom({ seed: 2, variantId: 'rainbowCritical' });
    const first = await backfillBotScores();
    assert.equal(first.total, 2);
    assert.equal(first.computed, 2);
    const second = await backfillBotScores();
    assert.equal(second.computed, 0, 'nothing left to do');
    assert.equal(Object.keys(await readAllBotScores()).length, 2);
  });
});

test('par: deleting a save drops its par along with its tags', async () => {
  await withTmpSaveDir(async () => {
    const { room } = await setupRoom();
    const basename = path.basename(room.savePath);
    await botScoreFor(basename);
    assert.ok((await readAllBotScores())[basename]);
    room.savePath = null; // release the file, as the delete path requires
    await deleteSave(basename);
    assert.deepEqual(await readAllBotScores(), {});
  });
});

test('game info: a finished game carries stats, par, and its same-deck siblings', async () => {
  await withTmpSaveDir(async () => {
    // Two games dealt from the same seed, plus one from another seed.
    const a = await setupRoom({ seed: 555 });
    const bobN = a.room.state.players[1].hand[0].number;
    await applyAction(a.room, a.alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await voteAbandon(a.room, a.alice.id);
    await voteAbandon(a.room, a.bob.id);
    const b = await setupRoom({ seed: 555 });
    await voteAbandon(b.room, b.alice.id);
    await voteAbandon(b.room, b.bob.id);
    const other = await setupRoom({ seed: 556 });
    await voteAbandon(other.room, other.alice.id);
    await voteAbandon(other.room, other.bob.id);

    const detail = await gameDetail(path.basename(a.room.savePath));
    assert.equal(detail.status, 'abandoned');
    assert.equal(detail.seed, 555);
    assert.equal(detail.moves, 1);
    assert.deepEqual(detail.playerNames, ['Alice', 'Bob']);
    assert.equal(detail.stats.players.length, 2);
    assert.equal(detail.stats.players[0].hints, 1, 'the same table the game-over banner draws');
    assert.equal(detail.botScore.score, a.room.botScore.score);
    assert.deepEqual(
      detail.sameDeck.map((s) => s.basename),
      [path.basename(b.room.savePath)],
      'the other game off the same deck, and only it',
    );
    assert.ok(detail.sameDeck[0].botScore, 'siblings carry their par too');
    assert.equal(detail.deckKey, undefined, 'the grouping key never ships');
  });
});

test('game info: same seed, different variant is a different deck — not a sibling', async () => {
  await withTmpSaveDir(async () => {
    const a = await setupRoom({ seed: 321, variantId: 'simple' });
    await voteAbandon(a.room, a.alice.id);
    await voteAbandon(a.room, a.bob.id);
    const b = await setupRoom({ seed: 321, variantId: 'rainbowCritical' });
    await voteAbandon(b.room, b.alice.id);
    await voteAbandon(b.room, b.bob.id);
    const detail = await gameDetail(path.basename(a.room.savePath));
    assert.equal(detail.seed, 321);
    assert.deepEqual(detail.sameDeck, [], 'one seed shuffles two different decks');
  });
});

test('game info: an unfinished game shows no seed, no par and no siblings', async () => {
  await withTmpSaveDir(async () => {
    const finished = await setupRoom({ seed: 909 });
    await voteAbandon(finished.room, finished.alice.id);
    await voteAbandon(finished.room, finished.bob.id);
    const live = await setupRoom({ seed: 909 });

    const detail = await gameDetail(path.basename(live.room.savePath));
    assert.equal(detail.status, 'in-progress');
    assert.equal(detail.seed, null);
    assert.equal(detail.botScore, null);
    assert.deepEqual(detail.sameDeck, [], 'sharing a deck with a readable game is itself a tell');
    // …and the finished game doesn't list the live one either, for the same reason.
    const otherWay = await gameDetail(path.basename(finished.room.savePath));
    assert.deepEqual(otherWay.sameDeck, []);
  });
});

test('game info: an unknown save is reported as missing, not as an empty page', async () => {
  await withTmpSaveDir(async () => {
    assert.equal(await gameDetail('20260101-000000-000-simple.jsonl'), null);
    await assert.rejects(() => gameDetail('../escape.jsonl'), /Bad save filename/);
  });
});
