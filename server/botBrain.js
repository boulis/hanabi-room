// Decision logic for the built-in Hanabi bot. Pure: takes the same filtered
// view a human client renders (own cards hidden, constraints visible) and
// returns one action. The bot cannot cheat — hidden information never reaches
// it: the endgame search below simulates with the public rules over worlds
// hypothesised from the view, never from actual hidden state. Transport lives
// in bot.mjs.
import { getVariant } from './variants.js';
import { discardAction, hintAction, playAction } from './rules.js';
import { viewState } from './view.js';

// Bumped on every change to the decision logic; bot-performance.md records
// what each version does and the benchmark numbers it achieves.
export const BOT_VERSION = '1.7';

// The convention set the bot plays by. Kept as data so alternative convention
// sets can be added without touching the decision code's shape.
export const STANDARD_CONVENTIONS = {
  id: 'standard',
  // A colour hint marks the newest touched card for play. Every colour hint
  // still marked on the hand stays a pending play target (oldest first)
  // until the server consumes its markers. If the hint fully pins another
  // touched card AND that card is playable, the pinned card is played first
  // (the play consumes the hint's markers, so the newest touched card stops
  // being a target); a pinned-but-unplayable card changes nothing — the
  // newest touched card is still expected to be played.
  colorHintPlaysNewest: true,
  // A number hint means "keep these" unless a card is provably playable.
  numberHintSaves: true,
  // Exception to the above: a "1" hint asks for every touched card to be
  // played (oldest first), as long as the card can still be a playable 1.
  playAllOnes: true,
  // The chop (default discard) is the oldest untouched card.
  discardOldestUntouched: true,
};

export const CONVENTION_SETS = { standard: STANDARD_CONVENTIONS };

// --- Pile arithmetic (all from the view's playedPiles {top, count, cap}). ---

function suitOf(view, color) {
  return view.suits.find((s) => s.color === color);
}

// The number this pile needs next, or null if it can't grow.
function neededNumber(view, color) {
  const pile = view.playedPiles[color];
  const suit = suitOf(view, color);
  if (pile.count >= pile.cap) return null;
  return suit.direction === 'up' ? pile.top + 1 : pile.top - 1;
}

function isPlayable(view, color, number) {
  return neededNumber(view, color) === number;
}

// True when this identity can never be played again (already played, or the
// pile can't reach it because every copy of an intermediate card is gone —
// the view's pile cap already accounts for discarded criticals).
function isUseless(view, color, number) {
  const pile = view.playedPiles[color];
  const suit = suitOf(view, color);
  if (suit.direction === 'up') {
    if (pile.count > 0 && number <= pile.top) return true; // already played
    return number > pile.cap;                              // unreachable
  }
  if (pile.count > 0 && number >= pile.top) return true;   // already played (5→1)
  return number < 6 - pile.cap;                            // unreachable
}

// --- Identity deduction. ---
// A card's candidate identities start from its hint constraints
// (possibleColors × possibleNumbers) and are narrowed by copy-counting: an
// identity whose every copy is already visible to the deducing player —
// played, discarded, or sitting in a hand they can see — can't be this card.

// Copies of each identity in the variant's full deck (memoized — the search
// rollouts call this on every simulated turn).
const deckCountsCache = new Map();
function deckCounts(view) {
  let totals = deckCountsCache.get(view.variantId);
  if (totals) return totals;
  totals = new Map();
  for (const suit of getVariant(view.variantId).suits) {
    for (const n of suit.distribution) {
      const k = `${suit.color}_${n}`;
      totals.set(k, (totals.get(k) || 0) + 1);
    }
  }
  deckCountsCache.set(view.variantId, totals);
  return totals;
}

