import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from './game.js';
import { annotateAction, discardAction, hintAction, playAction } from './rules.js';
import { viewState } from './view.js';
import { alarmGuards, decide, handCombos } from './botBrain.js';

const COLORS = ['red', 'yellow', 'green', 'blue', 'white'];
const DIST = [1, 1, 1, 2, 2, 3, 3, 4, 4, 5];

// Build a full 50-card draw order where each hand gets hands[p][i] (dealing
// is round-robin), `next` (if given) is drawn first after the deal, and the
// rest of the deck is whatever the variant multiset still owes, in a stable
// order.
function craftedDeck(hands, next = []) {
  const drawOrder = [];
  for (let i = 0; i < 5; i++) for (const hand of hands) drawOrder.push(hand[i]);
  drawOrder.push(...next);
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
  return [...drawOrder, ...rest];
}

function craftedState(p0, p1, opts = {}) {
  return createInitialState({
    variantId: 'simple',
    endRule: opts.endRule || 'lax',
    players: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bot' }],
    deckCards: craftedDeck([p0, p1], opts.next || []),
  });
}

function craftedState3(p0, p1, p2) {
  return createInitialState({
    variantId: 'simple',
    endRule: 'lax',
    players: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bot' }, { id: 'c', name: 'Cy' }],
    deckCards: craftedDeck([p0, p1, p2]),
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

test('bot: colour hint pinning an unplayable card still marks the newest touched', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'blue_4'],
    ['red_5', 'green_3', 'yellow_3', 'blue_3', 'red_2'],
  );
  hintAction(s, 0, 1, 'number', 5);    // touches index 0 only → "a 5"
  hintAction(s, 1, 0, 'number', 4);    // stall back
  hintAction(s, 0, 1, 'color', 'red'); // touches 0 and 4 → index 0 now known red_5
  // The hint pins index 0 as red_5, but red_5 isn't playable — so the hint
  // still asks for the newest touched card, exactly as if nothing were
  // pinned. (An earlier version cancelled the play order whenever a touched
  // card was pinned; in rainbow variants that made the bot ignore every
  // colour hint once it fully knew a rainbow card in its hand.)
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 4 }, reason);
});

test('bot: colour hint pinning a playable card plays that card first', () => {
  const s = craftedState(
    ['red_1', 'red_2', 'red_3', 'red_4', 'white_4'],
    ['red_5', 'green_3', 'yellow_3', 'blue_3', 'red_2'],
  );
  for (let i = 0; i < 4; i++) {
    playAction(s, 0, 0);              // red pile climbs to 4
    hintAction(s, 1, 0, 'number', 4); // stall back
  }
  hintAction(s, 0, 1, 'number', 5);   // touches index 0 only
  hintAction(s, 1, 0, 'number', 4);
  hintAction(s, 0, 1, 'color', 'red'); // pins index 0 as red_5 — playable now
  // The revealed card outranks the newest touched card (index 4), and
  // playing it consumes the hint's markers, retiring the newest-touched
  // target with it.
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
});

test('bot: forced discard (all cards clued) avoids provably critical cards', () => {
  const s = craftedState(
    ['yellow_4', 'blue_4', 'green_3', 'white_3', 'red_3'],
    ['green_5', 'blue_3', 'yellow_3', 'white_3', 'red_3'],
  );
  hintAction(s, 0, 1, 'number', 5); // touches index 0: some 5 — critical whatever it is
  hintAction(s, 1, 0, 'number', 4); // stall back
  hintAction(s, 0, 1, 'number', 3); // touches 1-4: every card is now clued
  s.hintTokens = 0;                 // no tokens → discarding is truly forced
  // No chop exists. The old fallback discarded index 0 blindly — a card that
  // is provably a 5 (a last copy in every world). Discard a 3 instead.
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'discard', cardIndex: 1 }, reason);
});

