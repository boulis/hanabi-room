// Decision logic for the built-in Hanabi bot. Pure: takes the same filtered
// view a human client renders (own cards hidden, constraints visible) and
// returns one action. The bot cannot cheat — hidden information never reaches
// it. Transport lives in bot.mjs.
import { getVariant } from './variants.js';

// Bumped on every change to the decision logic; bot-performance.md records
// what each version does and the benchmark numbers it achieves.
export const BOT_VERSION = '1.5';

// The convention set the bot plays by. Kept as data so alternative convention
// sets can be added without touching the decision code's shape.
export const STANDARD_CONVENTIONS = {
  id: 'standard',
  // A colour hint marks the newest touched card for play. Every colour hint
  // still marked on the hand stays a pending play target (oldest first) until
  // the server consumes its markers — unless the hint fully identified
  // another touched card, in which case it was a reveal, not a play order.
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

// Copies of each identity in the variant's full deck.
function deckCounts(view) {
  const totals = new Map();
  for (const suit of getVariant(view.variantId).suits) {
    for (const n of suit.distribution) {
      const k = `${suit.color}_${n}`;
      totals.set(k, (totals.get(k) || 0) + 1);
    }
  }
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
// card was playable first). Exception: a hint whose touched set contains a
// fully identified card other than the newest was a *reveal* — it exists to
// pin that card's identity (played via known-playable when it can be), so its
// newest touched card carries no play promise.
export function colorPlayTargets(hand, combosBySlot) {
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
    const touched = byHint.get(hintIndex);
    const newest = Math.max(...touched);
    if (touched.some((slot) => slot !== newest && combosBySlot[slot].length === 1)) continue;
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

// A visible card worth saving: still needed, and every other copy has been
// discarded (played copies would make it useless, handled above).
function isCritical(view, card) {
  if (isUseless(view, card.color, card.number)) return false;
  const variant = getVariant(view.variantId);
  const suit = variant.suits.find((s) => s.color === card.color);
  const total = suit.distribution.filter((n) => n === card.number).length;
  const discarded = view.discard.filter(
    (c) => c.color === card.color && c.number === card.number,
  ).length;
  return total - discarded === 1;
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
  return colorPlayTargets(hand, combos).some((t) => possiblyPlayable(view, combos[t]));
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
  const pending = colorPlayTargets(hand, before);
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length === 0) continue;
    const after = combosFor(view, afterColorHint(view, hand, color), [seat, view.viewerIndex]);
    let playIdxs = touched.filter(({ i }) => knownPlayable(view, after[i])).map(({ i }) => i);
    if (playIdxs.length === 0) {
      const newest = touched[touched.length - 1];
      if (!isPlayable(view, newest.card.color, newest.card.number)) continue;
      if (touched.some(({ i }) => i !== newest.i && after[i].length === 1)) continue;
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
    for (const t of colorPlayTargets(myHand, myCombos)) {
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
