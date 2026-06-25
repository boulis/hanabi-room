import { getVariant } from './variants.js';
import {
  MAX_HINT_TOKENS,
  allHandsEmpty,
  maxPossibleScore,
  pileComplete,
  pileDirection,
  pileTop,
  score,
} from './game.js';

export class GameError extends Error {
  constructor(message, code = 'invalid_action') {
    super(message);
    this.code = code;
  }
}

function requirePlaying(state) {
  if (state.status !== 'playing') throw new GameError('Game is not in progress', 'not_playing');
}

function requireTurn(state, playerIndex) {
  requirePlaying(state);
  if (state.currentPlayer !== playerIndex) throw new GameError('Not your turn', 'wrong_turn');
}

function requireCard(state, playerIndex, cardIndex) {
  const hand = state.players[playerIndex].hand;
  if (cardIndex < 0 || cardIndex >= hand.length) throw new GameError('Invalid card index', 'no_card');
  return hand[cardIndex];
}

function drawIfPossible(state, playerIndex) {
  if (state.deck.length === 0) {
    if (state.endRule === 'standard' && state.finalTurn === null) {
      state.finalTurn = state.turn + state.players.length + 1;
    }
    return null;
  }
  const card = state.deck.pop();
  state.players[playerIndex].hand.push(card);
  if (state.deck.length === 0 && state.endRule === 'standard' && state.finalTurn === null) {
    state.finalTurn = state.turn + state.players.length + 1;
  }
  return card;
}

function advanceTurn(state) {
  state.turn += 1;
  if (state.fuseTokens === 0) {
    state.status = 'finished';
    state.endReason = 'fuses';
    return;
  }
  if (score(state) === maxPossibleScore(state)) {
    state.status = 'finished';
    state.endReason = 'perfect';
    return;
  }
  if (state.endRule === 'standard' && state.finalTurn !== null && state.turn >= state.finalTurn) {
    state.status = 'finished';
    state.endReason = 'deck';
    return;
  }
  if (state.endRule === 'lax' && state.deck.length === 0 && allHandsEmpty(state)) {
    state.status = 'finished';
    state.endReason = 'deck';
    return;
  }
  const n = state.players.length;
  let next = (state.currentPlayer + 1) % n;
  let guard = 0;
  while (
    state.endRule === 'lax' &&
    state.deck.length === 0 &&
    state.players[next].hand.length === 0 &&
    guard < n
  ) {
    next = (next + 1) % n;
    guard += 1;
  }
  state.currentPlayer = next;
}

function pushLog(state, event) {
  state.log.push({ turn: state.turn, ...event });
}

export function playAction(state, playerIndex, cardIndex) {
  requireTurn(state, playerIndex);
  const card = requireCard(state, playerIndex, cardIndex);
  state.players[playerIndex].hand.splice(cardIndex, 1);

  const playable =
    pileDirection(state, card.color) === 'up'
      ? card.number === pileTop(state, card.color) + 1
      : card.number === pileTop(state, card.color) - 1;

  if (playable) {
    state.playedPiles[card.color].push(card);
    let bonusHint = false;
    if (pileComplete(state, card.color) && state.hintTokens < MAX_HINT_TOKENS) {
      state.hintTokens += 1;
      bonusHint = true;
    }
    pushLog(state, {
      type: 'play',
      playerIndex,
      card: { id: card.id, color: card.color, number: card.number },
      success: true,
      bonusHint,
    });
  } else {
    state.discard.push(card);
    state.fuseTokens -= 1;
    pushLog(state, {
      type: 'play',
      playerIndex,
      card: { id: card.id, color: card.color, number: card.number },
      success: false,
    });
  }

  const drawn = drawIfPossible(state, playerIndex);
  if (drawn) pushLog(state, { type: 'draw', playerIndex, cardId: drawn.id });
  advanceTurn(state);
  return state;
}