test('bot: with every card clued and tokens to spend, stalls instead of discarding', () => {
  const s = craftedState(
    ['yellow_4', 'blue_4', 'green_3', 'white_3', 'red_3'],
    ['green_5', 'blue_3', 'yellow_3', 'white_3', 'red_3'],
    { next: ['yellow_5'] },
  );
  hintAction(s, 0, 1, 'number', 5);
  hintAction(s, 1, 0, 'number', 4);
  hintAction(s, 0, 1, 'number', 3); // every bot card is now clued
  hintAction(s, 1, 0, 'number', 4);
  discardAction(s, 0, 4);           // the other red_3 → the bot's 3s might be critical
  // Teammates spent hints marking every card as worth keeping, and any of the
  // 3s could now be the critical red_3 — burning one is worse than spending
  // a token on a harmless keep-hint. (A provably safe card would just be
  // discarded; see the forced-discard test.)
  const { action, reason } = decide(viewState(s, 1));
  assert.equal(action.type, 'hint', `should stall, not discard a protected card (got: ${reason})`);
  assert.ok(reason.startsWith('stall'), reason);
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

test('bot: saves a chop 2 whose twin is nowhere in sight', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['yellow_2', 'red_3', 'blue_4', 'green_3', 'white_3'],
  );
  // yellow_2 isn't critical yet, but its twin is hidden in the deck — losing
  // this copy would cap the yellow pile at 1 for a long time.
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 2 }, reason);
});

test('bot: a playable critical chop is saved by getting it played', () => {
  const s = craftedState(
    ['yellow_1', 'yellow_2', 'green_3', 'white_3', 'red_4'],
    ['yellow_2', 'red_3', 'blue_4', 'green_4', 'white_4'],
  );
  playAction(s, 0, 0);              // yellow pile at 1
  hintAction(s, 1, 0, 'number', 4); // stall back
  discardAction(s, 0, 0);           // the other yellow_2 → p1's chop is critical
  hintAction(s, 1, 0, 'number', 4);
  // The chop is playable right now, so the best save is a play hint on it:
  // the card scores instead of sitting parked behind a keep-clue.
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'color', value: 'yellow' }, reason);
});

test('bot: saves a later player\'s critical chop when everyone between will play', () => {
  const s = craftedState3(
    ['yellow_3', 'blue_3', 'green_3', 'white_3', 'red_3'],
    ['green_1', 'red_2', 'blue_2', 'yellow_2', 'white_2'],
    ['yellow_5', 'red_4', 'blue_4', 'green_4', 'white_4'],
  );
  hintAction(s, 0, 1, 'number', 1); // p1 now has a provable play
  hintAction(s, 1, 2, 'number', 4); // stall; leaves p2's chop on yellow_5
  hintAction(s, 2, 0, 'number', 3); // stall back to p0
  // p1 will spend their turn playing, not saving — so p2's critical chop is
  // p0's to save, even though p2 isn't the next player.
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 2, hintType: 'number', value: 5 }, reason);
});

test('bot: with two endangered cards, saves the one whose loss costs more', () => {
  const s = craftedState(
    ['red_2', 'white_1', 'green_4', 'white_4', 'blue_2'],
    ['red_5', 'red_2', 'blue_4', 'yellow_4', 'green_4'],
  );
  hintAction(s, 0, 1, 'number', 4); // clues indexes 2-4; chop is red_5, then red_2
  hintAction(s, 1, 0, 'number', 1); // stall back
  discardAction(s, 0, 0);           // the other red_2 → p1's red_2 is now critical
  hintAction(s, 1, 0, 'number', 1);
  // Saving the chop red_5 slides p1's discard onto red_2 — a 4-point loss
  // (the red pile would cap at 1) versus 1 point for the 5. One hint can't
  // protect both. At full tokens no alarm discard is legal, so the fallback
  // is the cost-weighted save: hint the 2, accept risking the 5.
  s.hintTokens = 8;
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 2 }, reason);
});

