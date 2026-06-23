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
    annotations: { manualColors: [], manualNumbers: [], note: '' },
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
  shareAnnotations = false,
  players,
  seed,
}) {
  if (!['standard', 'lax'].includes(endRule)) {
    throw new Error(`Unknown endRule: ${endRule}`);
  }
  if (players.length < 2 || players.length > 5) {
    throw new Error(`Player count must be 2-5, got ${players.length}`);
  }
  const variant = getVariant(variantId);
  const rng = seed != null ? mulberry32(seed) : Math.random;
  const deck = shuffle(buildDeck(variantId), rng);
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
    shareAnnotations,
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
  };
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
