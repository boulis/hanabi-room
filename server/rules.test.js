import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, pileTop, score } from './game.js';
import { GameError, annotateAction, discardAction, hintAction, playAction } from './rules.js';

const PLAYERS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
];

function freshState(overrides = {}) {
  return createInitialState({
    variantId: 'simple',
    players: PLAYERS,
    seed: 1,
    ...overrides,
  });
}

function rigHand(state, playerIndex, cards) {
  state.players[playerIndex].hand = cards.map((c, i) => ({
    id: 1000 + i,
    color: c.color,
    number: c.number,
    possibleColors: ['red', 'yellow', 'green', 'blue', 'white'],
    possibleNumbers: [1, 2, 3, 4, 5],
    colorClued: false,
    numberClued: false,
    annotations: { note: '', guarded: false },
  }));
}

test('play: legal play advances pile and does not lose fuse', () => {
  const s = freshState();
  rigHand(s, 0, [{ color: 'red', number: 1 }]);
  playAction(s, 0, 0);
  assert.equal(pileTop(s, 'red'), 1);
  assert.equal(s.fuseTokens, 3);
  assert.equal(s.log[0].type, 'play');
  assert.equal(s.log[0].success, true);
});

test('play: illegal play loses a fuse and discards the card', () => {
  const s = freshState();
  rigHand(s, 0, [{ color: 'red', number: 3 }]);
  playAction(s, 0, 0);
  assert.equal(s.fuseTokens, 2);
  assert.equal(s.discard.some((c) => c.color === 'red' && c.number === 3), true);
});

test('play: completing a stack grants a bonus hint token', () => {
  const s = freshState();
  s.playedPiles.red = [
    { id: 90, color: 'red', number: 1 },
    { id: 91, color: 'red', number: 2 },
    { id: 92, color: 'red', number: 3 },
    { id: 93, color: 'red', number: 4 },
  ];
  s.hintTokens = 5;
  rigHand(s, 0, [{ color: 'red', number: 5 }]);
  playAction(s, 0, 0);
  assert.equal(pileTop(s, 'red'), 5);
  assert.equal(s.hintTokens, 6);
  assert.equal(s.log[0].bonusHint, true);
});

test('play: bonus hint capped at MAX_HINT_TOKENS', () => {
  const s = freshState();
  s.playedPiles.red = [
    { id: 90, color: 'red', number: 1 },
    { id: 91, color: 'red', number: 2 },
    { id: 92, color: 'red', number: 3 },
    { id: 93, color: 'red', number: 4 },
  ];
  s.hintTokens = 8;
  rigHand(s, 0, [{ color: 'red', number: 5 }]);
  playAction(s, 0, 0);
  assert.equal(s.hintTokens, 8);
});

test('discard: refills a hint token; rejected at full', () => {
  const s = freshState();
  s.hintTokens = 5;
  rigHand(s, 0, [{ color: 'red', number: 3 }]);
  discardAction(s, 0, 0);
  assert.equal(s.hintTokens, 6);

  const s2 = freshState();
  s2.hintTokens = 8;
  rigHand(s2, 0, [{ color: 'red', number: 3 }]);
  assert.throws(() => discardAction(s2, 0, 0), GameError);
});

test('hint: rejected with no tokens', () => {
  const s = freshState();
  s.hintTokens = 0;
  assert.throws(() => hintAction(s, 0, 1, 'number', 1), GameError);
});

test('hint: rejected if no card matches', () => {
  const s = freshState();
  rigHand(s, 1, [{ color: 'red', number: 1 }]);
  assert.throws(() => hintAction(s, 0, 1, 'color', 'blue'), GameError);
});

test('hint: empty hint allowed when allowEmptyHints is true; still costs a token and rules out the value', () => {
  const s = freshState({ allowEmptyHints: true });
  rigHand(s, 1, [
    { color: 'red', number: 1 },
    { color: 'red', number: 2 },
  ]);
  hintAction(s, 0, 1, 'number', 5);
  assert.equal(s.hintTokens, 7);
  for (const card of s.players[1].hand) {
    assert.ok(!card.possibleNumbers.includes(5));
    assert.equal(card.numberClued, false);
  }
});

test('hint: empty color hint allowed when allowEmptyHints is true; rules out that color', () => {
  const s = freshState({ allowEmptyHints: true });
  rigHand(s, 1, [
    { color: 'red', number: 1 },
    { color: 'red', number: 2 },
  ]);
  hintAction(s, 0, 1, 'color', 'blue');
  assert.equal(s.hintTokens, 7);
  for (const card of s.players[1].hand) {
    assert.ok(!card.possibleColors.includes('blue'));
    assert.equal(card.colorClued, false);
  }
});