test('bot: alarms when one hint cannot protect two expensive endangered cards', () => {
  const s = craftedState(
    ['red_2', 'blue_3', 'white_1', 'green_3', 'yellow_1'],
    ['red_2', 'blue_3', 'yellow_4', 'green_4', 'white_4'],
  );
  hintAction(s, 0, 1, 'number', 4); // clues p1's tail; chop red_2, then blue_3
  hintAction(s, 1, 0, 'number', 1);
  discardAction(s, 0, 0);           // the other red_2 → p1's red_2 critical (4 points)
  hintAction(s, 1, 0, 'number', 1);
  discardAction(s, 0, 0);           // the other blue_3 → p1's blue_3 critical (3 points)
  hintAction(s, 1, 0, 'number', 1);
  // Different numbers, different colours — no single hint protects both, and
  // both losses are expensive. The bot draws attention instead: it holds
  // known playables (its clued 1s) yet discards its chop — an anomaly the
  // receiver reads as "guard your cards".
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'discard', cardIndex: 1 }, reason);
  assert.ok(reason.startsWith('ALARM'), reason);
});

test('bot: alarms with a useful touched discard when a critical chop needs saving at 0 tokens', () => {
  const s = craftedState(
    ['green_3', 'yellow_4', 'blue_4', 'white_4', 'red_2'],
    ['yellow_5', 'red_4', 'blue_4', 'green_4', 'white_2'],
  );
  hintAction(s, 0, 1, 'number', 4); // keeps p1's chop on yellow_5
  hintAction(s, 1, 0, 'number', 3); // touches p0's green_3
  s.hintTokens = 0;                 // no way to hint a save
  // p1's critical yellow_5 is about to be discarded and there is no token to
  // say so. Discarding the clued (useful, provably non-critical) green_3 is
  // the safest way to signal that something is amiss.
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'discard', cardIndex: 0 }, reason);
  assert.ok(reason.startsWith('ALARM'), reason);
});

test('bot: reads an alarm and guards — two cards when the alarmer had tokens', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['red_3', 'blue_2', 'green_3', 'yellow_2', 'white_4'],
  );
  hintAction(s, 0, 1, 'number', 4);  // touches p1's white_4 (index 4)
  hintAction(s, 1, 0, 'number', 4);  // stall back
  discardAction(s, 0, 2);            // past the chop (index 0) — an alarm
  const hand = s.players[1].hand;
  const ids = alarmGuards(viewState(s, 1));
  assert.deepEqual(ids, [hand[0].id, hand[1].id], 'guards the two oldest unclued cards');
  for (const cardId of ids) annotateAction(s, 1, cardId, { guarded: true });
  // The guards move the chop: with nothing to play, the bot now discards its
  // third card instead of the first.
  s.hintTokens = 0;
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'discard', cardIndex: 2 }, reason);
});

test('bot: reads an alarm and guards one card when the alarmer had no tokens', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['red_3', 'blue_2', 'green_3', 'yellow_2', 'white_4'],
  );
  hintAction(s, 0, 1, 'number', 4);
  hintAction(s, 1, 0, 'number', 4);
  s.hintTokens = 0;                  // the alarmer has no hints available
  discardAction(s, 0, 2);            // past the chop — the only way to speak
  const hand = s.players[1].hand;
  assert.deepEqual(alarmGuards(viewState(s, 1)), [hand[0].id], 'guards just the chop');
});

test('bot: a routine chop discard triggers no guards', () => {
  const s = craftedState(
    ['yellow_4', 'blue_3', 'green_2', 'white_2', 'red_4'],
    ['red_3', 'blue_2', 'green_3', 'yellow_2', 'white_4'],
  );
  hintAction(s, 0, 1, 'number', 4);
  hintAction(s, 1, 0, 'number', 4);
  discardAction(s, 0, 1); // plain chop discard (index 0 is "4"-clued), nothing anomalous
  assert.deepEqual(alarmGuards(viewState(s, 1)), []);
});

test('bot: a "1" hint means play every touched 1 that can still be playable', () => {
  const s = craftedState(
    ['red_1', 'yellow_3', 'blue_3', 'green_4', 'white_4'],
    ['white_2', 'yellow_1', 'blue_2', 'green_1', 'blue_4'],
  );
  playAction(s, 0, 0);                 // red pile at 1 → a red 1 is now dead
  hintAction(s, 1, 0, 'number', 3);    // stall back
  hintAction(s, 0, 1, 'number', 1);    // touches indexes 1 and 3
  // Neither 1 is *provably* playable (each could be the dead red 1), but the
  // convention says play them all, oldest first.
  const first = decide(viewState(s, 1));
  assert.deepEqual(first.action, { type: 'play', cardIndex: 1 }, first.reason);
  playAction(s, 1, 1);                 // yellow_1 plays; hint markers consumed
  discardAction(s, 0, 4);
  // The second 1 (now index 2) must still be obligated even though playing
  // the first one consumed the hint's markers.
  const second = decide(viewState(s, 1));
  assert.deepEqual(second.action, { type: 'play', cardIndex: 2 }, second.reason);
});

