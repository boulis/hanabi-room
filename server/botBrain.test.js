import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from './game.js';
import { discardAction, hintAction, playAction } from './rules.js';
import { viewState } from './view.js';
import { decide } from './botBrain.js';

const COLORS = ['red', 'yellow', 'green', 'blue', 'white'];
const DIST = [1, 1, 1, 2, 2, 3, 3, 4, 4, 5];

// Build a full 50-card draw order where player 0 gets p0[i] and player 1 gets
// p1[i] (dealing is round-robin), and the rest of the deck is whatever the
// variant multiset still owes, in a stable order.
function craftedState(p0, p1, opts = {}) {
  const drawOrder = [];
  for (let i = 0; i < 5; i++) drawOrder.push(p0[i], p1[i]);
  const owed = new Map();
  for (const color of COLORS) {
    for (const n of DIST) {
      const k = `${color}_${n}`;
      owed.set(k, (owed.get(k) || 0) + 1);
    }
  }
  for (const k of drawOrder) {
    const left = owed.get(k);
    if (!left) throw new Error(`crafted hand overdraws ${k}`);
    owed.set(k, left - 1);
  }
  const rest = [];
  for (const [k, count] of owed) for (let i = 0; i < count; i++) rest.push(k);
  return createInitialState({
    variantId: 'simple',
    endRule: opts.endRule || 'lax',
    players: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bot' }],
    deckCards: [...drawOrder, ...rest],
  });
}

test('bot: opens with a colour hint whose newest touched card is playable', () => {
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_3', 'blue_2', 'red_1', 'green_3', 'yellow_2'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'color', value: 'red' }, reason);
});

test('bot: colour hint received → plays the newest touched card', () => {
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_3', 'blue_2', 'red_1', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'color', 'red'); // touches indexes 0 and 2; newest is 2
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 2 }, reason);
});

test('bot: number hint means keep — discards chop instead of playing', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'], // nothing hintable as a play
    ['blue_4', 'green_4', 'red_3', 'red_2', 'yellow_3'],
  );
  hintAction(s, 0, 1, 'number', 4); // touches indexes 0 and 1
  const { action, reason } = decide(viewState(s, 1));
  assert.equal(action.type, 'discard', reason);
  assert.equal(action.cardIndex, 2, 'oldest untouched card (indexes 0-1 are touched)');
});

test('bot: number hint that proves playability is played', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['green_1', 'red_3', 'blue_2', 'yellow_4', 'white_3'],
  );
  hintAction(s, 0, 1, 'number', 1); // all piles empty → a known 1 is provably playable
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
});

test('bot: saves the next player\'s critical chop with a number hint', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['yellow_5', 'red_3', 'blue_2', 'green_3', 'white_2'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 5 }, reason);
});

test('bot: discards a provably useless card ahead of the chop', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['red_1', 'red_1', 'blue_3', 'green_2', 'yellow_3'],
  );
  hintAction(s, 0, 1, 'color', 'red');       // marks newest red (index 1) for play
  playAction(s, 1, 1);                        // bot plays red 1 → red pile at 1
  hintAction(s, 0, 1, 'number', 1);           // remaining red 1 now fully known
  s.hintTokens = 0;                           // force the discard branch
  const { action, reason } = decide(viewState(s, 1));
  assert.equal(action.type, 'discard', reason);
  assert.equal(action.cardIndex, 0, 'the known duplicate red 1, not the chop');
});

test('bot: at full tokens with nothing useful, stalls with a hint', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['red_3', 'blue_2', 'green_3', 'yellow_2', 'white_4'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.equal(action.type, 'hint', reason);
  assert.equal(action.hintType, 'number', 'stall hints are number hints (keep)');
});

// Bots playing whole games against each other: the strongest regression net —
// every rule interacts, and the game must actually end without the brain ever
// proposing an illegal action (rules.js throws on those).
function playOut(seed, playerCount) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` }));
  const state = createInitialState({ variantId: 'simple', endRule: 'lax', players, seed });
  let guard = 0;
  while (state.status === 'playing' && guard++ < 500) {
    const idx = state.currentPlayer;
    const { action } = decide(viewState(state, idx));
    switch (action.type) {
      case 'play': playAction(state, idx, action.cardIndex); break;
      case 'discard': discardAction(state, idx, action.cardIndex); break;
      case 'hint': hintAction(state, idx, action.toPlayerIndex, action.hintType, action.value); break;
      default: throw new Error(`bot proposed unknown action ${action.type}`);
    }
  }
  assert.equal(state.status, 'finished', `game did not end (seed ${seed})`);
  return state;
}

test('bot vs bot: full games end legally with a sane score', () => {
  for (const [seed, playerCount] of [[1, 2], [2, 3], [3, 4], [42, 2], [99, 3]]) {
    const end = playOut(seed, playerCount);
    const score = Object.values(end.playedPiles).reduce((a, p) => a + p.length, 0);
    assert.ok(score >= 8, `seed ${seed} (${playerCount}p): score ${score} suspiciously low`);
  }
});
