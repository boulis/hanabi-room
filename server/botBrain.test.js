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

test('bot: urgent save outranks its own playable card', () => {
  const s = craftedState(
    ['green_1', 'blue_3', 'red_2', 'white_2', 'red_4'],
    ['yellow_5', 'red_4', 'blue_4', 'green_3', 'white_2'],
  );
  hintAction(s, 0, 1, 'number', 4); // harmless keep-hint; chop stays yellow_5
  hintAction(s, 1, 0, 'number', 1); // now player 0 KNOWS card 0 is playable
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(
    action,
    { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 5 },
    `should save the critical chop before playing (got: ${reason})`,
  );
});

test('bot: in the final round its own play outranks the save', () => {
  const s = craftedState(
    ['green_1', 'blue_3', 'red_2', 'white_2', 'red_4'],
    ['yellow_5', 'red_4', 'blue_4', 'green_3', 'white_2'],
  );
  hintAction(s, 0, 1, 'number', 4);
  hintAction(s, 1, 0, 'number', 1);
  s.finalTurn = s.turn + 2; // deck exhausted — every remaining play counts
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
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

test('bot: remembers earlier colour hints, not just the latest', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['red_1', 'white_3', 'green_3', 'yellow_3', 'blue_4'],
  );
  hintAction(s, 0, 1, 'color', 'red');   // marks red_1 (index 0) for play
  hintAction(s, 1, 0, 'number', 4);      // stall back
  hintAction(s, 0, 1, 'number', 3);      // save: touches indexes 1-3
  hintAction(s, 1, 0, 'number', 4);
  hintAction(s, 0, 1, 'color', 'white'); // pins index 1 as white_3 — not playable
  // The latest colour hint's target is provably unplayable; the earlier red
  // hint's target must still be honoured instead of being forgotten.
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
});

test('bot: colour hint that reveals another card cancels the newest-touched play', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'blue_4'],
    ['red_5', 'green_3', 'yellow_3', 'blue_3', 'red_2'],
  );
  hintAction(s, 0, 1, 'number', 5);    // touches index 0 only → "a 5"
  hintAction(s, 1, 0, 'number', 4);    // stall back
  hintAction(s, 0, 1, 'color', 'red'); // touches 0 and 4 → index 0 now known red_5
  // The hint fully identified index 0 (a reveal), so the newest touched card
  // (index 4, red_2 — a guaranteed misplay) carries no play promise.
  const { action, reason } = decide(viewState(s, 1));
  assert.notEqual(action.type, 'play', `should not gamble on the newest touched card (got: ${reason})`);
});

test('bot: counts visible copies to pin a hinted card as playable', () => {
  const s = craftedState(
    ['yellow_1', 'green_1', 'blue_1', 'white_1', 'red_2'],
    ['yellow_2', 'red_3', 'green_4', 'blue_4', 'white_4'],
  );
  // Player 0 plays their four 1s (bot stalls in between): every pile except
  // red is at 1, and player 0 draws into [red_2, red_1, red_1, red_1, red_2].
  for (let i = 0; i < 4; i++) {
    playAction(s, 0, 0);
    hintAction(s, 1, 0, 'number', 1);
  }
  hintAction(s, 0, 1, 'number', 2); // touches index 0 only
  // Constraints alone leave {any colour} × {2}, and red_2 isn't playable —
  // but both remaining red 2s are visible in player 0's hand, so the bot can
  // rule red out and prove its 2 is playable.
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
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
