// How often is a DEFERRED play hint available? — the measurement behind the
// "Deferred plays" section of BOT_ROADMAP.md.
//
// A deferred play hint is one whose focus card is NOT playable now, IS playable
// once the plays already obliged resolve, and which the receiver will be able to
// PROVE playable when that moment comes. The last clause is the safety gate in
// the proposed design: a target held until provable can never misfire, and a
// deferred play whose moment never comes is simply held — which is exactly what
// today's "pin" save already means.
//
// Method: play bot-vs-bot games with the real brain, and at every decision with
// a token to spend, try every legal hint to every teammate. The projected world
// is built by cloning the true state, applying the queue of obliged plays with
// the real engine, and re-viewing it — so the receiver's post-hint deduction is
// computed by the same code that would run at the table.
//
// Colour hints only count as vehicles: a number hint means *keep* under these
// conventions, so it cannot carry a play order today.
//
// What the numbers are and are not: an upper bound on OPPORTUNITY, not on value.
// Most of those cards would be hinted a turn or two later anyway, so what is
// really at stake is tempo, and only a benchmark of the built thing settles what
// tempo is worth. The count is conservative in four ways — one round of queue
// only, no draws projected, the giver cannot model a teammate seeing our own
// hand, and cards already carrying a live colour marker are skipped — so the
// true rate is somewhat higher. It also measures the positions *this* bot
// reaches; a bot that pre-loads hints would reach different ones.
//
// Usage: node deferred-opportunity.mjs [--seeds N] [--players 2,3,4]
//                                      [--variants a,b] [--end lax|standard]
import { createInitialState } from './server/game.js';
import { annotateAction, discardAction, hintAction, playAction } from './server/rules.js';
import { viewState } from './server/view.js';
import { VARIANTS, getVariant } from './server/variants.js';
import {
  alarmGuards,
  colorHintTouches,
  colorPlayTargets,
  decide,
  handCombos,
  isPlayable,
  knownPlayable,
  knownUseless,
  onesPlayOrder,
  possiblyPlayable,
} from './server/botBrain.js';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const seeds = Number(flag('seeds', '60'));
const playerCounts = flag('players', '2,3,4').split(',').map(Number);
const variantIds = flag('variants', Object.keys(VARIANTS).join(',')).split(',');
const endRule = flag('end', 'lax');

// --- The play queue: obliged plays the giver can identify, in turn order. ---

// Slots `seat` is obliged to play, as the giver can model it — their own
// deduction minus our hand, which we cannot see. Sound, and under-counting.
function obligedSlots(view, seat) {
  const hand = view.players[seat].hand;
  const combos = handCombos(view, seat);
  const out = [];
  hand.forEach((_, i) => { if (knownPlayable(view, combos[i])) out.push(i); });
  for (const t of colorPlayTargets(hand, (s) => possiblyPlayable(view, combos[s]))) {
    if (!out.includes(t)) out.push(t);
  }
  for (const i of onesPlayOrder(view, seat, hand, combos)) if (!out.includes(i)) out.push(i);
  return out;
}

// One round of obliged plays after `me`. One round only: the target lands on the
// receiver's next turn at the earliest, so projecting further would count plays
// that arrive too late. Under-counts, which is the safe direction here.
function playQueue(view, me) {
  const n = view.players.length;
  const queue = [];
  for (let step = 1; step < n; step++) {
    const seat = (me + step) % n;
    for (const slot of obligedSlots(view, seat)) queue.push({ seat, cardIndex: slot });
  }
  return queue;
}

// Apply the queue to a cloned state, bypassing turn order — these are plays
// being projected, not taken. Only successful plays land; a misfire would not
// advance the pile. No draws: the replacements are unknown to everyone and would
// only add noise to the receiver's deduction.
function project(state, queue) {
  const next = structuredClone(state);
  for (const { seat, cardIndex } of [...queue].sort((a, b) => b.cardIndex - a.cardIndex)) {
    const card = next.players[seat].hand[cardIndex];
    if (!card) continue;
    const pile = next.playedPiles[card.color];
    const suit = getVariant(next.variantId).suits.find((s) => s.color === card.color);
    const top = pile.length === 0 ? (suit.direction === 'up' ? 0 : 6) : pile[pile.length - 1].number;
    next.players[seat].hand.splice(cardIndex, 1);
    if (card.number === (suit.direction === 'up' ? top + 1 : top - 1)) pile.push(card);
  }
  return next;
}

// --- Candidate hints. ---

// Under a deferred-play reading the focus slides past only cards the receiver
// can prove DEAD; a merely not-yet-playable card is the point of the hint.
function focusSlot(view, combosAfter, touched) {
  for (let i = touched.length - 1; i >= 0; i--) {
    if (!knownUseless(view, combosAfter[touched[i]])) return touched[i];
  }
  return -1;
}

function legalHints(view, seat) {
  const hand = view.players[seat].hand;
  const out = [];
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color).map(({ i }) => i);
    if (touched.length) out.push({ hintType: 'color', value: color, touched });
  }
  for (const value of [1, 2, 3, 4, 5]) {
    const touched = hand.map((c, i) => (c.number === value ? i : -1)).filter((i) => i >= 0);
    if (touched.length) out.push({ hintType: 'number', value, touched });
  }
  return out;
}

