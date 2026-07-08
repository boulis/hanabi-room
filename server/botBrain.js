// Decision logic for the built-in Hanabi bot. Pure: takes the same filtered
// view a human client renders (own cards hidden, constraints visible) and
// returns one action. The bot cannot cheat — hidden information never reaches
// it. Transport lives in bot.mjs.
import { getVariant } from './variants.js';

// The convention set the bot plays by. Kept as data so alternative convention
// sets can be added without touching the decision code's shape.
export const STANDARD_CONVENTIONS = {
  id: 'standard',
  // A colour hint marks the newest touched card for play.
  colorHintPlaysNewest: true,
  // A number hint means "keep these" unless a card is provably playable.
  numberHintSaves: true,
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

// --- Own-hand deduction (constraints only; identity fields are absent). ---

function combos(card) {
  const out = [];
  for (const c of card.possibleColors) {
    for (const n of card.possibleNumbers) out.push([c, n]);
  }
  return out;
}

export function knownPlayable(view, card) {
  const cs = combos(card);
  return cs.length > 0 && cs.every(([c, n]) => isPlayable(view, c, n));
}

export function knownUseless(view, card) {
  const cs = combos(card);
  return cs.length > 0 && cs.every(([c, n]) => isUseless(view, c, n));
}

function possiblyPlayable(view, card) {
  return combos(card).some(([c, n]) => isPlayable(view, c, n));
}

// --- Convention bookkeeping. ---

// Oldest (leftmost) card never touched by any hint.
export function chopIndex(hand) {
  for (let i = 0; i < hand.length; i++) {
    if (!hand[i].colorClued && !hand[i].numberClued) return i;
  }
  return -1;
}

// "Colour hint plays the newest touched card": find the most recent colour
// hint still marked on this hand (markers are consumed when any card of that
// hint leaves the hand) and return the newest card it touched.
export function colorPlayTargetIndex(hand) {
  let best = -1;
  for (const card of hand) {
    for (const h of card.lastHints) {
      if (h.hintType === 'color' && h.hintIndex > best) best = h.hintIndex;
    }
  }
  if (best < 0) return -1;
  for (let i = hand.length - 1; i >= 0; i--) {
    if (hand[i].lastHints.some((h) => h.hintIndex === best)) return i;
  }
  return -1;
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

function colorHintTouches(view, hand, hintColor) {
  return hand
    .map((card, i) => ({ card, i }))
    .filter(({ card }) => {
      const suit = suitOf(view, card.color);
      return suit.hintMatches === 'all' || (suit.hintMatches === 'self' && card.color === hintColor);
    });
}

// Would this player, following the conventions, already play something on
// their own? (Known-playable card or a pending colour-hint target.)
function hasPendingPlay(view, hand) {
  if (hand.some((c) => knownPlayable(view, c))) return true;
  const t = colorPlayTargetIndex(hand);
  return t >= 0 && possiblyPlayable(view, hand[t]);
}

// A colour hint is a good play hint iff the newest touched card is playable
// right now (that's the card the convention tells them to play).
function findColorPlayHint(view, hand) {
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length === 0) continue;
    const newest = touched[touched.length - 1];
    if (!isPlayable(view, newest.card.color, newest.card.number)) continue;
    // Redundant if that card is already their pending colour target.
    if (colorPlayTargetIndex(hand) === newest.i) continue;
    return { hintType: 'color', value: color };
  }
  return null;
}

// A number hint works as a play hint only when it makes some touched card
// provably playable (the receiver keeps number-hinted cards otherwise).
function findNumberPlayHint(view, hand) {
  const numbers = [...new Set(hand.map((c) => c.number))];
  for (const n of numbers) {
    const touched = hand.filter((c) => c.number === n);
    const wouldPlay = touched.some((c) => {
      const after = { ...c, possibleNumbers: [n] };
      return knownPlayable(view, after) && isPlayable(view, c.color, c.number);
    });
    if (wouldPlay) return { hintType: 'number', value: n };
  }
  return null;
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
  const others = view.players.map((p, i) => ({ ...p, index: i })).filter((p) => p.index !== me);
  const nextIndex = (me + 1) % view.players.length;
  const lastFuse = view.fuseTokens === 1;

  // 1. Play a card we can prove is playable.
  for (let i = 0; i < myHand.length; i++) {
    if (knownPlayable(view, myHand[i])) {
      return { action: { type: 'play', cardIndex: i }, reason: 'known playable' };
    }
  }

  // 2. Play the newest card touched by the latest colour hint.
  if (conventions.colorHintPlaysNewest) {
    const t = colorPlayTargetIndex(myHand);
    if (t >= 0) {
      const safeEnough = lastFuse ? knownPlayable(view, myHand[t]) : possiblyPlayable(view, myHand[t]);
      if (safeEnough) {
        return { action: { type: 'play', cardIndex: t }, reason: 'colour hint marks newest touched' };
      }
    }
  }

  if (view.hintTokens > 0) {
    // 3. Save the next player's chop if it's the last copy of a needed card
    //    and they have nothing better to do than discard it.
    if (conventions.numberHintSaves) {
      const next = view.players[nextIndex];
      const chop = chopIndex(next.hand);
      if (chop >= 0 && isCritical(view, next.hand[chop]) && !hasPendingPlay(view, next.hand)) {
        return {
          action: { type: 'hint', toPlayerIndex: nextIndex, hintType: 'number', value: next.hand[chop].number },
          reason: `save ${next.hand[chop].color} ${next.hand[chop].number} on chop`,
        };
      }
    }

    // 4. Give a play hint (closest player first; colour hints preferred).
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      const hand = view.players[idx].hand;
      if (hasPendingPlay(view, hand)) continue; // they already have a play
      const hint = findColorPlayHint(view, hand) || findNumberPlayHint(view, hand);
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
      if (knownUseless(view, myHand[i])) {
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
    if (possiblyPlayable(view, myHand[i])) {
      return { action: { type: 'play', cardIndex: i }, reason: 'forced play (best odds)' };
    }
  }
  return { action: { type: 'play', cardIndex: myHand.length - 1 }, reason: 'forced play' };
}
