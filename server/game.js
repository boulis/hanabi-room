import { getVariant } from './variants.js';

export const STARTING_HINT_TOKENS = 8;
export const MAX_HINT_TOKENS = 8;
export const STARTING_FUSE_TOKENS = 3;

export function buildDeck(variantId) {
  const variant = getVariant(variantId);
  const cards = [];
  let id = 0;
  for (const suit of variant.suits) {
    for (const number of suit.distribution) {
      cards.push(makeCard(id++, suit.color, number, variant));
    }
  }
  return cards;
}

export function makeCard(id, color, number, variant) {
  return {
    id,
    color,
    number,
    possibleColors: variant.suits.map((s) => s.color),
    possibleNumbers: [1, 2, 3, 4, 5],
    colorClued: false,
    numberClued: false,
    lastHints: [],
    annotations: { note: '', guarded: false },
  };
}

export function shuffle(cards, rng = Math.random) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function handSize(playerCount) {
  if (playerCount <= 3) return 5;
  return 4;
}

export function createInitialState({
  variantId,
  endRule = 'standard',
  shareGuarded = false,
  allowEmptyHints = false,
  players,
  seed,
  deckCards,
}) {
  if (!['standard', 'lax'].includes(endRule)) {
    throw new Error(`Unknown endRule: ${endRule}`);
  }
  if (players.length < 2 || players.length > 5) {
    throw new Error(`Player count must be 2-5, got ${players.length}`);
  }
  const finalSeed = seed != null ? (seed >>> 0) : Math.floor(Math.random() * 0x100000000);
  const variant = getVariant(variantId);
  // deckCards = explicit draw-order list (from an import or save header).
  // Without it, shuffle from the seed.
  const deck = deckCards
    ? cardsFromDrawOrder(variantId, deckCards)
    : shuffledDeck(variantId, finalSeed);
  // Capture the draw-order snapshot before dealing pops anything off.
  const initialDeckCards = deck.slice().reverse().map((c) => `${c.color}_${c.number}`);
  const size = handSize(players.length);
  const hands = players.map(() => []);
  for (let i = 0; i < size; i++) {
    for (let p = 0; p < players.length; p++) {
      hands[p].push(deck.pop());
    }
  }
  const playedPiles = Object.fromEntries(variant.suits.map((s) => [s.color, []]));
  return {
    status: 'playing',
    variantId,
    endRule,
    shareGuarded,
    allowEmptyHints,
    seed: finalSeed,
    players: players.map((p, i) => ({ id: p.id, name: p.name, hand: hands[i] })),
    deck,
    discard: [],
    playedPiles,
    hintTokens: STARTING_HINT_TOKENS,
    fuseTokens: STARTING_FUSE_TOKENS,
    currentPlayer: 0,
    turn: 0,
    finalTurn: null,
    log: [],
    endReason: null,
    nextHintIndex: 0,
    startedAt: Date.now(),
    endedAt: null,
    initialDeckCards,
  };
}

export function shuffledDeck(variantId, seed) {
  return shuffle(buildDeck(variantId), mulberry32(seed));
}

function tallyCards(cards) {
  const t = Object.create(null);
  for (const c of cards) {
    const k = `${c.color}_${c.number}`;
    t[k] = (t[k] || 0) + 1;
  }
  return t;
}

export function validateDeckAgainstVariant(variantId, drawOrderStrings) {
  if (!Array.isArray(drawOrderStrings)) {
    throw new Error('Deck must be an array of "<color>_<number>" strings');
  }
  const variant = getVariant(variantId);
  const expected = [];
  for (const suit of variant.suits) {
    for (const n of suit.distribution) expected.push({ color: suit.color, number: n });
  }
  if (drawOrderStrings.length !== expected.length) {
    throw new Error(
      `Deck size ${drawOrderStrings.length} doesn't match variant ${variantId} (${expected.length} cards)`,
    );
  }
  const parsed = drawOrderStrings.map((s, i) => {
    const m = typeof s === 'string' ? /^([a-z]+)_([1-5])$/.exec(s) : null;
    if (!m) throw new Error(`Card ${i + 1} (${JSON.stringify(s)}) is not in <color>_<number> format`);
    return { color: m[1], number: Number(m[2]) };
  });
  const got = tallyCards(parsed);
  const want = tallyCards(expected);
  const seen = new Set();
  for (const k of Object.keys(want)) {
    seen.add(k);
    if ((got[k] || 0) !== want[k]) {
      throw new Error(
        `Variant ${variantId} expects ${want[k]} ${k}, deck has ${got[k] || 0}`,
      );
    }
  }
  for (const k of Object.keys(got)) {
    if (!seen.has(k)) throw new Error(`Variant ${variantId} has no ${k}`);
  }
  return parsed;
}