test('hint: number hint sets possibleNumbers and clears that number elsewhere', () => {
  const s = freshState();
  rigHand(s, 1, [
    { color: 'red', number: 3 },
    { color: 'blue', number: 1 },
    { color: 'green', number: 3 },
  ]);
  hintAction(s, 0, 1, 'number', 3);
  assert.deepEqual(s.players[1].hand[0].possibleNumbers, [3]);
  assert.equal(s.players[1].hand[0].numberClued, true);
  assert.deepEqual(s.players[1].hand[1].possibleNumbers, [1, 2, 4, 5]);
  assert.equal(s.players[1].hand[1].numberClued, false);
  assert.deepEqual(s.players[1].hand[2].possibleNumbers, [3]);
});

test('hint: color hint constrains possibleColors positively and negatively', () => {
  const s = freshState();
  rigHand(s, 1, [
    { color: 'red', number: 2 },
    { color: 'blue', number: 4 },
  ]);
  hintAction(s, 0, 1, 'color', 'red');
  assert.deepEqual(s.players[1].hand[0].possibleColors, ['red']);
  assert.equal(s.players[1].hand[0].colorClued, true);
  assert.deepEqual(s.players[1].hand[1].possibleColors, ['yellow', 'green', 'blue', 'white']);
});

test('hint: rainbow cards are touched by any color hint and resolve via two hints', () => {
  const s = createInitialState({
    variantId: 'rainbow',
    players: PLAYERS,
    seed: 1,
  });
  s.players[1].hand = [
    {
      id: 2000,
      color: 'rainbow',
      number: 3,
      possibleColors: ['red', 'yellow', 'green', 'blue', 'white', 'rainbow'],
      possibleNumbers: [1, 2, 3, 4, 5],
      colorClued: false,
      numberClued: false,
      annotations: { note: '', guarded: false },
    },
    {
      id: 2001,
      color: 'blue',
      number: 2,
      possibleColors: ['red', 'yellow', 'green', 'blue', 'white', 'rainbow'],
      possibleNumbers: [1, 2, 3, 4, 5],
      colorClued: false,
      numberClued: false,
      annotations: { note: '', guarded: false },
    },
  ];
  hintAction(s, 0, 1, 'color', 'red');
  assert.deepEqual(s.players[1].hand[0].possibleColors, ['red', 'rainbow']);
  assert.equal(s.players[1].hand[0].colorClued, true);
  assert.deepEqual(s.players[1].hand[1].possibleColors, ['yellow', 'green', 'blue', 'white']);

  s.currentPlayer = 0;
  s.hintTokens = 8;
  hintAction(s, 0, 1, 'color', 'blue');
  assert.deepEqual(s.players[1].hand[0].possibleColors, ['rainbow']);
});

test('hint: rainbow cannot be hinted directly', () => {
  const s = createInitialState({ variantId: 'rainbow', players: PLAYERS, seed: 1 });
  assert.throws(() => hintAction(s, 0, 1, 'color', 'rainbow'), GameError);
});

test('hint: black cards are never touched by color hints; black itself is unhintable', () => {
  const s = createInitialState({ variantId: 'rainbowCriticalBlack', players: PLAYERS, seed: 1 });
  s.players[1].hand = [
    {
      id: 3000,
      color: 'black',
      number: 4,
      possibleColors: ['red', 'yellow', 'green', 'blue', 'white', 'rainbow', 'black'],
      possibleNumbers: [1, 2, 3, 4, 5],
      colorClued: false,
      numberClued: false,
      annotations: { note: '', guarded: false },
    },
    {
      id: 3001,
      color: 'red',
      number: 4,
      possibleColors: ['red', 'yellow', 'green', 'blue', 'white', 'rainbow', 'black'],
      possibleNumbers: [1, 2, 3, 4, 5],
      colorClued: false,
      numberClued: false,
      annotations: { note: '', guarded: false },
    },
  ];
  hintAction(s, 0, 1, 'color', 'red');
  assert.equal(s.players[1].hand[0].colorClued, false);
  assert.deepEqual(s.players[1].hand[0].possibleColors, ['yellow', 'green', 'blue', 'white', 'black']);
  assert.deepEqual(s.players[1].hand[1].possibleColors, ['red', 'rainbow']);

  assert.throws(() => {
    s.currentPlayer = 0;
    s.hintTokens = 8;
    hintAction(s, 0, 1, 'color', 'black');
  }, GameError);
});

test('reverse-direction stack: 5 is playable on empty pile, then 4, etc.', () => {
  const s = createInitialState({ variantId: 'rainbowCriticalBlackReverse', players: PLAYERS, seed: 1 });
  s.players[0].hand = [
    {
      id: 4000,
      color: 'black',
      number: 5,
      possibleColors: [],
      possibleNumbers: [],
      colorClued: false,
      numberClued: false,
      annotations: { note: '', guarded: false },
    },
  ];
  playAction(s, 0, 0);
  assert.equal(pileTop(s, 'black'), 5);
  assert.equal(s.fuseTokens, 3);

  s.currentPlayer = 1;
  s.players[1].hand = [
    {
      id: 4001,
      color: 'black',
      number: 4,
      possibleColors: [],
      possibleNumbers: [],
      colorClued: false,
      numberClued: false,
      annotations: { note: '', guarded: false },
    },
  ];
  playAction(s, 1, 0);
  assert.equal(pileTop(s, 'black'), 4);
});

