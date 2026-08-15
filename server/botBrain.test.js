import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from './game.js';
import { getVariant } from './variants.js';
import { annotateAction, discardAction, hintAction, playAction } from './rules.js';
import { viewState } from './view.js';
import { STANDARD_CONVENTIONS, alarmGuardTargets, alarmGuards, chopIndex, colorPlayTargets, decide, endgameHelpfulness, handCombos, knownPlayable, mergedColorTargets, protectiveStall, rememberColorTargets } from './botBrain.js';

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
  // candidates — the obligation is back on. She holds it in the middle of her
  // hand, not on her chop: on the chop it is the most critical card on the
  // table and saving it outranks any play of ours (see the test below).
  const s = craftedStateV(
    'rainbowCriticalBlackReverse',
    ['white_3', 'green_4', 'black_1', 'yellow_4', 'blue_4'],
    ['red_1', 'white_2', 'green_3', 'yellow_2', 'blue_3'],
  );
  hintAction(s, 0, 1, 'number', 1); // touches the bot's red_1 only
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
});

test('bot: saves a black 1 on the chop with the "1" hint that reads as keep', () => {
  // The one card in a reverse variant a "1" hint is unambiguous about. Black is
  // never touched by a colour hint and black_1 is played last, so the number
  // hint is the ONLY way to protect it — and the receiver, unable to rule black
  // out, reads it as keep rather than as a play order. The bot used to screen
  // that hint out with a bare possiblyPlayable ("they'd misfire on it") and so
  // could never save the deck's most critical card; it discarded instead.
  const s = craftedStateV(
    'rainbowCriticalBlackReverse',
    ['white_4', 'white_3', 'green_4', 'yellow_4', 'blue_4'],
    ['black_1', 'red_2', 'green_3', 'yellow_2', 'blue_3'],
  );
  const { action, reason } = decide(viewState(s, 0));
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 1 }, reason);
});

test('bot: on the last fuse it trusts a FRESH "1" order and plays the oldest', () => {
  // A red 1 is already down, so the bot's 1s are only possibly playable — never
  // provable. The hinter checked they were playable when giving the order and no
  // 1 has been played since, so the guarantee still holds: trust it.
  const s = craftedState(
    ['red_1', 'white_3', 'green_4', 'yellow_4', 'blue_4'],
    ['yellow_1', 'green_1', 'white_2', 'green_3', 'blue_2'],
  );
  playAction(s, 0, 0);              // red 1 down — before the order
  hintAction(s, 1, 0, 'number', 3); // hand the turn back
  hintAction(s, 0, 1, 'number', 1); // the order: touches yellow_1 and green_1
  s.fuseTokens = 1;
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
});

