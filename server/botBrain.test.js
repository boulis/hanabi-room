import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from './game.js';
import { getVariant } from './variants.js';
import { annotateAction, discardAction, hintAction, playAction } from './rules.js';
import { viewState } from './view.js';
import { alarmGuards, colorPlayTargets, decide, endgameHelpfulness, handCombos, knownPlayable, mergedColorTargets, protectiveStall, rememberColorTargets } from './botBrain.js';

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

// Variant-aware crafted deck: same idea as craftedDeck but the owed multiset
// comes from the chosen variant's suits (so rainbow/black cards can be placed).
function craftedDeckV(variantId, hands, next = []) {
  const variant = getVariant(variantId);
  const drawOrder = [];
  const handLen = Math.max(...hands.map((h) => h.length));
  for (let i = 0; i < handLen; i++) for (const hand of hands) if (hand[i]) drawOrder.push(hand[i]);
  drawOrder.push(...next);
  const owed = new Map();
  for (const suit of variant.suits) {
    for (const n of suit.distribution) {
      const k = `${suit.color}_${n}`;
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

function craftedStateV(variantId, p0, p1, opts = {}) {
  return createInitialState({
    variantId,
    endRule: opts.endRule || 'lax',
    players: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bot' }],
    deckCards: craftedDeckV(variantId, [p0, p1], opts.next || []),
    shareGuarded: true,
    allowEmptyHints: true,
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

test('bot: in a reverse variant a "1" hint means keep — the 1 could be the critical black 1', () => {
  // Black plays 5->1 with the reversed distribution, so black_1 is the pile's
  // LAST card and its only copy. Playing it early both misfires and caps black
  // at 4 forever. The receiver can't rule black out (black is never touched by
  // a colour hint), so a "1" hint must read as keep.
  const s = craftedStateV(
    'rainbowCriticalBlackReverse',
    ['white_4', 'white_3', 'green_4', 'yellow_4', 'blue_4'],
    ['black_1', 'red_1', 'white_2', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'number', 1); // touches black_1 (slot 0) and red_1 (slot 1)
  const { action, reason } = decide(viewState(s, 1));
  assert.notEqual(action.type, 'play', `must not gamble the only black 1: ${reason}`);
});

test('bot: in a reverse variant a "1" is played once the black 1 is ruled out', () => {
  // Ann holds the only black_1, so copy-counting removes it from the bot's
  // candidates — the obligation is back on.
  const s = craftedStateV(
    'rainbowCriticalBlackReverse',
    ['black_1', 'white_3', 'green_4', 'yellow_4', 'blue_4'],
    ['red_1', 'white_2', 'green_3', 'yellow_2', 'blue_3'],
  );
  hintAction(s, 0, 1, 'number', 1); // touches the bot's red_1 only
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
});

test('bot: yields a duplicate rather than racing a partner obliged to play it', () => {
  // Ann is obliged (by a "1" hint) to play her red_1 but cannot tell it is red —
  // to her it is just "a 1". The bot's own red colour target must be the red_1
  // (the only playable red), so both would play a red_1 and one must misfire.
  // The bot can see the collision and Ann cannot, so the copy is the bot's to shed.
  const s = craftedState(
    ['red_1', 'white_4', 'green_4', 'yellow_4', 'blue_4'],
    ['red_1', 'white_3', 'green_3', 'yellow_2', 'blue_2'],
  );
  hintAction(s, 0, 1, 'color', 'red');  // marks the bot's red_1 (slot 0) for play
  hintAction(s, 1, 0, 'number', 1);     // obligates Ann's red_1 — blind to its colour
  hintAction(s, 0, 1, 'number', 3);     // harmless, hands the turn back to the bot
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'discard', cardIndex: 0 }, reason);
  assert.match(reason, /^yield/);
});

test('bot: reads a partner\'s yield as a yield, not as an alarm', () => {
  // The same discard from the other side: Ann sheds a red_1 the bot is obliged
  // to play. It looks exactly like a touched-discard alarm, but the bot holds an
  // obligation the discarded identity could satisfy, so there is nothing to guard.
  const s = craftedState(
    ['red_1', 'white_4', 'green_4', 'yellow_4', 'blue_4'],
    ['red_1', 'white_3', 'green_3', 'yellow_2', 'blue_2'],
  );
  hintAction(s, 0, 1, 'number', 1);    // obligates the bot's red_1
  hintAction(s, 1, 0, 'color', 'red'); // marks Ann's red_1 for play
  discardAction(s, 0, 0);              // Ann yields it instead of playing it
  assert.deepEqual(alarmGuards(viewState(s, 1)), [], 'a yield must not read as an alarm');
});

test('bot: warns a partner whose obligated 1 has since been played by someone else', () => {
  // Bot (player 0) hints "1"; the partner's red_1 and blue_1 are both obligated.
  // Then the bot plays its OWN red_1, killing the partner's copy — which the
  // partner cannot detect (it knows only that the card is "a 1", and green/
  // yellow/white 1s are still open, so its own dead-card gate can't fire).
  // Only the bot can see it, so the bot must say so with a red colour hint,
  // which pins the card to red_1 and turns the "1" order back into information.
  const s = craftedState(
    ['red_1', 'white_4', 'blue_4', 'green_4', 'yellow_4'],
    ['red_1', 'blue_1', 'white_3', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'number', 1);   // obligates partner's red_1 and blue_1
  hintAction(s, 1, 0, 'number', 1);   // partner stalls back, pinning our red_1
  playAction(s, 0, 0);                // we play our red_1 — theirs is now dead
  hintAction(s, 1, 0, 'number', 4);   // partner's turn passes back to us
  s.fuseTokens = 2;                   // a burnt fuse now matters (see priority)
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(
    action,
    { type: 'hint', toPlayerIndex: 1, hintType: 'color', value: 'red' },
    reason,
  );
  assert.match(reason, /^warn /);
});

test('bot: colour-hint target slides past a touched card that is provably unplayable', () => {
  // Piles empty. Bot holds [green 5, green 1, red 2, green 2, black 5] and already
  // knows its two 2s. A "green" hint touches slots 0, 1 and 3 — but slot 3 is a
  // known green 2, provably unplayable on an empty green pile, so the play
  // promise slides to slot 1 (the green 1) rather than the newest touched card.
  const s = craftedStateV(
    'rainbowCriticalBlack',
    ['white_4', 'white_3', 'blue_4', 'blue_3', 'yellow_4'],
    ['green_5', 'green_1', 'red_2', 'green_2', 'black_5'],
  );
  hintAction(s, 0, 1, 'number', 2);      // bot learns slots 2 and 3 are 2s
  hintAction(s, 1, 0, 'number', 4);      // stall back so player 0 acts again
  hintAction(s, 0, 1, 'color', 'green'); // touches slots 0, 1 and 3
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 1 }, reason);
});

test('bot: trusts a colour hint on the last fuse instead of demanding proof', () => {
  // The sender chose the target and can see the card; requiring it to be
  // *provably* playable left it unplayed forever while the sender counted it
  // as a pending play and withheld help (the 2-player stall deadlock).
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_3', 'blue_2', 'red_1', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'color', 'red'); // target slot 2 (red_1) — only possibly playable
  s.fuseTokens = 1;
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 2 }, reason);
});

test('bot: leaving a colour target unplayed to discard the chop raises the alarm', () => {
  // The colour target (red_1, slot 2) is only *possibly* playable from the
  // receiver's side — it is never knownPlayable, so the old "obvious play"
  // test missed this entirely. Under the trust convention the target is a firm
  // obligation, so discarding the chop instead is a deliberate signal.
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_3', 'blue_2', 'red_1', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'color', 'red'); // touches slots 0 and 2; target is slot 2
  const combos = handCombos(viewState(s, 1), 1);
  assert.ok(!combos.some((cs) => knownPlayable(viewState(s, 1), cs)),
    'no provably playable card — the old knownPlayable test would see nothing');
  discardAction(s, 1, 1); // discard the chop (blue_2) instead of playing the target
  const guards = alarmGuards(viewState(s, 0));
  assert.ok(guards.length > 0, 'partner reads the forgone colour target as an alarm');
});

test('bot: colour-hint play target survives discarding an older card of the same hint', () => {
  // Bot's reds are at slots 0 (red_4, older) and 2 (red_2, newest → play target).
  // Discarding slot 0 consumes the hint's display markers across the whole hand,
  // wiping the target's marker too — but the driver memory keeps the obligation.
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_4', 'blue_2', 'red_2', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'color', 'red'); // touches slots 0 and 2; target is slot 2

  const memory = {};
  const beforeHand = viewState(s, 1).players[1].hand;
  rememberColorTargets(beforeHand, memory, null); // the bot's turn records the target id
  assert.deepEqual(colorPlayTargets(beforeHand), [2], 'target is the newest touched red');
  const targetId = beforeHand[2].id;
  assert.deepEqual(memory.colorPlays, [targetId]);

  discardAction(s, 1, 0); // bot discards the older red before playing the target
  const afterHand = viewState(s, 1).players[1].hand;
  // The card shifted from slot 2 to slot 1 when slot 0 was removed.
  const targetSlot = afterHand.findIndex((c) => c.id === targetId);
  assert.equal(targetSlot, 1);

  rememberColorTargets(afterHand, memory, 'discard');
  assert.deepEqual(colorPlayTargets(afterHand), [], 'marker is gone — the whole hint was consumed');
  assert.deepEqual(mergedColorTargets(afterHand, memory), [targetSlot], 'memory rescues the obligation');
  assert.deepEqual(memory.colorPlays, [targetId], 'obligation kept — the card is still in hand');
});

test('bot: colour-hint obligation is NOT revived when a sibling was played (pinned retirement)', () => {
  // Bot's reds at slots 0 (red_1, playable now) and 2 (red_4, newest → target).
  // Convention: a pinned-playable sibling (red_1) is played first, and that
  // play deliberately retires the newest-touched target — memory must not
  // resurrect it, or it would misplay red_4.
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_1', 'blue_2', 'red_4', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'color', 'red'); // touches slots 0 and 2
  const memory = {};
  const before = viewState(s, 1).players[1].hand;
  rememberColorTargets(before, memory, null);
  assert.deepEqual(memory.colorPlays, [before[2].id], 'target red_4 recorded');

  playAction(s, 1, 0); // play the pinned red_1 — retires the red hint
  const after = viewState(s, 1).players[1].hand;
  rememberColorTargets(after, memory, 'play');
  assert.deepEqual(colorPlayTargets(after), [], 'hint consumed by the play');
  assert.deepEqual(mergedColorTargets(after, memory), [], 'target NOT revived after a play-retirement');
  assert.deepEqual(memory.colorPlays, [], 'obligation dropped');
});

test('bot: colour-hint obligation is dropped once the target itself leaves the hand', () => {
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_3', 'blue_2', 'red_1', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'color', 'red'); // target slot 2 = red_1, playable now
  const memory = {};
  rememberColorTargets(viewState(s, 1).players[1].hand, memory, null);
  const targetId = viewState(s, 1).players[1].hand[2].id;
  assert.deepEqual(memory.colorPlays, [targetId]);

  playAction(s, 1, 2); // play the target
  rememberColorTargets(viewState(s, 1).players[1].hand, memory, 'play');
  assert.deepEqual(memory.colorPlays, [], 'target left the hand → obligation cleared');
});

test('bot: without memory, mergedColorTargets is exactly colorPlayTargets', () => {
  const s = craftedState(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_4', 'blue_2', 'red_2', 'green_3', 'yellow_2'],
  );
  hintAction(s, 0, 1, 'color', 'red');
  const hand = viewState(s, 1).players[1].hand;
  assert.deepEqual(mergedColorTargets(hand, null), colorPlayTargets(hand));
});

test('bot: a forced stall protects a partner\'s critical chop instead of a useless hint', () => {
  // Player 0 plays their 1, leaving a critical 5 (red_5, last copy) on their
  // chop. When the bot is reduced to stalling, the otherwise-wasted hint token
  // should protect that 5 rather than emit a do-nothing keep-hint.
  const s = craftedState(
    ['red_1', 'red_5', 'green_2', 'blue_2', 'yellow_2'],
    ['green_4', 'red_4', 'blue_4', 'white_4', 'yellow_3'],
    { next: ['green_3'] }, // player 0's draw after their play — not a 5
  );
  playAction(s, 0, 0); // p0 plays red_1; chop is now red_5 (critical)
  const view = viewState(s, 1);

  const prot = protectiveStall(view);
  assert.equal(prot.action.type, 'hint');
  assert.equal(prot.action.toPlayerIndex, 0);
  assert.match(prot.reason, /stall-save red 5/);
  // The hint actually touches red_5 — a number 5 keep, or a red colour pin.
  assert.ok(
    (prot.action.hintType === 'number' && prot.action.value === 5)
    || (prot.action.hintType === 'color' && prot.action.value === 'red'),
    `hint should cover red_5, got ${JSON.stringify(prot.action)}`,
  );
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

test('bot (2p): gives the next player a play hint instead of parking their critical chop', () => {
  // p1's chop is a critical red_5, but p1 also holds a playable green_1. Rather
  // than a bare "5" keep-save (which would make p1 discard a useful card next
  // turn to sit behind the clue), the bot hands them the green play hint: p1
  // plays instead of discarding, the red_5 survives untouched, and the bot —
  // strictly alternating in 2p — comes back to save it next turn.
  const s = craftedState(
    ['yellow_4', 'blue_4', 'green_2', 'white_2', 'red_4'],
    ['red_5', 'green_1', 'blue_3', 'white_3', 'yellow_3'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(
    action,
    { type: 'hint', toPlayerIndex: 1, hintType: 'color', value: 'green' },
    `should defer the red_5 save and hand p1 the green play (got: ${reason})`,
  );
  assert.match(reason, /defers red 5/);
});

test('bot (3p): the play-hint deferral does NOT apply — the critical chop is saved', () => {
  // Same shape as the 2p case, but with three players the strict-alternation
  // guarantee is gone, so the deferral is gated off and the bot saves red_5
  // with the plain "5" keep-hint (the pre-2.6 behaviour).
  const s = craftedState3(
    ['yellow_4', 'blue_4', 'green_2', 'white_2', 'red_4'],
    ['red_5', 'green_1', 'blue_3', 'white_3', 'yellow_3'],
    ['yellow_4', 'blue_4', 'white_4', 'red_3', 'green_3'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(
    action,
    { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 5 },
    `3p should save the critical chop, not defer (got: ${reason})`,
  );
});

test('bot: prefers a two-play "1" hint over a colour hint that reveals one', () => {
  // p1 holds two playable 1s of different colours (green_1, blue_1). A colour
  // hint reveals a single one; a lone "1" hint sends both. The colour-as-a-class
  // preference yields because the number hint starts strictly more cards playing.
  const s = craftedState(
    ['white_4', 'red_4', 'green_4', 'blue_3', 'yellow_4'],
    ['green_1', 'blue_1', 'red_3', 'white_3', 'yellow_3'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 1 }, reason);
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

test('bot: with guards unshared, infers its own alarm guarded the criticals and does not re-alarm', () => {
  // Same two-critical alarm as above (craftedState defaults shareGuarded off).
  // The first decision alarms; the second, with the driver memory carried over,
  // must treat the receiver's two oldest cards as guarded (we can't see the
  // marks) and NOT alarm again to "save" cards already protected.
  const s = craftedState(
    ['red_2', 'blue_3', 'white_1', 'green_3', 'yellow_1'],
    ['red_2', 'blue_3', 'yellow_4', 'green_4', 'white_4'],
  );
  hintAction(s, 0, 1, 'number', 4);
  hintAction(s, 1, 0, 'number', 1);
  discardAction(s, 0, 0);
  hintAction(s, 1, 0, 'number', 1);
  discardAction(s, 0, 0);
  hintAction(s, 1, 0, 'number', 1);
  const memory = {};
  const first = decide(viewState(s, 0), undefined, memory);
  assert.ok(first.reason.startsWith('ALARM'), `expected an alarm first (got: ${first.reason})`);
  assert.equal(memory.inferredGuards?.size, 2, 'the alarm should record two inferred guards');
  const second = decide(viewState(s, 0), undefined, memory);
  assert.ok(!(second.reason || '').startsWith('ALARM'),
    `should not re-alarm once guards are inferred (got: ${second.reason})`);
});

test('bot: hints the certain criticals instead of alarming when the only exposed card is a recoverable 2', () => {
  // p1's chop is a lone green_2 — its twin is still in the deck, so losing it
  // costs zero pile points — sitting in front of two critical 5s. One "5" hint
  // protects both 5s and exposes only that recoverable 2, so the bot just hints;
  // it does NOT burn a self-sacrificing alarm to protect a 2 the twin makes free.
  const s = craftedState(
    ['white_4', 'red_4', 'green_4', 'red_3', 'yellow_3'],
    ['green_2', 'blue_5', 'white_5', 'red_4', 'yellow_4'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 5 }, reason);
  assert.ok(!reason.startsWith('ALARM'), reason);
});

test('bot: sweep-saves two rainbow criticals with a colour hint that forces a dead-card misfire', () => {
  // Ann plays her red_1 (red pile → 1) and draws a second red_1, now dead.
  // Her hand becomes rainbow_5 (chop), rainbow_4, white_4, green_4, red_1(dead).
  // Both rainbow 5 and 4 are critical and no single NUMBER hint saves both — but
  // a red hint touches every rainbow card (and her dead red_1), with the dead
  // red_1 as the newest touched card. The bot gives it: both rainbows are clued
  // (off the chop) and the only play it induces is a harmless misfire.
  const s = craftedStateV('rainbowCritical',
    ['red_1', 'rainbow_5', 'rainbow_4', 'white_4', 'green_4'],
    ['yellow_2', 'blue_2', 'white_2', 'green_2', 'yellow_3'],
    { next: ['red_1'] },
  );
  playAction(s, 0, 0);
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 0, hintType: 'color', value: 'red' }, reason);
  assert.match(reason, /sweep-save/);
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

test('bot: forced-play signal — pointer discards, signal play, commanded play', () => {
  const s = craftedState(
    ['yellow_1', 'red_2', 'yellow_2', 'green_2', 'white_3'],
    ['green_1', 'white_2', 'red_4', 'blue_4', 'yellow_5'],
    { next: ['white_4'] },
  );
  const memA = {};
  const memB = {};
  const conv = undefined; // default conventions

  // Build the deadlock: p0 plays a 1 (so 2s become possibly playable), then
  // NUMBER hints lock p0's whole hand (keep-convention — no play
  // obligations) while p1's green_1 gets fully pinned. p1's chop discard of
  // white_2 makes p0's 2s possibly critical, so p0 stalls instead of
  // discarding a clued card.
  playAction(s, 0, 0);                       // yellow pile 1; p0 draws white_4
  hintAction(s, 1, 0, 'number', 2);          // touches p0's three 2s
  hintAction(s, 0, 1, 'number', 1);          // touches green_1
  discardAction(s, 1, 1);                    // chop discard: white_2 out
  hintAction(s, 0, 1, 'color', 'green');     // green_1 now fully pinned
  hintAction(s, 1, 0, 'number', 3);          // touches white_3
  hintAction(s, 0, 1, 'number', 5);          // touches yellow_5
  hintAction(s, 1, 0, 'number', 4);          // touches white_4 — p0 locked
  hintAction(s, 0, 1, 'number', 5);          // harmless re-touch: burn a token
  hintAction(s, 1, 0, 'number', 4);          // down to 1 token — true deadlock

  // p0 (locked receiver): armed, nothing commanded yet — stalls.
  const a1 = decide(viewState(s, 0), conv, memA);
  assert.equal(a1.action.type, 'hint', a1.reason);
  hintAction(s, 0, 1, a1.action.hintType, a1.action.value);

  // p1 (sender): p0's oldest possibly-playable (red_2) is NOT playable, the
  // next one (yellow_2) is — so advance the pointer with a chop discard
  // instead of playing the pinned green_1.
  const b1 = decide(viewState(s, 1), conv, memB);
  assert.deepEqual(b1.action, { type: 'discard', cardIndex: 1 }, b1.reason);
  assert.ok(b1.reason.startsWith('forced-play signal: advancing'), b1.reason);
  discardAction(s, 1, 1);

  // p0: counts the able-to-play discard, keeps stalling.
  const a2 = decide(viewState(s, 0), conv, memA);
  assert.equal(a2.action.type, 'hint', a2.reason);
  hintAction(s, 0, 1, a2.action.hintType, a2.action.value);

  // p1: pointer now matches the playable position — fire the signal.
  const b2 = decide(viewState(s, 1), conv, memB);
  assert.deepEqual(b2.action, { type: 'play', cardIndex: 0 }, b2.reason);
  assert.ok(b2.reason.startsWith('forced-play signal: play'), b2.reason);
  playAction(s, 1, 0);                       // green_1 plays

  // p0: obeys — plays pointer position 1 (yellow_2), which really plays.
  const a3 = decide(viewState(s, 0), conv, memA);
  assert.deepEqual(a3.action, { type: 'play', cardIndex: 1 }, a3.reason);
  assert.ok(a3.reason.startsWith('forced-play signal received'), a3.reason);
  playAction(s, 0, 1);
  assert.equal(s.playedPiles.yellow.length, 2, 'yellow_2 landed');
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

test('bot: endgame tie-break ranks a play-enabling hint over a dead misfire or inert hint', () => {
  // Deck empty, near-perfect: white pile at 4, everything else complete.
  // Ann (p0) holds the last white_5 (unclued) plus a dead blue_2; the bot (p1)
  // holds a provably dead red_1. Among moves the search proves reach the same
  // score, the tie-break must prefer telling Ann about white_5, and rank
  // "playing" the dead red_1 (a guaranteed misfire) below simply discarding it.
  let id = 0;
  const playedPiles = {};
  for (const color of ['red', 'yellow', 'green', 'blue']) {
    playedPiles[color] = [1, 2, 3, 4, 5].map((n) => bareCard(id++, color, n));
  }
  playedPiles.white = [1, 2, 3, 4].map((n) => bareCard(id++, 'white', n));
  const pin = (color, number) => ({
    ...bareCard(id++, color, number),
    possibleColors: [color], possibleNumbers: [number], colorClued: true, numberClued: true,
  });
  const s = {
    status: 'playing', variantId: 'simple', endRule: 'lax',
    shareGuarded: false, allowEmptyHints: false, seed: 1,
    players: [
      { id: 'a', name: 'Ann', hand: [bareCard(id++, 'white', 5), pin('blue', 2)] },
      { id: 'b', name: 'Bot', hand: [pin('red', 1)] },
    ],
    deck: [], discard: [], playedPiles,
    hintTokens: 3, fuseTokens: 3, currentPlayer: 1, turn: 40, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
  const view = viewState(s, 1);
  const myCombos = handCombos(view, 1);
  const h = (action) => endgameHelpfulness(view, action, myCombos);

  const hintWhite = h({ type: 'hint', toPlayerIndex: 0, hintType: 'color', value: 'white' });
  const hintBlue = h({ type: 'hint', toPlayerIndex: 0, hintType: 'color', value: 'blue' });
  const playDead = h({ type: 'play', cardIndex: 0 });
  const discardDead = h({ type: 'discard', cardIndex: 0 });

  assert.equal(hintWhite, 1, 'hinting white_5 enables Ann to play it');
  assert.equal(hintBlue, -1, 'a colour hint touching only the dead blue_2 is inert/misleading');
  assert.equal(playDead, -2, 'playing the provably dead red_1 is a guaranteed wasteful misfire');
  assert.equal(discardDead, 0, 'discarding the dead card is neutral');
  assert.ok(hintWhite > discardDead && discardDead > hintBlue && hintBlue > playDead,
    'ranking: enable-play > discard > inert hint > dead misfire');
});

function zeroHintState(allowEmptyHints) {
  // red pile at 2, green complete; Ann (p0) has nothing playable, Bot (p1)'s
  // chop red_3 is playable but not cleanly hintable (a red hint points at
  // red_5, a number-3 hint is ambiguous against dead green_3).
  let id = 0;
  const playedPiles = {
    red: [1, 2].map((n) => bareCard(id++, 'red', n)),
    green: [1, 2, 3, 4].map((n) => bareCard(id++, 'green', n)),
    yellow: [], blue: [], white: [],
  };
  return {
    status: 'playing', variantId: 'simple', endRule: 'lax',
    shareGuarded: false, allowEmptyHints, seed: 1,
    players: [
      { id: 'a', name: 'Ann', hand: [bareCard(id++, 'white', 5), bareCard(id++, 'blue', 4), bareCard(id++, 'yellow', 5)] },
      { id: 'b', name: 'Bot', hand: [bareCard(id++, 'red', 3), bareCard(id++, 'red', 5), bareCard(id++, 'blue', 4)] },
    ],
    deck: [], discard: [], playedPiles,
    hintTokens: 5, fuseTokens: 3, currentPlayer: 0, turn: 20, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
}

test('bot: zero-card-hint convention signals and plays the chop', () => {
  const s = zeroHintState(true);
  // Sender: no play, no ordinary play hint for Bot's chop → signal it empty.
  const send = decide(viewState(s, 0), undefined, {});
  assert.equal(send.action.type, 'hint', send.reason);
  assert.equal(send.action.toPlayerIndex, 1);
  assert.match(send.reason, /empty hint/);
  // It really touches nothing: a colour Bot wholly lacks (its cards are red/blue).
  assert.equal(send.action.hintType, 'color');
  assert.ok(!s.players[1].hand.some((c) => c.color === send.action.value),
    `empty hint colour ${send.action.value} must touch none of Bot's cards`);

  // Receiver: reads the empty hint as "play your chop" (red_3 at slot 0).
  hintAction(s, 0, 1, send.action.hintType, send.action.value);
  const recv = decide(viewState(s, 1), undefined, {});
  assert.deepEqual(recv.action, { type: 'play', cardIndex: 0 }, recv.reason);
  assert.match(recv.reason, /empty hint: play chop/);
});

test('bot: no empty-hint signal when the room disallows empty hints', () => {
  const s = zeroHintState(false);
  const send = decide(viewState(s, 0), undefined, {});
  assert.notEqual(send.action.type, 'hint', `should not hint (got ${send.reason})`);
});

// Bots playing whole games against each other: the strongest regression net —
// every rule interacts, and the game must actually end without the brain ever
// proposing an illegal action (rules.js throws on those).
function playOut(seed, playerCount) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` }));
  const state = createInitialState({ variantId: 'simple', endRule: 'lax', players, seed, shareGuarded: true });
  const memories = players.map(() => ({}));
  let guard = 0;
  while (state.status === 'playing' && guard++ < 500) {
    const idx = state.currentPlayer;
    for (const cardId of alarmGuards(viewState(state, idx))) {
      annotateAction(state, idx, cardId, { guarded: true });
    }
    const { action } = decide(viewState(state, idx), undefined, memories[idx]);
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