test('bot: a card pinned to one identity claims a copy other cards cannot be', () => {
  const s = craftedState(
    ['red_4', 'yellow_4', 'blue_3', 'green_2', 'white_2'],
    ['red_4', 'green_3', 'yellow_2', 'white_3', 'blue_1'],
    { next: ['yellow_4'] },
  );
  hintAction(s, 0, 1, 'color', 'red'); // index 0 → colours {red}
  playAction(s, 1, 4);                 // blue_1 plays; draws yellow_4 at index 4
  hintAction(s, 0, 1, 'number', 4);    // touches 0 and 4; index 0 now pinned red_4
  const combos = handCombos(viewState(s, 1), 1);
  assert.deepEqual(combos[0], [['red', 4]]);
  // Index 4 was drawn after the red hint, so hints alone leave all 5 colours
  // possible. But index 0 claims one red_4 and player 0 holds the other —
  // cross-card elimination must rule red out.
  assert.equal(combos[4].length, 4);
  assert.ok(combos[4].every(([color]) => color !== 'red'), 'red_4 fully claimed');
});

// A bare card for hand-built endgame states.
function bareCard(id, color, number) {
  return {
    id, color, number,
    possibleColors: COLORS.slice(), possibleNumbers: [1, 2, 3, 4, 5],
    colorClued: false, numberClued: false, lastHints: [],
    annotations: { note: '', guarded: false },
  };
}

test('bot: endgame search plays into 50/50 odds instead of a losing discard', () => {
  // Deck empty. Four piles complete; red pile empty. The bot holds the last
  // red_1 and the last red_2 in unknown order — every other card is visible.
  let id = 0;
  const playedPiles = { red: [] };
  const discard = [];
  for (const color of ['yellow', 'green', 'blue', 'white']) {
    playedPiles[color] = [1, 2, 3, 4, 5].map((n) => bareCard(id++, color, n));
    for (const n of [1, 1, 2, 3, 4]) discard.push(bareCard(id++, color, n));
  }
  for (const n of [1, 1, 2, 3, 3, 4, 4, 5]) discard.push(bareCard(id++, 'red', n));
  const s = {
    status: 'playing', variantId: 'simple', endRule: 'lax',
    shareGuarded: false, allowEmptyHints: false, seed: 1,
    players: [
      { id: 'a', name: 'Ann', hand: [] },
      { id: 'b', name: 'Bot', hand: [bareCard(id++, 'red', 1), bareCard(id++, 'red', 2)] },
    ],
    deck: [], discard, playedPiles,
    hintTokens: 0, fuseTokens: 3, currentPlayer: 1, turn: 40, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
  // Conventions alone would discard the chop — a coin flip that kills the red
  // pile on heads (discarding the last red_1 caps it at 0). The search sees
  // that playing averages 21.5 against at most 20.5 for a discard.
  const { action, reason } = decide(viewState(s, 1));
  assert.ok(reason.startsWith('endgame search'), `expected a searched decision (got: ${reason})`);
  assert.equal(action.type, 'play', reason);
});

// Bots playing whole games against each other: the strongest regression net —
// every rule interacts, and the game must actually end without the brain ever
// proposing an illegal action (rules.js throws on those).
function playOut(seed, playerCount) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` }));
  const state = createInitialState({ variantId: 'simple', endRule: 'lax', players, seed, shareGuarded: true });
  let guard = 0;
  while (state.status === 'playing' && guard++ < 500) {
    const idx = state.currentPlayer;
    for (const cardId of alarmGuards(viewState(state, idx))) {
      annotateAction(state, idx, cardId, { guarded: true });
    }
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
