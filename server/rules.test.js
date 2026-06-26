import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, exportDeckOrder, pileTop, score } from './game.js';
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
    lastHints: [], annotations: { note: '', guarded: false },
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

test('hint: lastHints marks touched cards only and leaves untouched cards alone', () => {
  const s = freshState();
  rigHand(s, 1, [
    { color: 'red', number: 2 },
    { color: 'blue', number: 2 },
    { color: 'red', number: 4 },
  ]);
  hintAction(s, 0, 1, 'color', 'red');
  assert.equal(s.players[1].hand[0].lastHints.length, 1);
  assert.deepEqual(s.players[1].hand[0].lastHints[0], { hintIndex: 0, hintType: 'color', value: 'red' });
  assert.equal(s.players[1].hand[1].lastHints.length, 0);
  assert.deepEqual(s.players[1].hand[2].lastHints[0], { hintIndex: 0, hintType: 'color', value: 'red' });
});

test('hint: a second hint accumulates instead of overwriting the previous mark', () => {
  const s = freshState();
  rigHand(s, 1, [
    { color: 'red', number: 2 },
    { color: 'blue', number: 2 },
    { color: 'red', number: 4 },
  ]);
  hintAction(s, 0, 1, 'color', 'red');
  s.currentPlayer = 0;
  s.hintTokens = 8;
  hintAction(s, 0, 1, 'number', 2);
  // Card 0 was touched by both → two marks. Card 1 only by number=2. Card 2 only by red.
  assert.equal(s.players[1].hand[0].lastHints.length, 2);
  assert.equal(s.players[1].hand[0].lastHints[1].hintType, 'number');
  assert.equal(s.players[1].hand[1].lastHints.length, 1);
  assert.equal(s.players[1].hand[2].lastHints.length, 1, 'untouched-by-new-hint card keeps its old mark');
});

test('play: leaving the hand consumes the hint marks from every other card it touched', () => {
  const s = freshState();
  rigHand(s, 1, [
    { color: 'red', number: 1 },
    { color: 'red', number: 4 },
    { color: 'blue', number: 2 },
  ]);
  hintAction(s, 0, 1, 'color', 'red'); // touches cards 0 and 2... wait, card 0 is red-1, card 2 is blue-2 → touches 0 only.
  // Actually the hand has red-1, red-4, blue-2 → red touches indexes 0 and 1.
  assert.deepEqual(
    s.players[1].hand.map((c) => c.lastHints.length),
    [1, 1, 0],
  );
  // Player 1 plays card 0 (red-1, legal). The shared hint mark must vanish from card 1 too.
  s.currentPlayer = 1;
  playAction(s, 1, 0);
  // After the play, hand[0] is the former hand[1] (red-4) — its mark should be gone.
  assert.equal(s.players[1].hand[0].lastHints.length, 0, 'mark consumed from sibling');
});

test('discard: also consumes hint marks from other cards in the same hint', () => {
  const s = freshState();
  s.hintTokens = 4;
  rigHand(s, 1, [
    { color: 'red', number: 2 },
    { color: 'red', number: 3 },
    { color: 'blue', number: 5 },
  ]);
  hintAction(s, 0, 1, 'color', 'red');
  s.currentPlayer = 1;
  discardAction(s, 1, 0);
  assert.equal(s.players[1].hand[0].lastHints.length, 0, 'sibling mark cleared by discard');
});

test('log: play entry records wasTouched and wasFullyKnown from pre-action card state', () => {
  const s = freshState();
  rigHand(s, 0, [{ color: 'red', number: 1 }]);
  s.players[0].hand[0].colorClued = true;
  s.players[0].hand[0].possibleColors = ['red'];
  s.players[0].hand[0].numberClued = true;
  s.players[0].hand[0].possibleNumbers = [1];
  playAction(s, 0, 0);
  const e = s.log.find((x) => x.type === 'play');
  assert.equal(e.wasTouched, true);
  assert.equal(e.wasFullyKnown, true);
});

test('log: discard entry records chopIndex and whether the discarded card was the chop', () => {
  const s = freshState();
  s.hintTokens = 4;
  rigHand(s, 0, [
    { color: 'red', number: 4 },
    { color: 'green', number: 2 },
    { color: 'blue', number: 3 },
  ]);
  // Touch card 0 only (chop becomes card 1).
  s.players[0].hand[0].colorClued = true;
  // Discard card 2 — not the chop (chop is index 1).
  discardAction(s, 0, 2);
  const e = s.log.find((x) => x.type === 'discard');
  assert.equal(e.chopIndex, 1);
  assert.equal(e.cardIndex, 2);
  assert.equal(e.wasTouched, false);
});

test('log: discard records wasFullyKnown when the discarded card was fully clued', () => {
  const s = freshState();
  s.hintTokens = 4;
  rigHand(s, 0, [{ color: 'red', number: 3 }, { color: 'blue', number: 1 }]);
  const c = s.players[0].hand[0];
  c.colorClued = true; c.possibleColors = ['red'];
  c.numberClued = true; c.possibleNumbers = [3];
  discardAction(s, 0, 0);
  const e = s.log.find((x) => x.type === 'discard');
  assert.equal(e.wasTouched, true);
  assert.equal(e.wasFullyKnown, true);
});