function cardsFromDrawOrder(variantId, drawOrderStrings) {
  const variant = getVariant(variantId);
  const parsed = validateDeckAgainstVariant(variantId, drawOrderStrings);
  // Reverse: the internal deck array pops from the end, so the first-drawn
  // card belongs at index length-1.
  const reversed = parsed.slice().reverse();
  return reversed.map((c, i) => makeCard(i, c.color, c.number, variant));
}

function formatLocalDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function exportDeckOrder(state) {
  const variant = getVariant(state.variantId);
  // initialDeckCards is the post-shuffle (or imported) draw order, captured
  // at game start. Fall back to re-shuffling for any legacy state without it.
  const cards = state.initialDeckCards
    ? state.initialDeckCards.slice()
    : shuffledDeck(state.variantId, state.seed)
        .slice()
        .reverse()
        .map((c) => `${c.color}_${c.number}`);
  const startedAt = state.startedAt ?? Date.now();
  const endedAt = state.endedAt ?? Date.now();
  return {
    date: formatLocalDate(new Date(startedAt)),
    score: score(state),
    duration_seconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
    count: cards.length,
    cards,
    validation: {
      matched_set: variant.matchedSetDescription || '',
      is_exact: true,
      discrepancy_summary: '',
    },
  };
}

export const HINT_MARK_LIMIT = 4;

export function dropHintMarkFromHand(hand, hintIndex) {
  for (const card of hand) {
    card.lastHints = card.lastHints.filter((h) => h.hintIndex !== hintIndex);
  }
}

export function pileTop(state, color) {
  const variant = getVariant(state.variantId);
  const suit = variant.suits.find((s) => s.color === color);
  const pile = state.playedPiles[color];
  if (pile.length === 0) return suit.direction === 'up' ? 0 : 6;
  return pile[pile.length - 1].number;
}

export function pileDirection(state, color) {
  const variant = getVariant(state.variantId);
  return variant.suits.find((s) => s.color === color).direction;
}

export function pileComplete(state, color) {
  return state.playedPiles[color].length === 5;
}

export function score(state) {
  return Object.values(state.playedPiles).reduce((sum, pile) => sum + pile.length, 0);
}

export function maxPossibleScore(state) {
  const variant = getVariant(state.variantId);
  return variant.suits.length * 5;
}

function maxAchievablePileLength(state, suit) {
  const pile = state.playedPiles[suit.color];
  if (pile.length === 5) return 5;
  const top = pile.length === 0
    ? (suit.direction === 'up' ? 0 : 6)
    : pile[pile.length - 1].number;
  const distCount = Object.create(null);
  for (const n of suit.distribution) distCount[n] = (distCount[n] || 0) + 1;
  const discardedCount = Object.create(null);
  for (const c of state.discard) {
    if (c.color === suit.color) discardedCount[c.number] = (discardedCount[c.number] || 0) + 1;
  }
  let reachable = pile.length;
  if (suit.direction === 'up') {
    for (let n = top + 1; n <= 5; n++) {
      if ((distCount[n] || 0) - (discardedCount[n] || 0) > 0) reachable++;
      else break;
    }
  } else {
    for (let n = top - 1; n >= 1; n--) {
      if ((distCount[n] || 0) - (discardedCount[n] || 0) > 0) reachable++;
      else break;
    }
  }
  return reachable;
}

export function maxAchievableScore(state) {
  const variant = getVariant(state.variantId);
  let total = 0;
  for (const suit of variant.suits) total += maxAchievablePileLength(state, suit);
  return total;
}

export function pileCap(state, color) {
  const variant = getVariant(state.variantId);
  const suit = variant.suits.find((s) => s.color === color);
  return maxAchievablePileLength(state, suit);
}

export function allHandsEmpty(state) {
  return state.players.every((p) => p.hand.length === 0);
}

export function hintableColors(variantId) {
  const variant = getVariant(variantId);
  return variant.suits.filter((s) => s.hintMatches === 'self').map((s) => s.color);
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
