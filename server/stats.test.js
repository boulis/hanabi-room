import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MOVE_MS, aggregateStats, gameStats } from './stats.js';

// A minimal state shaped like the real one: gameStats only reads players,
// log and the start/end stamps.
function stateWith(log, { startedAt = 1000, endedAt = null, names = ['Ann', 'Bob'] } = {}) {
  return {
    players: names.map((name, i) => ({ name, isBot: i === 1 })),
    log,
    startedAt,
    endedAt,
  };
}

test('stats: counts each action type per player and splits the clock', () => {
  const s = stateWith(
    [
      { type: 'hint', fromIndex: 0, toIndex: 1, at: 3000 },   // Ann: 2s
      { type: 'draw', playerIndex: 1, at: 3000 },             // ignored
      { type: 'play', playerIndex: 1, at: 4000 },             // Bob: 1s
      { type: 'discard', playerIndex: 0, at: 9000 },          // Ann: 5s
    ],
    { endedAt: 10000 },
  );
  const stats = gameStats(s);
  const [ann, bob] = stats.players;
  assert.deepEqual(
    { plays: ann.plays, discards: ann.discards, hints: ann.hints, undos: ann.undos, moves: ann.moves },
    { plays: 0, discards: 1, hints: 1, undos: 0, moves: 2 },
  );
  assert.deepEqual(
    { plays: bob.plays, discards: bob.discards, hints: bob.hints, undos: bob.undos, moves: bob.moves },
    { plays: 1, discards: 0, hints: 0, undos: 0, moves: 1 },
  );
  assert.equal(ann.moveMs, 7000);
  assert.equal(bob.moveMs, 1000);
  assert.equal(stats.totalMoveMs, 8000);
  assert.equal(stats.durationMs, 9000, 'game length includes time after the last move');
  assert.equal(ann.isBot, false);
  assert.equal(bob.isBot, true);
});

test('stats: an undone action counts as an undo, not as a move of its type', () => {
  const s = stateWith([
    { type: 'play', playerIndex: 0, at: 2000, undone: true },
    { type: 'discard', playerIndex: 0, at: 5000 },
  ]);
  const [ann] = gameStats(s).players;
  assert.equal(ann.undos, 1);
  assert.equal(ann.plays, 0, 'rolled back — it never happened');
  assert.equal(ann.discards, 1);
  assert.equal(ann.moveMs, 4000, '1s on the undone play + 3s on the discard that replaced it');
});

test('stats: time order comes from `at`, not log order (undo re-appends entries)', () => {
  // Undo pushes the struck entries back onto the end of the log, so the array
  // is out of order; the earlier timestamp must still be the earlier move.
  const s = stateWith([
    { type: 'discard', playerIndex: 1, at: 6000 },
    { type: 'play', playerIndex: 0, at: 2000, undone: true },
  ]);
  const [ann, bob] = gameStats(s).players;
  assert.equal(ann.moveMs, 1000);
  assert.equal(bob.moveMs, 4000);
});

test('stats: aggregate sums per player name across games and counts appearances', () => {
  const g1 = gameStats(stateWith([
    { type: 'play', playerIndex: 0, at: 2000 },
    { type: 'hint', fromIndex: 1, toIndex: 0, at: 4000 },
  ]));
  const g2 = gameStats(stateWith(
    [{ type: 'discard', playerIndex: 0, at: 3000 }],
    { names: ['Ann', 'Cid'] },
  ));
  const agg = aggregateStats([g1, g2]);
  assert.equal(agg.games, 2);
  const ann = agg.players.find((p) => p.name === 'Ann');
  assert.equal(ann.games, 2);
  assert.equal(ann.plays, 1);
  assert.equal(ann.discards, 1);
  assert.equal(ann.moveMs, 3000);
  assert.equal(ann.isBot, false);
  const bob = agg.players.find((p) => p.name === 'Bob');
  assert.equal(bob.games, 1);
  assert.equal(bob.hints, 1);
  assert.equal(bob.isBot, true, 'Bob only ever played as a bot');
  assert.equal(agg.totalMoveMs, g1.totalMoveMs + g2.totalMoveMs);
});

test('stats: no timestamps (or no start) degrades to counts without times', () => {
  const s = stateWith([{ type: 'play', playerIndex: 0 }, { type: 'hint', fromIndex: 1, toIndex: 0 }]);
  const stats = gameStats(s);
  assert.equal(stats.totalMoveMs, 0);
  assert.equal(stats.players[0].plays, 0, 'entries without `at` are skipped entirely');
  assert.equal(stats.durationMs, null, 'unfinished game has no length');
});

test('stats: one paused move is capped so an AFK gap cannot swamp the table', () => {
  const s = stateWith([
    { type: 'play', playerIndex: 0, at: 1000 + 6 * 60 * 60 * 1000 }, // 6h away
    { type: 'discard', playerIndex: 1, at: 1000 + 6 * 60 * 60 * 1000 + 4000 },
  ], { endedAt: 1000 + 6 * 60 * 60 * 1000 + 4000 });
  const stats = gameStats(s);
  assert.equal(stats.players[0].moveMs, MAX_MOVE_MS);
  assert.equal(stats.players[1].moveMs, 4000, 'normal moves are untouched');
  assert.equal(stats.durationMs, 6 * 60 * 60 * 1000 + 4000, 'game length is not capped');
});