// Copies visible in the piles, the discard, and every hand not in hiddenSeats.
function visibleCounts(view, hiddenSeats) {
  const counts = new Map();
  const add = (color, number) => {
    const k = `${color}_${number}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (const [color, pile] of Object.entries(view.playedPiles)) {
    const dir = suitOf(view, color).direction;
    for (let i = 0; i < pile.count; i++) add(color, dir === 'up' ? i + 1 : 5 - i);
  }
  for (const c of view.discard) add(c.color, c.number);
  view.players.forEach((p, seat) => {
    if (hiddenSeats.includes(seat)) return;
    for (const c of p.hand) if (c.color !== undefined) add(c.color, c.number);
  });
  return counts;
}

function deduceCombos(card, visible, totals) {
  const out = [];
  for (const c of card.possibleColors) {
    for (const n of card.possibleNumbers) {
      const k = `${c}_${n}`;
      if ((visible.get(k) || 0) < (totals.get(k) || 0)) out.push([c, n]);
    }
  }
  return out;
}

function combosFor(view, hand, hiddenSeats) {
  const totals = deckCounts(view);
  const visible = visibleCounts(view, hiddenSeats);
  let combos = hand.map((card) => deduceCombos(card, visible, totals));
  // Cross-card elimination: a card pinned to a single identity claims one
  // copy of it. When the claimed copies plus the visible ones account for
  // every copy, that identity is ruled out for the rest of the hand. Each
  // pass can pin new cards, so iterate to a fixpoint (at most one new pin
  // per pass bounds the loop by the hand size).
  for (let pass = 0; pass < hand.length; pass++) {
    const pinned = new Map();
    for (const cs of combos) {
      if (cs.length !== 1) continue;
      const k = `${cs[0][0]}_${cs[0][1]}`;
      pinned.set(k, (pinned.get(k) || 0) + 1);
    }
    let changed = false;
    combos = combos.map((cs) => {
      if (cs.length <= 1) return cs;
      const kept = cs.filter(([c, n]) => {
        const k = `${c}_${n}`;
        return (visible.get(k) || 0) + (pinned.get(k) || 0) < (totals.get(k) || 0);
      });
      // Never empty a card's candidates — inconsistency would mean a server
      // bug; keeping the wider set just makes the bot less certain.
      if (kept.length === 0 || kept.length === cs.length) return cs;
      changed = true;
      return kept;
    });
    if (!changed) break;
  }
  return combos;
}

// Candidate identities for every card in `seat`'s hand, as that player can
// deduce them. Deducing for a teammate under-approximates: the viewer can't
// see their own hand, so its cards can't be counted even though the teammate
// sees them — anything proved this way is still sound.
export function handCombos(view, seat) {
  const hidden = seat === view.viewerIndex ? [seat] : [seat, view.viewerIndex];
  return combosFor(view, view.players[seat].hand, hidden);
}

export function knownPlayable(view, combos) {
  return combos.length > 0 && combos.every(([c, n]) => isPlayable(view, c, n));
}

export function knownUseless(view, combos) {
  return combos.length > 0 && combos.every(([c, n]) => isUseless(view, c, n));
}

function possiblyPlayable(view, combos) {
  return combos.some(([c, n]) => isPlayable(view, c, n));
}

// --- Convention bookkeeping. ---

// Oldest (leftmost) card never touched by any hint.
export function chopIndex(hand) {
  for (let i = 0; i < hand.length; i++) {
    if (!hand[i].colorClued && !hand[i].numberClued) return i;
  }
  return -1;
}

// Every colour hint still marked on the hand contributes one pending play
// target: the newest card it touched. The server consumes a hint's markers
// when any card of that hint leaves the hand, so a marked hint is one that
// hasn't been acted on yet — all of them stay live, oldest hint first (its
// card was playable first). A hint that fully pins another touched card
// needs no special case here: a pinned *playable* card is played first via
// known-playable (which consumes the hint's markers and retires the target),
// and a pinned unplayable card doesn't change what the hint asks — the
// newest touched card is still the one to play. (An earlier version
// cancelled the target whenever any touched card was pinned; in rainbow
// variants that made every colour hint cancel itself, because colour hints
// unavoidably touch the known rainbow cards in hand.)
export function colorPlayTargets(hand) {
  const byHint = new Map();
  hand.forEach((card, slot) => {
    for (const h of card.lastHints) {
      if (h.hintType !== 'color') continue;
      if (!byHint.has(h.hintIndex)) byHint.set(h.hintIndex, []);
      byHint.get(h.hintIndex).push(slot);
    }
  });
  const targets = [];
  for (const hintIndex of [...byHint.keys()].sort((a, b) => a - b)) {
    const newest = Math.max(...byHint.get(hintIndex));
    if (!targets.includes(newest)) targets.push(newest);
  }
  return targets;
}

// Cards obligated by the play-all-1s convention: touched by a "1" hint at
// some point (numberClued with possibleNumbers narrowed to exactly [1]).
// Constraint-based rather than marker-based on purpose — playing the first 1
// consumes the hint's markers on the others, but the obligation persists.
function onesObligations(hand) {
  const out = [];
  hand.forEach((card, i) => {
    if (card.numberClued && card.possibleNumbers.length === 1 && card.possibleNumbers[0] === 1) {
      out.push(i);
    }
  });
  return out;
}

// An identity that must not be lost: still needed, and every other copy has
// been discarded (played copies would make it useless, handled above).
function identityCritical(view, color, number) {
  if (isUseless(view, color, number)) return false;
  const suit = getVariant(view.variantId).suits.find((s) => s.color === color);
  const total = suit.distribution.filter((n) => n === number).length;
  const discarded = view.discard.filter((c) => c.color === color && c.number === number).length;
  return total - discarded === 1;
}

function isCritical(view, card) {
  return identityCritical(view, card.color, card.number);
}

// Every candidate identity of this card is critical — discarding it is a
// guaranteed loss whatever it turns out to be.
function provablyCritical(view, combos) {
  return combos.length > 0 && combos.every(([c, n]) => identityCritical(view, c, n));
}

// --- Hint simulation against a teammate's visible hand. ---

// The suit colours a colour hint touches (rainbow-style suits match any).
function touchedColorSet(view, hintColor) {
  return new Set(
    view.suits
      .filter((s) => s.hintMatches === 'all' || (s.hintMatches === 'self' && s.color === hintColor))
      .map((s) => s.color),
  );
}

function colorHintTouches(view, hand, hintColor) {
  const tset = touchedColorSet(view, hintColor);
  return hand.map((card, i) => ({ card, i })).filter(({ card }) => tset.has(card.color));
}

// The receiver's constraints after a colour hint (mirrors hintAction): touched
// cards intersect their possible colours with the touched set, untouched
// cards subtract it.
function afterColorHint(view, hand, hintColor) {
  const tset = touchedColorSet(view, hintColor);
  return hand.map((card) => ({
    ...card,
    possibleColors: card.possibleColors.filter((c) => (tset.has(card.color) ? tset.has(c) : !tset.has(c))),
  }));
}

// The receiver's constraints after a number hint.
function afterNumberHint(hand, value) {
  return hand.map((card) => ({
    ...card,
    possibleNumbers: card.number === value ? [value] : card.possibleNumbers.filter((n) => n !== value),
  }));
}

// Would this player, following the conventions, already play something on
// their own? (Known-playable card, a live colour-hint target, or a 1s
// obligation that can still be playable.)
function hasPendingPlay(view, seat, conventions = STANDARD_CONVENTIONS) {
  const hand = view.players[seat].hand;
  const combos = handCombos(view, seat);
  if (combos.some((cs) => knownPlayable(view, cs))) return true;
  if (conventions.playAllOnes) {
    const ones = onesObligations(hand);
    if (!ones.some((i) => combos[i].length === 1)
      && ones.some((i) => possiblyPlayable(view, combos[i]))) return true;
  }
  return colorPlayTargets(hand).some((t) => possiblyPlayable(view, combos[t]));
}

// Score a valid play hint so competing options can be compared. Immediate
// correct plays dominate; then touching cards that are still needed (they'll
// be kept and eventually played), then raw information (candidate identities
// eliminated across the hand); touching a useless card costs — it gets a
// keep-clue it doesn't deserve and clogs the hand.
function scoreHint(view, seat, hand, touched, before, after, playIdxs, hint) {
  const plays = playIdxs.length;
  let info = 0;
  for (let i = 0; i < hand.length; i++) info += before[i].length - after[i].length;
  // Identities already clued somewhere visible: touching another copy of one
  // wastes the touch and risks two players "keeping" the same card.
  const cluedElsewhere = new Set();
  view.players.forEach((p, other) => {
    if (other === view.viewerIndex) return;
    p.hand.forEach((c, i) => {
      if ((c.colorClued || c.numberClued) && !(other === seat && touched.some((t) => t.i === i))) {
        cluedElsewhere.add(`${c.color}_${c.number}`);
      }
    });
  });
  // How soon a touched card can matter: playable now > next in line for its
  // pile > distant future. Newly cluing a distant card is a liability — it
  // sits in the hand soaking up "keep" status and muddying later hints.
  const soon = (card) => {
    const need = neededNumber(view, card.color);
    if (need === null) return 0;
    const dist = suitOf(view, card.color).direction === 'up' ? card.number - need : need - card.number;
    return dist === 0 ? 2 : dist === 1 ? 1 : 0;
  };
  let value = 0;
  let bad = 0;
  const seen = new Set();
  for (const { card } of touched) {
    const k = `${card.color}_${card.number}`;
    if (isUseless(view, card.color, card.number) || cluedElsewhere.has(k) || seen.has(k)) bad++;
    else if (soon(card) > 0) value += soon(card) * 25;
    else if (!card.colorClued && !card.numberClued) value -= 30; // distant card newly clued
    seen.add(k);
  }
  // Colour hints get a small edge: beyond the immediate play they leave a
  // pending-target obligation and colour identity that keeps paying off.
  const colorBonus = hint.hintType === 'color' ? 50 : 0;
  return { hint, playIdxs, score: plays * 1000 + value + info + colorBonus - bad * 200 };
}

// Every hint to `seat` that the receiver, reading it by the conventions,
// would correctly act on — each scored. Colour hints work as play hints when
// they prove some touched card playable outright (a reveal), or when the
// newest touched card is playable right now and the hint doesn't read as a
// reveal (which would cancel the newest-touched promise). Number hints work
// when they make a touched card provably playable — or, for a "1" hint under
// play-all-1s, when every 1 the receiver would go on to play really is
// playable, all different colours, and not already obligated elsewhere.
function playHintCandidates(view, seat, conventions) {
  const out = [];
  const hand = view.players[seat].hand;
  const before = handCombos(view, seat);
  const pending = colorPlayTargets(hand);
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length === 0) continue;
    const after = combosFor(view, afterColorHint(view, hand, color), [seat, view.viewerIndex]);
    let playIdxs = touched.filter(({ i }) => knownPlayable(view, after[i])).map(({ i }) => i);
    if (playIdxs.length === 0) {
      const newest = touched[touched.length - 1];
      if (!isPlayable(view, newest.card.color, newest.card.number)) continue;
      if (pending.includes(newest.i)) continue; // already their live target
      playIdxs = [newest.i];
    }
    out.push(scoreHint(view, seat, hand, touched, before, after, playIdxs, { hintType: 'color', value: color }));
  }
  for (const n of [...new Set(hand.map((c) => c.number))]) {
    const after = combosFor(view, afterNumberHint(hand, n), [seat, view.viewerIndex]);
    const touched = hand.map((c, i) => ({ card: c, i })).filter(({ card }) => card.number === n);
    if (n === 1 && conventions.playAllOnes) {
      const wouldPlay = touched.filter(({ i }) => possiblyPlayable(view, after[i]));
      // 1s already obligated in other visible hands — a second obligation on
      // the same colour's 1 guarantees that one of the two plays misfires.
      const obligatedElsewhere = new Set();
      view.players.forEach((p, other) => {
        if (other === seat || other === view.viewerIndex) return;
        for (const i of onesObligations(p.hand)) obligatedElsewhere.add(p.hand[i].color);
      });
      const colors = new Set(wouldPlay.map(({ card }) => card.color));
      const newlyObligated = touched.some(({ card }) => !(card.numberClued && card.possibleNumbers.length === 1));
      if (
        wouldPlay.length > 0
        && newlyObligated
        && colors.size === wouldPlay.length
        && wouldPlay.every(({ card }) => isPlayable(view, card.color, card.number))
        && wouldPlay.every(({ card }) => !obligatedElsewhere.has(card.color))
        && !touched.some(({ i }) => after[i].length === 1) // would read as a reveal
      ) {
        out.push(scoreHint(view, seat, hand, touched, before, after, wouldPlay.map(({ i }) => i), { hintType: 'number', value: 1 }));
      }
      continue; // an unsafe "1" hint would trigger the convention anyway
    }
    const playIdxs = touched.filter(({ i }) => knownPlayable(view, after[i])).map(({ i }) => i);
    if (playIdxs.length > 0) {
      out.push(scoreHint(view, seat, hand, touched, before, after, playIdxs, { hintType: 'number', value: n }));
    }
  }
  return out;
}

// The best valid play hint for `seat`, or null. Colour hints outrank number
// hints as a class (they leave a lasting pending-target obligation); the
// score picks the best option *within* the class. Ties keep the first
// candidate in enumeration order, so the choice is deterministic.
function findPlayHint(view, seat, conventions) {
  let bestColor = null;
  let bestNumber = null;
  for (const cand of playHintCandidates(view, seat, conventions)) {
    if (cand.hint.hintType === 'color') {
      if (!bestColor || cand.score > bestColor.score) bestColor = cand;
    } else if (!bestNumber || cand.score > bestNumber.score) {
      bestNumber = cand;
    }
  }
  const best = bestColor || bestNumber;
  return best && best.hint;
}

// A chop card we shouldn't let go: critical (last remaining copy), or a
// still-needed 2 whose twin isn't anywhere we can see — losing an early 2
// caps its pile for a long time, so it gets the benefit of the doubt.
function saveWorthy(view, card) {
  if (isCritical(view, card)) return true;
  // A 2 isn't a guaranteed loss, so only spend a token on it when tokens
  // aren't scarce.
  if (view.hintTokens < 2) return false;
  if (card.number !== 2 || isUseless(view, card.color, card.number)) return false;
  const visible = visibleCounts(view, [view.viewerIndex]);
  return (visible.get(`${card.color}_2`) || 0) - 1 === 0; // only this copy in sight
}

// The best way to protect `chop` in `seat`'s hand. A play hint that gets the
// card played beats parking it: the card scores AND leaves the hand. Next
// best, a colour hint that pins it as provably unplayable (informative, and
// safe: the receiver's target check skips unplayable targets). Fallback is
// the plain number keep-hint — except a "1" save that play-all-1s would
// misread as a play order; then no safe save exists.
function findSaveHint(view, seat, chop, conventions) {
  const hand = view.players[seat].hand;
  const card = hand[chop];
  if (isPlayable(view, card.color, card.number)) {
    let best = null;
    for (const cand of playHintCandidates(view, seat, conventions)) {
      if (!cand.playIdxs.includes(chop)) continue;
      if (!best || cand.score > best.score) best = cand;
    }
    if (best) return { hint: best.hint, how: 'play' };
  }
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length === 0 || touched[touched.length - 1].i !== chop) continue;
    const after = combosFor(view, afterColorHint(view, hand, color), [seat, view.viewerIndex]);
    if (!possiblyPlayable(view, after[chop])) {
      return { hint: { hintType: 'color', value: color }, how: 'pin' };
    }
  }
  if (card.number === 1 && conventions.playAllOnes && !isPlayable(view, card.color, card.number)) {
    const after = combosFor(view, afterNumberHint(hand, 1), [seat, view.viewerIndex]);
    if (possiblyPlayable(view, after[chop])) return null; // would trigger a misplay
  }
  return { hint: { hintType: 'number', value: card.number }, how: 'keep' };
}

// Any legal hint that changes as little as possible: prefer re-hinting a
// number the player already has clued (pure "keep" reinforcement).
function findStallHint(view, hand) {
  const clued = hand.filter((c) => c.numberClued);
  const pick = (cards) => (cards.length ? { hintType: 'number', value: cards[cards.length - 1].number } : null);
  return pick(clued) || pick(hand);
}

// --- The decision. ---
// view: an in-room playing view where view.currentPlayer === view.viewerIndex.
// Returns { action, reason }.
export function decide(view, conventions = STANDARD_CONVENTIONS) {
  // With the deck empty the endgame is exactly computable (see below); use
  // the search over the last few cards, where the uncertainty is small
  // enough to enumerate and the rollouts are short enough to afford.
  const cardsLeft = view.players.reduce((sum, p) => sum + p.hand.length, 0);
  if (view.deckSize === 0 && cardsLeft <= 6 && view.players[view.viewerIndex].hand.length > 0) {
    const searched = endgameSearch(view, conventions);
    if (searched) return searched;
  }
  return decideCore(view, conventions);
}

// The convention-following policy: used directly during the main game, and as
// the rollout policy (for ourselves and for teammates) inside the search.
function decideCore(view, conventions = STANDARD_CONVENTIONS) {
  const me = view.viewerIndex;
  const myHand = view.players[me].hand;
  const myCombos = handCombos(view, me);
  const nextIndex = (me + 1) % view.players.length;
  const lastFuse = view.fuseTokens === 1;

  // The danger we can see coming: a player who, with nothing to play, will
  // discard a chop we can't afford to lose. The next player is ours to save;
  // players further along only when everyone between us and them has a
  // pending play (they'll spend their turn playing, not saving). The first
  // player free to act can handle anyone beyond them, so the scan stops.
  let urgentSave = null;
  if (view.hintTokens > 0 && conventions.numberHintSaves) {
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      if (hasPendingPlay(view, idx, conventions)) continue;
      const hand = view.players[idx].hand;
      const chop = chopIndex(hand);
      if (chop >= 0 && saveWorthy(view, hand[chop])) {
        const save = findSaveHint(view, idx, chop, conventions);
        if (save) {
          urgentSave = {
            action: { type: 'hint', toPlayerIndex: idx, ...save.hint },
            reason: `save ${hand[chop].color} ${hand[chop].number} on chop (${save.how})`,
          };
        }
      }
      break;
    }
  }

  // 0. The save outranks even our own play: the play keeps for next turn,
  //    the endangered card doesn't. Exception: in the final round a deferred
  //    play may never happen, so plays come first there.
  if (urgentSave && view.finalTurn === null) return urgentSave;

  // 1. Play a card we can prove is playable (hint constraints narrowed by
  //    copy-counting over everything we can see).
  for (let i = 0; i < myHand.length; i++) {
    if (knownPlayable(view, myCombos[i])) {
      return { action: { type: 'play', cardIndex: i }, reason: 'known playable' };
    }
  }

  // 2. Play a pending colour-hint target, oldest hint first — skipping any
  //    target deduction says can't be playable.
  if (conventions.colorHintPlaysNewest) {
    for (const t of colorPlayTargets(myHand)) {
      const safeEnough = lastFuse ? knownPlayable(view, myCombos[t]) : possiblyPlayable(view, myCombos[t]);
      if (safeEnough) {
        return { action: { type: 'play', cardIndex: t }, reason: 'colour hint marks touched card' };
      }
    }
  }

  // 2b. Play-all-1s: every card touched by a "1" hint is to be played,
  //     oldest first, while it can still be a playable 1. Reveal exception,
  //     as with colour hints: once any obligated 1 is pinned to a single
  //     identity, the 1s read as information (e.g. "that's the dead
  //     duplicate"), not as a play order.
  if (conventions.playAllOnes) {
    const ones = onesObligations(myHand);
    if (!ones.some((i) => myCombos[i].length === 1)) {
      for (const i of ones) {
        const safeEnough = lastFuse ? knownPlayable(view, myCombos[i]) : possiblyPlayable(view, myCombos[i]);
        if (safeEnough) {
          return { action: { type: 'play', cardIndex: i }, reason: 'play all 1s' };
        }
      }
    }
  }

  // 3. Final-round case: nothing of our own to play after all, so the save
  //    (deferred at step 0) is back on the table.
  if (urgentSave) return urgentSave;

  if (view.hintTokens > 0) {
    // 4. Give a play hint (closest player first; colour hints preferred).
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      if (hasPendingPlay(view, idx, conventions)) continue; // they already have a play
      const hint = findPlayHint(view, idx, conventions);
      if (hint) {
        return {
          action: { type: 'hint', toPlayerIndex: idx, ...hint },
          reason: `play hint for ${view.players[idx].name}`,
        };
      }
    }
  }

  // 5. Discard: a provably useless card beats the chop; the chop beats
  //    guessing; guessing takes the oldest card.
  if (view.hintTokens < 8) {
    for (let i = 0; i < myHand.length; i++) {
      if (knownUseless(view, myCombos[i])) {
        return { action: { type: 'discard', cardIndex: i }, reason: 'provably useless' };
      }
    }
    if (conventions.discardOldestUntouched) {
      const chop = chopIndex(myHand);
      if (chop >= 0) {
        return { action: { type: 'discard', cardIndex: chop }, reason: 'chop (oldest untouched)' };
      }
    }
    // Forced: every card is clued. Discard the oldest card that isn't
    // provably critical — never throw away a known last copy (e.g. a fully
    // identified rainbow 5) while a safer option exists.
    for (let i = 0; i < myHand.length; i++) {
      if (!provablyCritical(view, myCombos[i])) {
        return { action: { type: 'discard', cardIndex: i }, reason: 'forced: least dangerous' };
      }
    }
    return { action: { type: 'discard', cardIndex: 0 }, reason: 'forced: oldest card' };
  }

  // 6. Tokens are full — discarding is illegal, so stall with a harmless hint.
  for (let step = 1; step < view.players.length; step++) {
    const idx = (me + step) % view.players.length;
    const stall = findStallHint(view, view.players[idx].hand);
    if (stall) {
      return {
        action: { type: 'hint', toPlayerIndex: idx, ...stall },
        reason: 'stall (tokens full)',
      };
    }
  }

  // 7. Tokens full AND nobody left to hint (lax endgame with empty hands):
  //    playing is the only legal move. Take the best odds available —
  //    a possibly-playable card, else the newest (least likely saved).
  for (let i = myHand.length - 1; i >= 0; i--) {
    if (possiblyPlayable(view, myCombos[i])) {
      return { action: { type: 'play', cardIndex: i }, reason: 'forced play (best odds)' };
    }
  }
  return { action: { type: 'play', cardIndex: myHand.length - 1 }, reason: 'forced play' };
}

// --- Endgame search. ---
// Once the deck is empty the game is fully determined up to the identity of
// our own hand: everyone else's cards are visible, and the unseen multiset
// (the full deck minus piles, discard, and visible hands) is exactly our
// hand. When the consistent assignments ("worlds") are few enough, simulate
// every legal action to the end of the game — teammates modelled as this
// same bot — and take the action with the best average final score.

const SEARCH_MAX_WORLDS = 16;
const SEARCH_MAX_SIMS = 160;

// All assignments of the unseen multiset to our hand slots that respect each
// slot's deduced candidates; null when there are too many to search.
function enumerateWorlds(view, myCombos) {
  const me = view.viewerIndex;
  const totals = deckCounts(view);
  const visible = visibleCounts(view, [me]);
  const remaining = new Map();
  for (const [k, total] of totals) {
    if (total - (visible.get(k) || 0) > 0) remaining.set(k, total - (visible.get(k) || 0));
  }
  const slots = view.players[me].hand.length;
  const worlds = [];
  const acc = [];
  const dfs = (slot) => {
    if (worlds.length > SEARCH_MAX_WORLDS) return;
    if (slot === slots) {
      worlds.push(acc.slice());
      return;
    }
    for (const [color, number] of myCombos[slot]) {
      const k = `${color}_${number}`;
      const left = remaining.get(k) || 0;
      if (left === 0) continue;
      remaining.set(k, left - 1);
      acc.push([color, number]);
      dfs(slot + 1);
      acc.pop();
      remaining.set(k, left + 1);
    }
  };
  dfs(0);
  return worlds.length > SEARCH_MAX_WORLDS ? null : worlds;
}

// A full rules-engine state built from the view plus one hypothesis for our
// own hand. Everything in it is either public or hypothesised — the actual
// hidden state is never consulted.
function reconstructState(view, world) {
  const me = view.viewerIndex;
  let nextHintIndex = 0;
  for (const p of view.players) {
    for (const c of p.hand) {
      for (const h of c.lastHints) nextHintIndex = Math.max(nextHintIndex, h.hintIndex + 1);
    }
  }
  let nextId = 100000;
  return {
    status: 'playing',
    variantId: view.variantId,
    endRule: view.endRule,
    shareGuarded: false,
    allowEmptyHints: view.allowEmptyHints,
    seed: 0,
    players: view.players.map((p, seat) => ({
      id: `sim${seat}`,
      name: p.name,
      hand: p.hand.map((c, i) => ({
        id: c.id ?? nextId++,
        color: seat === me ? world[i][0] : c.color,
        number: seat === me ? world[i][1] : c.number,
        possibleColors: c.possibleColors.slice(),
        possibleNumbers: c.possibleNumbers.slice(),
        colorClued: c.colorClued,
        numberClued: c.numberClued,
        lastHints: c.lastHints.map((h) => ({ ...h })),
        annotations: { note: '', guarded: false },
      })),
    })),
    deck: [],
    discard: view.discard.map((c) => ({ ...c })),
    playedPiles: Object.fromEntries(view.suits.map((s) => {
      const pile = view.playedPiles[s.color];
      const cards = [];
      for (let i = 0; i < pile.count; i++) {
        cards.push({ id: nextId++, color: s.color, number: s.direction === 'up' ? i + 1 : 5 - i });
      }
      return [s.color, cards];
    })),
    hintTokens: view.hintTokens,
    fuseTokens: view.fuseTokens,
    currentPlayer: view.currentPlayer,
    turn: view.turn,
    finalTurn: view.finalTurn,
    log: [],
    endReason: null,
    nextHintIndex,
    nextLogSeq: 0,
    startedAt: 0,
    endedAt: null,
    initialDeckCards: [],
  };
}

// Every action we could legally take right now, most promising classes
// first (plays, then discards, then hints) so budget truncation keeps the
// essential options.
function candidateActions(view) {
  const me = view.viewerIndex;
  const out = [];
  for (let i = 0; i < view.players[me].hand.length; i++) out.push({ type: 'play', cardIndex: i });
  if (view.hintTokens < 8) {
    for (let i = 0; i < view.players[me].hand.length; i++) out.push({ type: 'discard', cardIndex: i });
  }
  if (view.hintTokens > 0) {
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      const hand = view.players[idx].hand;
      for (const color of view.hintableColors) {
        if (colorHintTouches(view, hand, color).length > 0) {
          out.push({ type: 'hint', toPlayerIndex: idx, hintType: 'color', value: color });
        }
      }
      for (const n of [...new Set(hand.map((c) => c.number))]) {
        out.push({ type: 'hint', toPlayerIndex: idx, hintType: 'number', value: n });
      }
    }
  }
  return out;
}

function applySim(state, idx, action) {
  if (action.type === 'play') playAction(state, idx, action.cardIndex);
  else if (action.type === 'discard') discardAction(state, idx, action.cardIndex);
  else hintAction(state, idx, action.toPlayerIndex, action.hintType, action.value);
}

// Play a reconstructed state out to its end with the convention policy.
// The evaluation is the final score minus a point per fuse burned along the
// way: a lost fuse is "free" in raw score until the third one, so without
// the penalty the search treats fuses as gambling chips — and three turns of
// "free" gambles compound into fuse-outs the per-turn model never sees.
function rolloutValue(state, conventions) {
  const fusesBefore = state.fuseTokens;
  let guard = 0;
  while (state.status === 'playing' && guard++ < 60) {
    const idx = state.currentPlayer;
    applySim(state, idx, decideCore(viewState(state, idx), conventions).action);
  }
  const score = Object.values(state.playedPiles).reduce((sum, pile) => sum + pile.length, 0);
  return score - (fusesBefore - state.fuseTokens);
}

// Maximin over worlds: a candidate is judged by its worst-case final score,
// with the average as tie-break. Average-maximizing turned out to gamble
// itself into fuse-outs — the model assumes future turns follow the safe
// convention policy, but a real future turn would gamble again, compounding
// risk the simulation never sees. Worst-case-first only accepts risks that
// cost nothing in any consistent world.
function endgameSearch(view, conventions) {
  const worlds = enumerateWorlds(view, handCombos(view, view.viewerIndex));
  if (!worlds || worlds.length === 0) return null;
  const budget = Math.max(1, Math.floor(SEARCH_MAX_SIMS / worlds.length));
  const candidates = candidateActions(view).slice(0, budget);
  let best = null;
  for (const action of candidates) {
    let total = 0;
    let worst = Infinity;
    let ok = true;
    for (const world of worlds) {
      const state = reconstructState(view, world);
      try {
        applySim(state, view.viewerIndex, action);
        const value = rolloutValue(state, conventions);
        total += value;
        worst = Math.min(worst, value);
      } catch {
        ok = false; // illegal in some world — not worth reasoning around
        break;
      }
    }
    if (!ok) continue;
    const avg = total / worlds.length;
    if (!best || worst > best.worst || (worst === best.worst && avg > best.avg)) {
      best = { action, worst, avg };
    }
  }
  if (!best) return null;
  return {
    action: best.action,
    reason: `endgame search (${worlds.length} worlds, worst ${best.worst}, avg ${best.avg.toFixed(1)})`,
  };
}
