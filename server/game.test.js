import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeck,
  createInitialState,
  handSize,
  hintableColors,
  pileTop,
  pileComplete,
  score,
  maxPossibleScore,
} from './game.js';

const EXPECTED_DECK_SIZE = {
  simple: 50,
  rainbow: 60,
  rainbowCritical: 55,
  rainbowCriticalBlack: 65,
  rainbowCriticalBlackReverse: 65,
};

for (const [id, size] of Object.entries(EXPECTED_DECK_SIZE)) {
  test(`${id}: deck size is ${size}`, () => {
    assert.equal(buildDeck(id).length, size);
  });
}

test('simple variant has 3 ones per color and 1 five per color', () => {
  const deck = buildDeck('simple');
  for (const color of ['red', 'yellow', 'green', 'blue', 'white']) {
    const inColor = deck.filter((c) => c.color === color);
    assert.equal(inColor.filter((c) => c.number === 1).length, 3, `${color} ones`);
    assert.equal(inColor.filter((c) => c.number === 5).length, 1, `${color} fives`);
  }
});

test('rainbow critical has exactly one of each number for rainbow', () => {
  const deck = buildDeck('rainbowCritical');
  const rainbow = deck.filter((c) => c.color === 'rainbow');
  assert.equal(rainbow.length, 5);
  assert.deepEqual(rainbow.map((c) => c.number).sort(), [1, 2, 3, 4, 5]);
});

test('black-reverse variant has three 5s and one 1 for black', () => {
  const deck = buildDeck('rainbowCriticalBlackReverse');
  const black = deck.filter((c) => c.color === 'black');
  assert.equal(black.filter((c) => c.number === 5).length, 3);
  assert.equal(black.filter((c) => c.number === 1).length, 1);
  assert.equal(black.length, 10);
});

test('cards are built with full possible-color/number arrays for the variant', () => {
  const deck = buildDeck('rainbowCriticalBlack');
  const sample = deck[0];
  assert.deepEqual([...sample.possibleColors].sort(), [
    'black', 'blue', 'green', 'rainbow', 'red', 'white', 'yellow',
  ]);
  assert.deepEqual(sample.possibleNumbers, [1, 2, 3, 4, 5]);
  assert.equal(sample.colorClued, false);
  assert.equal(sample.numberClued, false);
  assert.equal(sample.lastHint, null);
  assert.deepEqual(sample.annotations, { note: '', guarded: false });
});

test('hintable colors exclude rainbow and black', () => {
  assert.deepEqual(hintableColors('rainbowCriticalBlack').sort(), [
    'blue', 'green', 'red', 'white', 'yellow',
  ]);
});

test('hand size: 5 for 2-3 players, 4 for 4-5', () => {
  assert.equal(handSize(2), 5);
  assert.equal(handSize(3), 5);
  assert.equal(handSize(4), 4);
  assert.equal(handSize(5), 4);
});

test('initial state deals correct hands and is deterministic with a seed', () => {
  const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const s1 = createInitialState({ variantId: 'simple', players, seed: 42 });
  const s2 = createInitialState({ variantId: 'simple', players, seed: 42 });
  assert.equal(s1.players[0].hand.length, 5);
  assert.equal(s1.hintTokens, 8);
  assert.equal(s1.fuseTokens, 3);
  assert.equal(s1.status, 'playing');
  assert.equal(s1.endRule, 'standard');
  assert.equal(s1.shareGuarded, false);
  assert.deepEqual(s1.deck.map((c) => c.id), s2.deck.map((c) => c.id));
});

test('pile helpers respect direction', () => {
  const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const s = createInitialState({ variantId: 'rainbowCriticalBlackReverse', players, seed: 1 });
  assert.equal(pileTop(s, 'black'), 6, 'down-direction empty pile reports 6');
  assert.equal(pileTop(s, 'red'), 0, 'up-direction empty pile reports 0');
  assert.equal(pileComplete(s, 'red'), false);
  assert.equal(score(s), 0);
  assert.equal(maxPossibleScore(s), 35);
});

test('createInitialState generates a seed when none is provided and stores it', () => {
  const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const s = createInitialState({ variantId: 'simple', players });
  assert.equal(typeof s.seed, 'number');
  assert.ok(s.seed >= 0 && s.seed < 0x100000000);
});

test('createInitialState reproduces the same deck for the same seed', () => {
  const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const s1 = createInitialState({ variantId: 'simple', players, seed: 12345 });
  const s2 = createInitialState({ variantId: 'simple', players, seed: 12345 });
  assert.equal(s1.seed, 12345);
  assert.deepEqual(s1.deck.map((c) => c.id), s2.deck.map((c) => c.id));
});

test('createInitialState rejects bad endRule and player count', () => {
  const players = [{ id: 'a', name: 'A' }];
  assert.throws(() => createInitialState({ variantId: 'simple', players: [], seed: 1 }));
  assert.throws(() => createInitialState({ variantId: 'simple', players, seed: 1 }));
  const ok = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  assert.throws(() => createInitialState({ variantId: 'simple', players: ok, endRule: 'wat' }));
});