test('exportDeckOrder: produces the expected shape for a 65-card variant', () => {
  const s = createInitialState({
    variantId: 'rainbowCriticalBlackReverse',
    players: PLAYERS,
    seed: 42,
  });
  s.endedAt = s.startedAt + 1197 * 1000;
  s.playedPiles.red = [{}, {}, {}]; // fake a score of 3 for the smoke check
  const out = exportDeckOrder(s);
  assert.equal(out.count, 65);
  assert.equal(out.cards.length, 65);
  assert.match(out.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(out.duration_seconds, 1197);
  assert.equal(out.score, 3);
  assert.equal(out.validation.matched_set, 'Full 65 cards. Black reversed. One for each rainbow');
  assert.equal(out.validation.is_exact, true);
  assert.equal(out.validation.discrepancy_summary, '');
  for (const c of out.cards) {
    assert.match(c, /^(red|yellow|green|blue|white|rainbow|black)_[1-5]$/);
  }
});

test('exportDeckOrder: same seed → same card order (deterministic)', () => {
  const a = exportDeckOrder(createInitialState({ variantId: 'simple', players: PLAYERS, seed: 7 }));
  const b = exportDeckOrder(createInitialState({ variantId: 'simple', players: PLAYERS, seed: 7 }));
  assert.deepEqual(a.cards, b.cards);
});

test('log: chopIndex is -1 when every card in hand is touched', () => {
  const s = freshState();
  s.hintTokens = 4;
  rigHand(s, 0, [{ color: 'red', number: 1 }, { color: 'blue', number: 1 }]);
  for (const c of s.players[0].hand) c.colorClued = true;
  discardAction(s, 0, 0);
  const e = s.log.find((x) => x.type === 'discard');
  assert.equal(e.chopIndex, -1);
});

test('hint: a repeat of the same (type, value) replaces the prior mark on that card', () => {
  const s = freshState();
  s.hintTokens = 8;
  rigHand(s, 1, [
    { color: 'red', number: 5 },
    { color: 'blue', number: 5 },
  ]);
  const giveHint = (type, value) => {
    s.currentPlayer = 0;
    s.hintTokens = 8;
    hintAction(s, 0, 1, type, value);
  };
  giveHint('number', 5); // hintIndex 0 — both
  giveHint('color', 'red'); // 1 — card 0 only
  giveHint('number', 5); // 2 — repeat of hint 0 → replaces on both cards

  assert.equal(s.players[1].hand[0].lastHints.length, 2, 'card 0 still has just two marks');
  assert.deepEqual(
    s.players[1].hand[0].lastHints.map((h) => h.hintType + ':' + h.value),
    ['color:red', 'number:5'],
    'card 0: number=5 mark replaced (idx 2 now), red kept',
  );
  assert.equal(s.players[1].hand[0].lastHints[1].hintIndex, 2);
  assert.equal(s.players[1].hand[1].lastHints.length, 1);
  assert.equal(s.players[1].hand[1].lastHints[0].hintIndex, 2, 'card 1: number=5 replaced too');
});

test('hint cap: a 5th distinct hint on the same card drops the oldest hint from all cards it touched', () => {
  const s = freshState({ variantId: 'rainbow' });
  s.hintTokens = 8;
  rigHand(s, 1, [
    // A: rainbow card — touched by every color hint AND its number, so 5
    // distinct hints can stack on it.
    { color: 'rainbow', number: 2 },
    // B: red 2 — shares hintIndex 0 (number=2) and hintIndex 1 (color=red).
    { color: 'red', number: 2 },
  ]);
  // The variant has 6 possible colors including rainbow; rigHand's default
  // 5-color list would empty out after the first cross-suit hint. Fix it.
  for (const c of s.players[1].hand) c.possibleColors = ['red', 'yellow', 'green', 'blue', 'white', 'rainbow'];

  const giveHint = (type, value) => {
    s.currentPlayer = 0;
    s.hintTokens = 8;
    hintAction(s, 0, 1, type, value);
  };
  giveHint('number', 2);     // 0 — A and B
  giveHint('color', 'red');  // 1 — A (rainbow=all) and B
  giveHint('color', 'yellow'); // 2 — A only
  giveHint('color', 'green');  // 3 — A only
  giveHint('color', 'blue');   // 4 — A only → A stack [0..4] → cap drops hintIndex 0

  assert.equal(s.players[1].hand[0].lastHints.length, 4, 'A capped at 4');
  assert.ok(
    s.players[1].hand[0].lastHints.every((h) => h.hintIndex !== 0),
    'A no longer carries hintIndex 0',
  );
  assert.ok(
    s.players[1].hand[1].lastHints.every((h) => h.hintIndex !== 0),
    'B also lost hintIndex 0 (cap propagates across the hand)',
  );
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
      lastHints: [], annotations: { note: '', guarded: false },
    },
    {
      id: 2001,
      color: 'blue',
      number: 2,
      possibleColors: ['red', 'yellow', 'green', 'blue', 'white', 'rainbow'],
      possibleNumbers: [1, 2, 3, 4, 5],
      colorClued: false,
      numberClued: false,
      lastHints: [], annotations: { note: '', guarded: false },
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
      lastHints: [], annotations: { note: '', guarded: false },
    },
    {
      id: 3001,
      color: 'red',
      number: 4,
      possibleColors: ['red', 'yellow', 'green', 'blue', 'white', 'rainbow', 'black'],
      possibleNumbers: [1, 2, 3, 4, 5],
      colorClued: false,
      numberClued: false,
      lastHints: [], annotations: { note: '', guarded: false },
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
      lastHints: [], annotations: { note: '', guarded: false },
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
      lastHints: [], annotations: { note: '', guarded: false },
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
    lastHints: [], annotations: { note: '', guarded: false },
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