test('bot: on the last fuse it does NOT trust a "1" order gone stale', () => {
  // Same position, but a 1 has been played since the order was given — it could
  // have taken the colour of what we hold, and we cannot tell. Demand proof.
  const s = craftedState(
    ['red_1', 'white_3', 'green_4', 'yellow_4', 'blue_4'],
    ['yellow_1', 'green_1', 'white_2', 'green_3', 'blue_2'],
  );
  playAction(s, 0, 0);
  hintAction(s, 1, 0, 'number', 3);
  hintAction(s, 0, 1, 'number', 1); // the order
  playAction(s, 1, 0);              // a 1 played AFTER it — order is now stale
  hintAction(s, 0, 1, 'number', 2); // hand the turn back
  s.fuseTokens = 1;
  const { action, reason } = decide(viewState(s, 1));
  assert.notEqual(action.type, 'play', `stale order must not be gambled: ${reason}`);
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

test('bot: alarms by throwing trash rather than a useful card when it has a play', () => {
  // The cheapest alarm of all: the thrown card is provably dead, so the only
  // price is the play given up — which is the whole signal. Preferred over
  // burning the useful touched card the alarm above settles for.
  const s = craftedState(
    ['red_1', 'yellow_5', 'blue_4', 'green_4', 'white_4'],
    ['red_2', 'red_2', 'blue_1', 'white_3', 'green_2'],
    { next: ['green_5', 'yellow_1'] },
  );
  playAction(s, 0, 0);                  // red 1
  playAction(s, 1, 0);                  // red 2 → the Bot's twin is dead
  hintAction(s, 0, 1, 'number', 2);     // pin the number first...
  hintAction(s, 1, 0, 'number', 4);     // stall
  hintAction(s, 0, 1, 'color', 'red');  // ...then the colour: provably dead, so no target
  hintAction(s, 1, 0, 'number', 4);     // stall
  hintAction(s, 0, 1, 'color', 'blue'); // a live target: blue 1, playable
  s.hintTokens = 0;                     // no way to hint Ann's critical yellow_5 chop
  const { action, reason } = decide(viewState(s, 1));
  assert.deepEqual(action, { type: 'discard', cardIndex: 0 }, reason);
  assert.match(reason, /^ALARM: discarding trash/, reason);
  // ...and the other end reads it: the same forgone play the sender priced in.
  discardAction(s, 1, action.cardIndex);
  const hand = s.players[0].hand;
  assert.deepEqual(alarmGuards(viewState(s, 0)), [hand[0].id], 'Ann guards her critical chop');
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

test('bot: throwing known trash instead of an obliged play raises the alarm', () => {
  // The cheapest alarm there is: the discarded card is provably dead, so it
  // costs the sender nothing but the play they gave up — which is exactly what
  // makes it deliberate. Read as routine trash disposal, the partner discarded
  // its own critical chop instead of guarding it.
  const build = (lastHint) => {
    const s = craftedState(
      ['red_1', 'red_2', 'yellow_1', 'green_4', 'white_4'],
      ['red_2', 'blue_3', 'green_2', 'blue_4', 'white_3'],
      { next: ['green_5'] },
    );
    playAction(s, 0, 0);                  // red 1
    playAction(s, 1, 0);                  // red 2 → Ann's own red 2 is now dead
    hintAction(s, 0, 1, 'number', 3);     // stall
    hintAction(s, 1, 0, 'color', 'red');  // ...
    hintAction(s, 0, 1, 'number', 4);     // stall
    hintAction(s, 1, 0, 'number', 2);     // ...pinned red 2: provably dead, so no target
    hintAction(s, 0, 1, 'color', 'blue'); // stall
    lastHint(s);
    discardAction(s, 0, 0);               // throw the dead red 2
    return s;
  };
  const withPlay = build((s) => hintAction(s, 1, 0, 'color', 'yellow')); // target: yellow 1
  const guards = alarmGuards(viewState(withPlay, 1));
  assert.ok(guards.length > 0, 'the forgone colour target makes the trash discard an alarm');
  // Control: same discard with nothing to play is exactly the routine disposal
  // the touched-discard screen is there to ignore.
  const noPlay = build((s) => hintAction(s, 1, 0, 'number', 4)); // a keep hint, no obligation
  assert.deepEqual(alarmGuards(viewState(noPlay, 1)), [], 'trash disposal alone is not a signal');
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

test('bot: a forced discard picks the safest card, not the oldest non-critical one', () => {
  // Every card clued, no tokens: the bot must throw something. Slot 0 is a
  // clued 2 that could be the last white_2 (the other is in the bin); slots
  // 1-4 are clued 3s with no 3 discarded, so none of them can be a last copy.
  // Screening only for *provably* critical passed slot 0 (four of its five
  // candidates are spare) and threw a possible last copy while holding four
  // provably safe cards.
  const s = craftedState(
    ['white_2', 'red_1', 'red_1', 'green_1', 'blue_1'],
    ['white_2', 'yellow_3', 'green_3', 'blue_3', 'red_3'],
  );
  hintAction(s, 0, 1, 'number', 2);          // touches p1's white_2
  hintAction(s, 1, 0, 'number', 1);          // touches p0's 1s (a pending play)
  discardAction(s, 0, 0);                    // p0's white_2 out — p1's is the last
  hintAction(s, 1, 0, 'number', 1);
  hintAction(s, 0, 1, 'number', 3);          // p1's four 3s — hand fully clued
  hintAction(s, 1, 0, 'number', 1);
  hintAction(s, 0, 1, 'number', 3);
  hintAction(s, 1, 0, 'number', 1);
  hintAction(s, 0, 1, 'number', 3);
  hintAction(s, 1, 0, 'number', 1);          // tokens exhausted
  playAction(s, 0, 1);                       // p0 plays a red_1; p1 is up
  assert.equal(s.hintTokens, 0);

  const d = decide(viewState(s, 1), undefined, {});
  assert.equal(d.action.type, 'discard', d.reason);
  assert.ok(d.action.cardIndex >= 1, `threw a possible last copy: ${JSON.stringify(d)}`);
});

// The 2-player token-starved deadlock the forced-play convention exists for:
// p0 plays a 1 (so 2s become possibly playable), then NUMBER hints lock p0's
// whole hand (keep-convention — no play obligations) while p1's green_1 gets
// fully pinned. p1's two discards put the second white_2 and a red_4 in the
// bin, so EVERY card p0 holds has a last-copy candidate — p0 is truly locked
// and stalls rather than discard (a card with no critical candidate would
// simply be thrown, see the "forced: least dangerous" branch). Ends on p0's
// turn with one token left. With `leaveChop`, the last hint goes elsewhere, so
// p0 keeps one unclued card and is NOT yet locked. With `obligePlay`, p0's last card is locked by a
// COLOUR hint instead of a number one, which makes it a live play target: only
// possibly playable, never provably so — the case a knownPlayable-only test
// misses.
function deadlockedPair({ obligePlay = false, leaveChop = false } = {}) {
  const s = craftedState(
    ['yellow_1', 'red_2', 'yellow_2', 'green_2', 'blue_2'],
    ['green_1', 'white_2', 'red_4', 'blue_4', 'yellow_5'],
    { next: ['white_4'] },
  );
  playAction(s, 0, 0);                       // yellow pile 1; p0 draws white_4
  hintAction(s, 1, 0, 'number', 2);          // touches p0's four 2s
  hintAction(s, 0, 1, 'number', 1);          // touches green_1
  discardAction(s, 1, 1);                    // chop discard: white_2 out
  hintAction(s, 0, 1, 'color', 'green');     // green_1 now fully pinned
  discardAction(s, 1, 1);                    // chop discard: red_4 out
  const lock = (st) => {
    if (leaveChop) return hintAction(st, 1, 0, 'number', 2); // re-touch: white_4 stays open
    return obligePlay
      ? hintAction(st, 1, 0, 'color', 'white')
      : hintAction(st, 1, 0, 'number', 4);   // either way white_4 is touched
  };
  hintAction(s, 0, 1, 'number', 5);          // touches yellow_5
  lock(s);                                   // p0 locked
  hintAction(s, 0, 1, 'number', 5);          // harmless re-touch: burn a token
  lock(s);                                   // harmless re-touch
  hintAction(s, 0, 1, 'number', 5);          // harmless re-touch
  lock(s);                                   // down to 1 token — true deadlock
  return s;
}

test('bot: forced-play signal — pointer discards, signal play, commanded play', () => {
  const s = deadlockedPair();
  const memA = {};
  const memB = {};
  const conv = undefined; // default conventions

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

test('bot: no forced-play deadlock when the locked seat is already obliged to play', () => {
  // The deadlock premise is that the locked seat CANNOT play. A live colour
  // target means it can — an obligation, even though only possibly playable —
  // so there is nothing to walk a pointer over, and reading the partner's next
  // play as a command would order some other card played instead of the one
  // the clue asked for.
  const s = deadlockedPair({ obligePlay: true });
  const locked = decide(viewState(s, 0), undefined, {});
  assert.deepEqual(locked.action, { type: 'play', cardIndex: 4 }, locked.reason);

  // The sender's gate is zero tokens; with the locked seat obliged to play,
  // there is no deadlock to signal into even there.
  s.hintTokens = 0;
  const sender = decide(viewState(s, 1), undefined, {});
  assert.ok(!sender.reason.startsWith('forced-play'), `nothing to signal: ${sender.reason}`);
});

test('bot: an alarm discard does not also advance the forced-play pointer', () => {
  // The move that arms us cannot also be a pointer advance. An alarm discard is
  // answered by guarding our chop — which is itself what locks our hand — so
  // reading that same discard as an advance sends the partner's next play one
  // card too far. The sender agrees by construction: it only ever advances over
  // a hand that already has no chop, and ours had one when they discarded.
  const s = deadlockedPair({ leaveChop: true }); // p0 still holds an unclued white_4
  const memA = {};
  hintAction(s, 0, 1, 'number', 5);                    // p0 stalls; down to 0 tokens
  discardAction(s, 1, 1);                              // partner's discard: an alarm
  annotateAction(s, 0, s.players[0].hand[4].id, { guarded: true }); // answered — now locked

  const a1 = decide(viewState(s, 0), undefined, memA);
  assert.equal(a1.action.type, 'hint', `armed, nothing commanded yet: ${a1.reason}`);
  assert.equal(memA.fpRole, 'receiver');
  assert.equal(memA.fpCount, 0, 'the discard that armed us is not an advance');
  hintAction(s, 0, 1, a1.action.hintType, a1.action.value);

  playAction(s, 1, 0);                                 // green_1: the signal
  const a2 = decide(viewState(s, 0), undefined, memA);
  assert.deepEqual(a2.action, { type: 'play', cardIndex: 0 },
    `pointer 0 — our oldest possibly-playable card: ${a2.reason}`);
});

test('bot: a play is no order when the player could not have discarded', () => {
  // Whether a play SPOKE depends on the hand that made it: with every card
  // clued or guarded, that turn was play-or-throw-a-keeper, so playing was
  // forced rather than chosen and commands nothing.
  const s = deadlockedPair();
  s.shareGuarded = true;              // "could have discarded" reads their guards
  const memA = {};
  hintAction(s, 0, 1, 'number', 5);   // p0 stalls; down to 0 tokens
  discardAction(s, 1, 1);             // p1's chop discard
  const a1 = decide(viewState(s, 0), undefined, memA);
  assert.equal(memA.fpRole, 'receiver', 'armed while the partner still has a chop');
  hintAction(s, 0, 1, a1.action.hintType, a1.action.value);

  // p1 answers an alarm of its own, guarding what is left unclued: no chop.
  for (const c of s.players[1].hand) {
    if (!c.colorClued && !c.numberClued) annotateAction(s, 1, c.id, { guarded: true });
  }
  assert.equal(chopIndex(s.players[1].hand), -1, 'the partner cannot discard by convention');
  decide(viewState(s, 0), undefined, memA);
  assert.equal(memA.fpRole, null, 'so nothing it does is a signal');
});

// Ann locked with every card clued, the bot holding a chop and no tokens left:
// the bot's play is an order she answers by playing the card the pointer reaches
// — her OLDEST possibly-playable one, which is whatever `annFirst` puts in front.
function orderedPlayPair(annFirst, annSecond) {
  const s = craftedState(
    ['yellow_1', annFirst, annSecond, 'yellow_2', 'blue_2'],
    ['green_1', 'white_2', 'red_4', 'blue_4', 'yellow_5'],
    { next: ['white_4'] },
  );
  playAction(s, 0, 0);                 // yellow 1; Ann draws white_4
  hintAction(s, 1, 0, 'number', 2);    // locks Ann's three 2s
  hintAction(s, 0, 1, 'number', 5);    // filler (touches yellow_5)
  discardAction(s, 1, 1);              // white_2 out → Ann's white_2 is the last copy
  hintAction(s, 0, 1, 'number', 5);
  hintAction(s, 1, 0, 'number', 4);    // white_4 touched — Ann fully locked
  hintAction(s, 0, 1, 'number', 5);
  hintAction(s, 1, 0, 'number', 4);
  hintAction(s, 0, 1, 'color', 'green'); // a colour target for the bot: not pinned
  hintAction(s, 1, 0, 'number', 4);
  hintAction(s, 0, 1, 'color', 'green'); // ...down to 0 tokens, target re-marked
  assert.equal(chopIndex(s.players[0].hand), -1, 'Ann is locked');
  assert.ok(chopIndex(s.players[1].hand) >= 0, 'the bot could discard instead');
  assert.equal(s.hintTokens, 0, 'and the bank is empty');
  return s;
}

test('bot: withholds a play that would order the partner into a costly one', () => {
  // The pointer reaches Ann's last white 2 — four pile points — against a chop
  // the bot barely values. Not the bot's play to make, however good it is for
  // the bot.
  const s = orderedPlayPair('white_2', 'red_2');
  const off = decide(viewState(s, 1), { ...STANDARD_CONVENTIONS, forcedPlaySignals: false }, {});
  assert.deepEqual(off.action, { type: 'play', cardIndex: 0 },
    `with the convention off it simply plays: ${off.reason}`);
  const on = decide(viewState(s, 1), undefined, {});
  assert.equal(on.action.type, 'discard', `with it on the play is withheld: ${on.reason}`);
});

test('bot: makes the same play when the order it carries is cheap', () => {
  // Same position and the same last white 2 in Ann's hand — only now the
  // pointer reaches a red 2 first, whose twin is still out there. Losing that
  // costs nothing, so there is nothing to stay quiet about.
  // Pricing the WORST card the pointer might ever reach instead of the one it
  // does had the bot sitting on plays while its partner burned hints stalling.
  const s = orderedPlayPair('red_2', 'white_2');
  const { action, reason } = decide(viewState(s, 1), undefined, {});
  assert.deepEqual(action, { type: 'play', cardIndex: 0 }, reason);
});

test('bot: a discard with no chop and no play is not an alarm', () => {
  // The same critical chop as the alarm test above, but nothing the bot could
  // have thrown instead: every option was a bad discard, so throwing the
  // cheapest is damage control, not a message — and unreadable as one at the
  // other end, which screens exactly this.
  const s = craftedState(
    ['green_3', 'yellow_4', 'blue_4', 'white_4', 'red_2'],
    ['yellow_5', 'red_4', 'blue_4', 'green_4', 'white_2'],
  );
  s.shareGuarded = true;            // so the other end can see we had no chop
  hintAction(s, 0, 1, 'number', 4); // keeps p1's chop on the critical yellow_5
  hintAction(s, 1, 0, 'number', 3); // touches p0's green_3
  s.hintTokens = 0;
  for (const c of s.players[0].hand) {
    if (!c.colorClued && !c.numberClued) annotateAction(s, 0, c.id, { guarded: true });
  }
  assert.equal(chopIndex(s.players[0].hand), -1, 'nothing it could have thrown instead');

  const { action, reason } = decide(viewState(s, 0));
  assert.equal(action.type, 'discard', reason);
  assert.ok(!reason.startsWith('ALARM'), `a forced discard is not an alarm: ${reason}`);
  discardAction(s, 0, action.cardIndex);
  assert.deepEqual(alarmGuards(viewState(s, 1)), [], 'and the other end reads none');
});

test('bot: with two plays to choose from, plays the one that opens the partner', () => {
  // Both cards are colour targets, so both are going to be played; the choice
  // is one of order, and only the yellow 4 lands the card Ann's hand is waiting
  // on. Oldest-hint-first would take the red 3 and buy nobody anything.
  const s = craftedState(
    ['yellow_1', 'yellow_2', 'yellow_3', 'red_1', 'red_2'],
    ['red_3', 'yellow_4', 'blue_4', 'green_4', 'white_4'],
    { next: ['yellow_5', 'white_1', 'white_2', 'white_3', 'green_1'] },
  );
  // Ann plays her yellows then her reds, leaving yellow on 3 and red on 2; the
  // bot spends the turns between pinning the yellow_5 she draws first.
  playAction(s, 0, 0); hintAction(s, 1, 0, 'number', 5);
  playAction(s, 0, 0); hintAction(s, 1, 0, 'number', 5);
  playAction(s, 0, 0); hintAction(s, 1, 0, 'color', 'yellow'); // her yellow_5, now alone
  playAction(s, 0, 0); hintAction(s, 1, 0, 'number', 5);
  playAction(s, 0, 0); hintAction(s, 1, 0, 'number', 5);
  hintAction(s, 0, 1, 'color', 'red');    // older target: the red 3
  hintAction(s, 1, 0, 'number', 5);
  hintAction(s, 0, 1, 'color', 'yellow'); // newer target: the yellow 4

  const ann = s.players[0].hand[0];
  assert.equal(`${ann.color} ${ann.number}`, 'yellow 5', 'Ann is waiting on the yellow 4');
  const { action, reason } = decide(viewState(s, 1), undefined, {});
  assert.deepEqual(action, { type: 'play', cardIndex: 1 }, reason);
  assert.match(reason, /opens a play/, reason);
});

test('bot: a 2 in a suit played 5→1 is not saved as a "2"', () => {
  // The 2-save protects an EARLY card. Where the suit runs 5→1 the 2 is the
  // second to last card of its pile — a 4 by any other name — so none of the
  // reasons to protect a 2 on sight apply to it.
  const reasonFor = (chopCard) => {
    const s = craftedStateV('rainbowCriticalBlackReverse',
      [chopCard, 'red_3', 'red_4', 'green_3', 'green_4'],   // Ann: chop is chopCard
      ['white_3', 'white_4', 'blue_3', 'blue_4', 'yellow_3'],
    );
    hintAction(s, 0, 1, 'number', 3); // hand the turn to the bot, tokens to spare
    return decide(viewState(s, 1), undefined, {}).reason;
  };
  const black = reasonFor('black_2');
  assert.ok(!/save black 2/.test(black), `a reversed 2 is not an early card: ${black}`);
  // ...whereas the same chop in an ordinary 1→5 suit is saved.
  assert.match(reasonFor('blue_2'), /save blue 2/);
});

test('bot: does not spend a 2-save that locks the partner out of discarding', () => {
  // A precaution is not worth leaving them unable to discard: locked, they must
  // stall or throw a card the team paid a hint to keep, which is a worse place
  // to be than one 2 down — its twin is still out there.
  const s = craftedState(
    ['blue_2', 'red_3', 'red_4', 'green_3', 'green_4'],  // chop: the lone blue 2
    ['white_3', 'white_4', 'yellow_3', 'yellow_4', 'green_5'],
  );
  hintAction(s, 0, 1, 'number', 3);
  hintAction(s, 1, 0, 'number', 3);   // clue Ann's 3s...
  hintAction(s, 0, 1, 'number', 4);
  hintAction(s, 1, 0, 'number', 4);   // ...and her 4s: only the blue 2 is left open
  hintAction(s, 0, 1, 'number', 5);   // hand the turn back, three tokens left
  assert.equal(chopIndex(s.players[0].hand), 0, 'the blue 2 is her chop');
  assert.ok(s.hintTokens >= 3, 'and tokens are not what stops the save');
  const { reason } = decide(viewState(s, 1), undefined, {});
  assert.ok(!/save blue 2/.test(reason), `the save would lock her hand: ${reason}`);
});

test('bot: keeps the last hints for better things than a 2-save', () => {
  // Same lone 2, but with harmless cards left open behind it, so the save would
  // neither lock her nor be outranked by a dearer chop — only the tokens decide.
  const s = craftedState(
    ['blue_2', 'red_3', 'red_4', 'green_3', 'green_4'],
    ['white_3', 'white_4', 'yellow_3', 'yellow_4', 'green_5'],
  );
  hintAction(s, 0, 1, 'number', 3);
  hintAction(s, 1, 0, 'number', 3);   // her 4s stay open behind the 2
  hintAction(s, 0, 1, 'number', 5);
  assert.equal(chopIndex(s.players[0].hand), 0, 'the blue 2 is her chop');
  s.hintTokens = 3;
  assert.match(decide(viewState(s, 1), undefined, {}).reason, /save blue 2/, 'saved at three');
  s.hintTokens = 2;
  const tight = decide(viewState(s, 1), undefined, {}).reason;
  assert.ok(!/save blue 2/.test(tight), `not at two: ${tight}`);
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

test('bot: gambles a dead-or-playable card rather than throw a possible last copy', () => {
  // The red pile is on 4 and the bot holds a red-clued card whose every
  // candidate is either already played or the red 5 — worthless kept, since a
  // dead candidate never becomes playable. Its only other card is a pinned
  // white 5. Nothing is safe to discard, so playing the red is the better bet:
  // it costs at most a fuse, while discarding it can cost the red 5 outright.
  let id = 0;
  const playedPiles = { yellow: [], green: [], blue: [], white: [] };
  playedPiles.red = [1, 2, 3, 4].map((n) => bareCard(id++, 'red', n));
  // Spare red 1s/2s/3s in the bin, so the red-clued card is down to a dead
  // red 4 or the live red 5 — exactly even odds, the threshold for gambling.
  const discard = [1, 1, 2, 3].map((n) => bareCard(id++, 'red', n));
  const clued = (color, number, colors, numbers) => ({
    ...bareCard(id++, color, number),
    possibleColors: colors, possibleNumbers: numbers,
    colorClued: colors.length === 1, numberClued: numbers.length === 1,
  });
  const s = {
    status: 'playing', variantId: 'simple', endRule: 'lax',
    shareGuarded: false, allowEmptyHints: false, seed: 1,
    players: [
      { id: 'a', name: 'Ann', hand: [bareCard(id++, 'green', 1), bareCard(id++, 'green', 3)] },
      { id: 'b', name: 'Bot', hand: [clued('red', 5, ['red'], [1, 2, 3, 4, 5]), clued('white', 5, ['white'], [5])] },
    ],
    deck: [1, 2, 3, 4, 5].map((n) => bareCard(id++, 'blue', n)),
    discard, playedPiles,
    hintTokens: 0, fuseTokens: 3, currentPlayer: 1, turn: 20, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
  const d = decide(viewState(s, 1), undefined, {});
  assert.deepEqual(d.action, { type: 'play', cardIndex: 0 }, d.reason);
  assert.ok(d.reason.startsWith('gamble:'), d.reason);

  // On the last fuse the bet is off — a misfire would end the game.
  s.fuseTokens = 1;
  const safe = decide(viewState(s, 1), undefined, {});
  assert.equal(safe.action.type, 'discard', safe.reason);
});

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

test('bot: endgame search still runs with a wholly unclued hand (24 worlds)', () => {
  // The shape a human partner produces: the bot's four cards were never clued,
  // so every slot reads as any of the four unseen identities — 24 worlds, which
  // an enumeration that mis-restored its copy counts inflated past the cap,
  // silently switching the search off exactly where it is needed most.
  // Piles: red/green/white complete, blue at 4 (blue_5 discarded), yellow at 2.
  // Bot holds red_1, yellow_3, blue_1, blue_2 (only the yellow_3 is live);
  // Ann holds the last yellow_4, so the conventions want to burn the last token
  // saving a card she is going to keep anyway — with one point sitting in the
  // bot's own hand.
  let id = 0;
  const playedPiles = {};
  const discard = [];
  const bin = (color, numbers) => { for (const n of numbers) discard.push(bareCard(id++, color, n)); };
  for (const color of ['green', 'white']) {
    playedPiles[color] = [1, 2, 3, 4, 5].map((n) => bareCard(id++, color, n));
    bin(color, [1, 1, 2, 3, 4]);
  }
  playedPiles.red = [1, 2, 3, 4, 5].map((n) => bareCard(id++, 'red', n));
  bin('red', [1, 2, 3, 4]); // one red_1 left over — it's in the bot's hand
  playedPiles.blue = [1, 2, 3, 4].map((n) => bareCard(id++, 'blue', n));
  bin('blue', [1, 3, 4, 5]);
  playedPiles.yellow = [1, 2].map((n) => bareCard(id++, 'yellow', n));
  bin('yellow', [1, 1, 2, 3, 4, 5]);
  const s = {
    status: 'playing', variantId: 'simple', endRule: 'lax',
    shareGuarded: false, allowEmptyHints: false, seed: 1,
    players: [
      { id: 'a', name: 'Ann', hand: [bareCard(id++, 'yellow', 4)] },
      {
        id: 'b',
        name: 'Bot',
        hand: [bareCard(id++, 'red', 1), bareCard(id++, 'yellow', 3),
          bareCard(id++, 'blue', 1), bareCard(id++, 'blue', 2)],
      },
    ],
    deck: [], discard, playedPiles,
    hintTokens: 1, fuseTokens: 3, currentPlayer: 1, turn: 40, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
  const view = viewState(s, 1);
  assert.equal(handCombos(view, 1)[0].length, 4, 'each slot reads as one of the four unseen cards');

  const { action, reason } = decide(view, undefined, {});
  assert.ok(reason.startsWith('endgame search (24 worlds'), `expected a searched decision (got: ${reason})`);
  // Spending the last token on Ann leaves her unable to hint back, so the
  // yellow_3 can never be found: the search takes the fuse risk instead.
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

// From a real game (perfect 35/35, move 61): the receiver's chop was a playable
// black 4 — the LAST copy — and the bot parked it behind a "4" keep-hint, which
// also left every card in the hand clued. Black is `hintMatches: 'none'`, so no
// colour hint reaches it and a number hint means keep: the save path simply had
// no way to say "play this". The zero-card-hint signal is the way, and it only
// ever ran as a step-4b fallback that an urgent save returns long before.
function blackChopSaveState(allowEmptyHints) {
  let id = 0;
  const card = (color, number) => ({
    id: id++, color, number,
    possibleColors: ['red', 'yellow', 'green', 'blue', 'white', 'rainbow', 'black'],
    possibleNumbers: [1, 2, 3, 4, 5],
    colorClued: false, numberClued: false, lastHints: [],
    annotations: { note: '', guarded: false },
  });
  const clued = (color, number) => ({
    ...card(color, number),
    possibleColors: [color], possibleNumbers: [number],
    colorClued: true, numberClued: true,
  });
  return {
    status: 'playing', variantId: 'rainbowCriticalBlackReverse', endRule: 'lax',
    shareGuarded: true, allowEmptyHints, seed: 1,
    players: [
      // Sender: nothing playable, nothing to say by ordinary means.
      { id: 'a', name: 'Ann', hand: [card('green', 4), card('white', 4), card('rainbow', 2)] },
      // Receiver: chop is the black 4 (playable — black runs 5→1 and its 5 is
      // down), everything older is already clued. A "4" hint can't prove it
      // playable, because the red 4 is playable too.
      { id: 'b', name: 'Bot', hand: [clued('green', 5), clued('yellow', 5), card('black', 4)] },
    ],
    deck: [],
    // The other black 4 is gone, so the chop is a certain last copy.
    discard: [card('black', 4)],
    playedPiles: {
      red: [1, 2, 3].map((n) => card('red', n)),
      yellow: [1, 2, 3].map((n) => card('yellow', n)),
      green: [1, 2].map((n) => card('green', n)),
      blue: [], white: [], rainbow: [],
      black: [card('black', 5)],
    },
    hintTokens: 1, fuseTokens: 3, currentPlayer: 0, turn: 40, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
}

test('bot: saves a playable black chop by signalling it, not by parking it', () => {
  const s = blackChopSaveState(true);
  const send = decide(viewState(s, 0), undefined, {});
  assert.equal(send.action.type, 'hint', send.reason);
  assert.equal(send.action.toPlayerIndex, 1);
  assert.match(send.reason, /save black 4 on chop \(signal\)/);
  // It really is an empty hint — a "4" would touch the chop and read as keep.
  const touched = s.players[1].hand.filter((c) => (send.action.hintType === 'number'
    ? c.number === send.action.value
    : c.color === send.action.value));
  assert.equal(touched.length, 0, `${send.action.hintType} ${send.action.value} must touch nothing`);

  // And the receiver plays the black 4 rather than sitting on it.
  hintAction(s, 0, 1, send.action.hintType, send.action.value);
  const recv = decide(viewState(s, 1), undefined, {});
  assert.deepEqual(recv.action, { type: 'play', cardIndex: 2 }, recv.reason);
});

test('bot: a teammate under a live empty-hint signal needs no save from us', () => {
  const s = blackChopSaveState(true);
  s.players.push({ id: 'c', name: 'Cy', hand: [] });
  s.players[2].hand = s.players[0].hand.map((c, i) => ({ ...c, id: 90 + i }));
  s.hintTokens = 2;
  s.currentPlayer = 2;
  // Cy signals Bot's chop with an empty hint (Bot holds no blue). By the time
  // it comes round to Ann, Bot is committed to playing that chop — so Ann must
  // not spend the last token saving a card that is already on its way out.
  hintAction(s, 2, 1, 'color', 'blue');
  assert.equal(s.currentPlayer, 0);
  const send = decide(viewState(s, 0), undefined, {});
  assert.ok(!(send.action.type === 'hint' && send.action.toPlayerIndex === 1),
    `should not re-save Bot's signalled chop (got ${send.reason})`);
});

test('bot: falls back to the keep-hint when the room disallows empty hints', () => {
  const s = blackChopSaveState(false);
  const send = decide(viewState(s, 0), undefined, {});
  assert.deepEqual(send.action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 4 }, send.reason);
});

// Cards for the hand-rolled states below (5-colour variants).
function plainCard(id, color, number, opts = {}) {
  return {
    id, color, number,
    possibleColors: opts.possibleColors ?? COLORS.slice(),
    possibleNumbers: opts.possibleNumbers ?? [1, 2, 3, 4, 5],
    colorClued: !!opts.colorClued, numberClued: !!opts.numberClued,
    lastHints: opts.lastHints ?? [],
    annotations: { note: '', guarded: false },
  };
}

// From a real game (turn 14): the receiver's chop was a lone 2 with its twin
// still in the deck — worth ZERO pile points if thrown — and the only save, a
// "2", touched every unclued card in the hand, locking it. findSaveHint
// correctly declines that (one 2 down beats a locked hand), and the alarm
// branch then read the resulting null as "no save exists" and burned a card on
// the very danger the hint path had just priced as not worth a token.
function declinedSaveState({ chopCritical = false } = {}) {
  let id = 0;
  const c = (color, number, opts) => plainCard(id++, color, number, opts);
  const clued = { numberClued: true, possibleNumbers: [3] };
  return {
    status: 'playing', variantId: 'simple', endRule: 'lax',
    shareGuarded: true, allowEmptyHints: false, seed: 1,
    players: [
      // Sender: a number-clued 3 — useful whatever it is, not provably playable,
      // no candidate critical — which is exactly the card alarm type 1 burns,
      // plus an unclued chop so an alarm is a choice she could make at all.
      { id: 'a', name: 'Ann', hand: [c('red', 3, { numberClued: true, possibleNumbers: [3] }), c('red', 4)] },
      // Receiver: two number-clued 3s, then three unclued 2s. A "2" hint touches
      // all three, so every card ends up clued — a locked hand.
      { id: 'b', name: 'Bot', hand: [c('red', 3, clued), c('yellow', 3, clued), c('blue', 2), c('yellow', 2), c('white', 2)] },
    ],
    deck: [c('white', 4), c('red', 1)],
    // The blue 2's twin is still out (precaution) unless the test asks for a
    // genuine last copy, which is worth the lock and must still be saved.
    discard: chopCritical ? [c('blue', 2)] : [],
    playedPiles: { red: [], yellow: [], green: [c('green', 1), c('green', 2)], blue: [], white: [] },
    hintTokens: 3, fuseTokens: 3, currentPlayer: 0, turn: 14, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
}

test('bot: a save declined as not worth a token is not worth a card either', () => {
  const s = declinedSaveState();
  const { action, reason } = decide(viewState(s, 0), undefined, {});
  assert.ok(!/ALARM/.test(reason),
    `must not alarm over a save it declined to spend a hint on (got ${reason})`);
  // And it does not silently give the locking hint either — the decision that
  // the lock is not worth it still stands.
  assert.ok(!(action.type === 'hint' && action.hintType === 'number' && action.value === 2),
    `must not give the locking "2" hint either (got ${reason})`);
});

test('bot: a chop worth locking a hand for is still saved', () => {
  const s = declinedSaveState({ chopCritical: true });
  const { action, reason } = decide(viewState(s, 0), undefined, {});
  assert.deepEqual(action, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: 2 }, reason);
});

// From the same game (turn 58): a bot threw the last unseen white 1 off its
// chop — the most routine move there is — and its partner guarded two cards.
// The throw itself was what pinned the bot's colour-clued {white 1, white 4} to
// the playable white 4, so alarmGuards, reading the post-discard state, saw a
// play the discarder had "declined". It had no such play when it decided.
function pinningDiscardState() {
  let id = 0;
  const c = (color, number, opts) => plainCard(id++, color, number, opts);
  const white = { colorClued: true, possibleColors: ['white'] };
  return {
    status: 'playing', variantId: 'simple', endRule: 'lax',
    shareGuarded: true, allowEmptyHints: false, seed: 1,
    players: [
      // Ann's slot 0 reads {white 1, white 4}: every other white is accounted
      // for in the piles and the discard. Not playable yet — the white 1
      // candidate is dead, the white 4 is not. Slot 1 is her chop, and it holds
      // the third and last white 1.
      { id: 'a', name: 'Ann', hand: [c('white', 4, white), c('white', 1)] },
      { id: 'b', name: 'Bot', hand: [c('blue', 3), c('red', 2), c('green', 4)] },
    ],
    deck: [c('red', 1), c('green', 1)],
    discard: [c('white', 1), c('white', 2), c('white', 3), c('white', 4), c('white', 5)],
    playedPiles: {
      red: [], yellow: [], green: [], blue: [],
      white: [c('white', 1), c('white', 2), c('white', 3)],
    },
    hintTokens: 0, fuseTokens: 3, currentPlayer: 0, turn: 30, finalTurn: null,
    log: [], endReason: null, nextHintIndex: 0, nextLogSeq: 0,
    startedAt: 0, endedAt: null, initialDeckCards: [],
  };
}

test('bot: a discard that pins its own hand is not thereby an alarm', () => {
  const s = pinningDiscardState();
  const before = handCombos(viewState(s, 1), 0);
  assert.equal(before[0].length, 2, 'slot 0 must be ambiguous before the throw');
  assert.ok(!knownPlayable(viewState(s, 1), before[0]), 'and not yet a play');

  discardAction(s, 0, 1); // Ann throws her chop, the last unseen white 1
  const v = viewState(s, 1);
  assert.ok(knownPlayable(v, handCombos(v, 0)[0]),
    'the throw pins slot 0 to the playable white 4 — the drift this test is about');
  assert.deepEqual(alarmGuards(v), [],
    'but she had no play when she decided, so a routine chop discard is no alarm');
});

// Bots playing whole games against each other: the strongest regression net —
// every rule interacts, and the game must actually end without the brain ever
// proposing an illegal action (rules.js throws on those).
function playOut(seed, playerCount, { onAlarm, variantId = 'simple' } = {}) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` }));
  const state = createInitialState({ variantId, endRule: 'lax', players, seed, shareGuarded: true });
  const memories = players.map(() => ({}));
  let guard = 0;
  while (state.status === 'playing' && guard++ < 500) {
    const idx = state.currentPlayer;
    for (const cardId of alarmGuards(viewState(state, idx))) {
      annotateAction(state, idx, cardId, { guarded: true });
    }
    const { action, reason } = decide(viewState(state, idx), undefined, memories[idx]);
    switch (action.type) {
      case 'play': playAction(state, idx, action.cardIndex); break;
      case 'discard': discardAction(state, idx, action.cardIndex); break;
      case 'hint': hintAction(state, idx, action.toPlayerIndex, action.hintType, action.value); break;
      default: throw new Error(`bot proposed unknown action ${action.type}`);
    }
    if (onAlarm && reason?.startsWith('ALARM') && state.status === 'playing') {
      const next = (idx + 1) % playerCount;
      const view = viewState(state, next);
      onAlarm({ reason, seed, view, read: alarmGuards(view), owed: alarmGuardTargets(view, next, 1) });
    }
  }
  assert.equal(state.status, 'finished', `game did not end (seed ${seed})`);
  return state;
}

test('bot vs bot: alarms these games used to raise unreadably are read now', () => {
  // A signal has to be readable from the RECEIVER's chair, and their chair sees
  // less than ours. Two ways that drifted, both live in the games below:
  //   - we counted the cards in THEIR hand to prove the play we then "declined",
  //     so what we called a forgone play was, to them, no reason for anything;
  //   - they judged the thrown card by a pile cap our own sacrifice had just
  //     lowered — throwing the last copy of a needed card is exactly what caps
  //     its pile short of it — so the loudest alarm in the book read as trash.
  // Each of these games contained an alarm nobody read before the fix.
  //
  // Not asserted globally, and deliberately: when no certainly-useful card is
  // in reach the bot still throws a merely-possibly-useful one, which lands
  // dead often enough to be dismissed. That gamble is the right one — the
  // danger it points at is certain, and the alternative is silence.
  const games = [
    ['simple', 2, 16], ['simple', 3, 31], ['rainbow', 2, 28],
    ['rainbowCritical', 4, 14], ['rainbowCriticalBlack', 3, 29],
    ['rainbowCriticalBlackReverse', 3, 35],
  ];
  let alarms = 0;
  for (const [variantId, playerCount, seed] of games) {
    playOut(seed, playerCount, {
      variantId,
      onAlarm({ reason, view, read, owed }) {
        alarms++;
        if (view.deckSize === 0) return;  // the endgame search decides for itself
        if (owed.length === 0) return;    // nothing left for them to guard
        assert.ok(read.length > 0,
          `alarm nobody reads (${variantId} ${playerCount}p seed ${seed}): ${reason}`);
      },
    });
  }
  assert.ok(alarms > 0, 'the games should have contained alarms to check');
});

test('bot vs bot: full games end legally with a sane score', () => {
  for (const [seed, playerCount] of [[1, 2], [2, 3], [3, 4], [42, 2], [99, 3]]) {
    const end = playOut(seed, playerCount);
    const score = Object.values(end.playedPiles).reduce((a, p) => a + p.length, 0);
    assert.ok(score >= 8, `seed ${seed} (${playerCount}p): score ${score} suspiciously low`);
  }
});

test('bot (3p): leaves the far hint to a locked player whose turn is a hint anyway', () => {
  // Bot's hand is entirely clued, so it has nothing it can throw: its turn is
  // going to be speech whatever we do. Giving Cy's play hint ourselves would
  // spend our turn on the one thing that player's forced turn can do for free.
  const s = craftedState3(
    ['white_4', 'white_3', 'blue_4', 'green_4', 'yellow_4'],
    ['red_3', 'yellow_3', 'green_3', 'blue_3', 'white_3'],
    ['yellow_3', 'blue_3', 'red_4', 'red_2', 'green_1'],
  );
  hintAction(s, 0, 1, 'number', 3); // clues every card Bot holds — locked
  hintAction(s, 1, 0, 'number', 3); // harmless, hands the turn on
  hintAction(s, 2, 0, 'number', 3); // …and back to us
  const { action, reason } = decide(viewState(s, 0));
  assert.notEqual(action.type, 'hint', `Cy's hint is Bot's to give: ${reason}`);
  assert.deepEqual(action, { type: 'discard', cardIndex: 0 }, reason);
});

test('bot (3p): a save that can wait yields to our own play — but never over a last copy', () => {
  // Bot owes Cy a play hint, so Bot's turn is speech and their chop is not in
  // danger this round. Our own play goes first; the save is still there next
  // turn, because we always act immediately before them.
  const waits = craftedState3(
    ['red_1', 'white_4', 'blue_4', 'green_4', 'yellow_4'],
    ['green_2', 'white_3', 'blue_3', 'red_3', 'blue_4'],
    ['yellow_4', 'white_4', 'green_4', 'red_4', 'blue_1'],
  );
  // The "3" leaves Bot two unclued cards: the chop it lands on (the lone green
  // 2) and a spare, so the save we are weighing here is one that can actually
  // be given — a precaution that would lock their hand is refused outright.
  hintAction(waits, 0, 1, 'number', 3);
  hintAction(waits, 1, 2, 'number', 4); // leaves Cy's chop on the playable blue 1
  hintAction(waits, 2, 0, 'number', 1); // gives us a play of our own
  const a = decide(viewState(waits, 0));
  assert.deepEqual(a.action, { type: 'play', cardIndex: 0 }, a.reason);

  // Same shape, but Bot's chop is the only green 5 there will ever be. A save
  // ends that danger for good; occupying their turn only postpones it, and
  // postponing a last copy is the same bet taken again every round.
  const cannotWait = craftedState3(
    ['red_1', 'white_4', 'blue_4', 'green_4', 'yellow_4'],
    ['green_5', 'white_3', 'blue_3', 'red_3', 'blue_4'],
    ['yellow_4', 'white_4', 'green_4', 'red_4', 'blue_1'],
  );
  hintAction(cannotWait, 0, 1, 'number', 3);
  hintAction(cannotWait, 1, 2, 'number', 4);
  hintAction(cannotWait, 2, 0, 'number', 1);
  const b = decide(viewState(cannotWait, 0));
  assert.equal(b.action.type, 'hint', `the green 5 cannot wait: ${b.reason}`);
  assert.equal(b.action.toPlayerIndex, 1, b.reason);
});