export function discardAction(state, playerIndex, cardIndex) {
  requireTurn(state, playerIndex);
  if (state.hintTokens >= MAX_HINT_TOKENS) {
    throw new GameError('Cannot discard at maximum hint tokens', 'tokens_full');
  }
  const card = requireCard(state, playerIndex, cardIndex);
  state.players[playerIndex].hand.splice(cardIndex, 1);
  state.discard.push(card);
  state.hintTokens += 1;
  pushLog(state, {
    type: 'discard',
    playerIndex,
    card: { id: card.id, color: card.color, number: card.number },
  });
  const drawn = drawIfPossible(state, playerIndex);
  if (drawn) pushLog(state, { type: 'draw', playerIndex, cardId: drawn.id });
  advanceTurn(state);
  return state;
}

function colorsTouchedByHint(variant, hintColor) {
  const set = new Set();
  for (const suit of variant.suits) {
    if (suit.hintMatches === 'all') set.add(suit.color);
    else if (suit.hintMatches === 'self' && suit.color === hintColor) set.add(suit.color);
  }
  return set;
}

function cardTouchedByColor(variant, card, hintColor) {
  const suit = variant.suits.find((s) => s.color === card.color);
  if (suit.hintMatches === 'all') return true;
  if (suit.hintMatches === 'self') return card.color === hintColor;
  return false;
}

export function hintAction(state, fromIndex, toIndex, hintType, value) {
  requireTurn(state, fromIndex);
  if (state.hintTokens <= 0) throw new GameError('No hint tokens left', 'no_tokens');
  if (fromIndex === toIndex) throw new GameError('Cannot hint yourself', 'self_hint');
  if (toIndex < 0 || toIndex >= state.players.length) throw new GameError('Invalid target', 'bad_target');
  const variant = getVariant(state.variantId);
  const targetHand = state.players[toIndex].hand;

  let touchedIndexes = [];
  if (hintType === 'color') {
    if (!variant.suits.some((s) => s.hintMatches === 'self' && s.color === value)) {
      throw new GameError(`Color '${value}' cannot be hinted in this variant`, 'bad_color');
    }
    const touchedSet = colorsTouchedByHint(variant, value);
    targetHand.forEach((card, i) => {
      const touched = cardTouchedByColor(variant, card, value);
      if (touched) {
        card.colorClued = true;
        card.possibleColors = card.possibleColors.filter((c) => touchedSet.has(c));
        touchedIndexes.push(i);
      } else {
        card.possibleColors = card.possibleColors.filter((c) => !touchedSet.has(c));
      }
    });
  } else if (hintType === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new GameError(`Number '${value}' is not 1-5`, 'bad_number');
    }
    targetHand.forEach((card, i) => {
      if (card.number === value) {
        card.numberClued = true;
        card.possibleNumbers = [value];
        touchedIndexes.push(i);
      } else {
        card.possibleNumbers = card.possibleNumbers.filter((n) => n !== value);
      }
    });
  } else {
    throw new GameError(`Unknown hint type: ${hintType}`, 'bad_hint_type');
  }

  if (touchedIndexes.length === 0 && !state.allowEmptyHints) {
    throw new GameError('Hint must touch at least one card', 'empty_hint');
  }

  const touchedSet = new Set(touchedIndexes);
  targetHand.forEach((card, i) => {
    card.lastHint = touchedSet.has(i) ? { type: hintType, value } : null;
  });

  state.hintTokens -= 1;
  pushLog(state, {
    type: 'hint',
    fromIndex,
    toIndex,
    hintType,
    value,
    touchedIndexes,
  });
  advanceTurn(state);
  return state;
}

export function annotateAction(state, playerIndex, cardId, { note, guarded }) {
  requirePlaying(state);
  const hand = state.players[playerIndex].hand;
  const card = hand.find((c) => c.id === cardId);
  if (!card) throw new GameError('Card not in your hand', 'no_card');

  if (note !== undefined) {
    if (typeof note !== 'string') throw new GameError('note must be a string', 'bad_annotation');
    card.annotations.note = note.slice(0, 200);
  }
  if (guarded !== undefined) {
    if (typeof guarded !== 'boolean') throw new GameError('guarded must be boolean', 'bad_annotation');
    card.annotations.guarded = guarded;
  }
  return state;
}