test('turn rotation rejects out-of-turn actions', () => {
  const s = freshState();
  assert.throws(() => playAction(s, 1, 0), GameError);
  assert.throws(() => hintAction(s, 1, 0, 'number', 1), GameError);
});

test('end: 3rd fuse ends the game in failure', () => {
  const s = freshState();
  s.fuseTokens = 1;
  rigHand(s, 0, [{ color: 'red', number: 4 }]);
  playAction(s, 0, 0);
  assert.equal(s.fuseTokens, 0);
  assert.equal(s.status, 'finished');
  assert.equal(s.endReason, 'fuses');
});

test('end: standard rule plays exactly N more turns after deck empties', () => {
  const s = freshState();
  s.hintTokens = 4;
  s.deck = [{
    id: 9999, color: 'red', number: 1,
    possibleColors: ['red', 'yellow', 'green', 'blue', 'white'],
    possibleNumbers: [1, 2, 3, 4, 5],
    colorClued: false, numberClued: false,
    annotations: { note: '', guarded: false },
  }];
  rigHand(s, 0, [{ color: 'red', number: 3 }, { color: 'blue', number: 4 }]);
  rigHand(s, 1, [{ color: 'green', number: 2 }, { color: 'white', number: 1 }]);

  discardAction(s, 0, 0);
  assert.equal(s.finalTurn, s.players.length + 1);
  assert.equal(s.status, 'playing');
  discardAction(s, 1, 0);
  assert.equal(s.status, 'playing', 'wind-down turn 1');
  discardAction(s, 0, 0);
  assert.equal(s.status, 'finished');
  assert.equal(s.endReason, 'deck');
});

test('end: lax rule continues until all hands are empty', () => {
  const s = freshState({ endRule: 'lax' });
  s.deck = [];
  s.hintTokens = 4;
  rigHand(s, 0, [{ color: 'red', number: 3 }]);
  rigHand(s, 1, [{ color: 'green', number: 2 }]);

  discardAction(s, 0, 0);
  assert.equal(s.status, 'playing');
  assert.equal(s.finalTurn, null);
  discardAction(s, 1, 0);
  assert.equal(s.status, 'finished');
  assert.equal(s.endReason, 'deck');
});

test('end: lax rule skips empty-handed players', () => {
  const s = freshState({ endRule: 'lax' });
  s.deck = [];
  s.hintTokens = 4;
  rigHand(s, 0, [{ color: 'red', number: 3 }]);
  rigHand(s, 1, [{ color: 'green', number: 2 }, { color: 'white', number: 1 }]);

  discardAction(s, 0, 0);
  assert.equal(s.currentPlayer, 1);
  discardAction(s, 1, 0);
  assert.equal(s.currentPlayer, 1, 'player 0 has empty hand and is skipped');
  discardAction(s, 1, 0);
  assert.equal(s.status, 'finished');
});

test('end: perfect score ends the game with reason "perfect"', () => {
  const s = freshState();
  for (const color of ['red', 'yellow', 'green', 'blue']) {
    s.playedPiles[color] = [1, 2, 3, 4, 5].map((n, i) => ({ id: 8000 + n, color, number: n }));
  }
  s.playedPiles.white = [1, 2, 3, 4].map((n, i) => ({ id: 9000 + n, color: 'white', number: n }));
  rigHand(s, 0, [{ color: 'white', number: 5 }]);
  playAction(s, 0, 0);
  assert.equal(s.status, 'finished');
  assert.equal(s.endReason, 'perfect');
  assert.equal(score(s), 25);
});

test('annotate: owner can set guarded flag and note within their hand', () => {
  const s = freshState();
  const cardId = s.players[0].hand[0].id;
  annotateAction(s, 0, cardId, { guarded: true, note: 'maybe' });
  const card = s.players[0].hand[0];
  assert.equal(card.annotations.guarded, true);
  assert.equal(card.annotations.note, 'maybe');
  annotateAction(s, 0, cardId, { guarded: false });
  assert.equal(s.players[0].hand[0].annotations.guarded, false);
  assert.equal(s.players[0].hand[0].annotations.note, 'maybe');
});

test('annotate: rejects card not in own hand', () => {
  const s = freshState();
  const otherId = s.players[1].hand[0].id;
  assert.throws(() => annotateAction(s, 0, otherId, { note: 'cheat' }), GameError);
});

test('annotate: validates note as string and guarded as boolean', () => {
  const s = freshState();
  const id = s.players[0].hand[0].id;
  assert.throws(() => annotateAction(s, 0, id, { note: 7 }), GameError);
  assert.throws(() => annotateAction(s, 0, id, { guarded: 'yes' }), GameError);
});