const buckets = new Map(); // playerCount -> counters
function bucket(pc) {
  if (!buckets.has(pc)) {
    buckets.set(pc, {
      games: 0, turns: 0, turnsOnSpare: 0, cards: 0, cardsOnSpare: 0, numberOnly: 0,
    });
  }
  return buckets.get(pc);
}

function measure(state, me, action, reason, c, seen, seenSpare) {
  const view = viewState(state, me);
  if (view.hintTokens <= 0) return;
  // A "spare" turn: no play hint and no save was found, so the turn went on a
  // discard or a stall — the turns a deferred hint could take for free.
  const spare = action.type === 'discard'
    || (action.type === 'hint' && /^stall/.test(reason || ''));

  const queue = playQueue(view, me);
  if (queue.length === 0) return;

  let found = 0;
  for (let step = 1; step < view.players.length; step++) {
    const seat = (me + step) % view.players.length;
    for (const hint of legalHints(view, seat)) {
      const afterHint = structuredClone(state);
      try {
        hintAction(afterHint, me, seat, hint.hintType, hint.value);
      } catch {
        continue; // not legal from here (no tokens, empty touch, …)
      }
      const rv = viewState(afterHint, seat);
      const slot = focusSlot(rv, handCombos(rv, seat), hint.touched);
      if (slot < 0) continue;
      const card = state.players[seat].hand[slot];
      if (isPlayable(view, card.color, card.number)) continue; // an ordinary play hint
      if (card.lastHints?.some((h) => h.hintType === 'color')) continue; // already a target
      const pv = viewState(project(afterHint, queue), seat);
      if (!isPlayable(pv, card.color, card.number)) continue; // not playable even later
      const projectedSlot = pv.players[seat].hand.findIndex((h) => h.id === card.id);
      if (projectedSlot < 0) continue;
      if (!knownPlayable(pv, handCombos(pv, seat)[projectedSlot])) continue; // not provable
      if (hint.hintType !== 'color') {
        c.numberOnly++; // would need a bigger convention change than stage 2
        continue;
      }
      found++;
      // Distinct CARDS, not turns: an opportunity standing for three turns is
      // one card pre-loaded, not three. This is the value question.
      if (!seen.has(card.id)) { seen.add(card.id); c.cards++; }
      if (spare && !seenSpare.has(card.id)) { seenSpare.add(card.id); c.cardsOnSpare++; }
    }
  }
  if (found) {
    c.turns++;
    if (spare) c.turnsOnSpare++;
  }
}

function playOut(variantId, playerCount, seed) {
  const c = bucket(playerCount);
  const seen = new Set();
  const seenSpare = new Set();
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` }));
  const state = createInitialState({ variantId, endRule, players, seed, shareGuarded: true });
  const memories = players.map(() => ({}));
  let guard = 0;
  while (state.status === 'playing' && guard++ < 1000) {
    const idx = state.currentPlayer;
    for (const id of alarmGuards(viewState(state, idx))) {
      annotateAction(state, idx, id, { guarded: true });
    }
    const { action, reason } = decide(viewState(state, idx), undefined, memories[idx]);
    measure(state, idx, action, reason, c, seen, seenSpare);
    switch (action.type) {
      case 'play': playAction(state, idx, action.cardIndex); break;
      case 'discard': discardAction(state, idx, action.cardIndex); break;
      case 'hint': hintAction(state, idx, action.toPlayerIndex, action.hintType, action.value); break;
      default: throw new Error(`bot proposed unknown action ${action.type}`);
    }
  }
  c.games++;
}

const started = Date.now();
for (const variantId of variantIds) {
  for (const playerCount of playerCounts) {
    for (let seed = 1; seed <= seeds; seed++) playOut(variantId, playerCount, seed);
  }
}

console.log(`deferred-play opportunity — ${variantIds.length} variants x ${seeds} seeds, end rule: ${endRule}\n`);
console.log('players'.padEnd(8), 'games'.padStart(6), 'turns'.padStart(8), 'onSpare'.padStart(8), 'cards'.padStart(8), 'onSpare'.padStart(8));
let totGames = 0;
let totCards = 0;
let totSpare = 0;
for (const pc of [...buckets.keys()].sort((a, b) => a - b)) {
  const b = buckets.get(pc);
  const r = (n) => (n / b.games).toFixed(2).padStart(8);
  console.log(String(pc).padEnd(8), String(b.games).padStart(6), r(b.turns), r(b.turnsOnSpare), r(b.cards), r(b.cardsOnSpare));
  totGames += b.games;
  totCards += b.cards;
  totSpare += b.cardsOnSpare;
}
console.log(`
turns   = turns per game offering at least one provable deferred colour hint
cards   = DISTINCT cards per game that could have their hint before their moment
onSpare = …on a turn the bot otherwise spent discarding or stalling

all: ${(totCards / totGames).toFixed(2)} cards/game, ${(totSpare / totGames).toFixed(2)} of them free.
${totGames} games in ${Date.now() - started}ms`);
