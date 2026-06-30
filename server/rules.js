import { getVariant } from './variants.js';
import {
  HINT_MARK_LIMIT,
  MAX_HINT_TOKENS,
  allHandsEmpty,
  dropHintMarkFromHand,
  maxAchievableScore,
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

function endGame(state, reason) {
  state.status = 'finished';
  state.endReason = reason;
  state.endedAt = Date.now();
}

function advanceTurn(state) {
  state.turn += 1;
  if (state.fuseTokens === 0) {
    endGame(state, 'fuses');
    return;
  }
  const reachable = maxAchievableScore(state);
  if (score(state) >= reachable) {
    endGame(state, reachable === maxPossibleScore(state) ? 'perfect' : 'maxed');
    return;
  }
  if (state.endRule === 'standard' && state.finalTurn !== null && state.turn >= state.finalTurn) {
    endGame(state, 'deck');
    return;
  }
  if (state.endRule === 'lax' && state.deck.length === 0 && allHandsEmpty(state)) {
    endGame(state, 'deck');
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

function consumeHintMarks(hand, leavingCard) {
  for (const h of leavingCard.lastHints) {
    dropHintMarkFromHand(hand, h.hintIndex);
  }
}

function isFullyKnown(card) {
  return card.possibleColors.length === 1 && card.possibleNumbers.length === 1;
}

function chopIndex(hand, { skipGuarded } = {}) {
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.colorClued || c.numberClued) continue;
    if (skipGuarded && c.annotations?.guarded) continue;
    return i;
  }
  return -1;
}

export function playAction(state, playerIndex, cardIndex) {
  requireTurn(state, playerIndex);
  const card = requireCard(state, playerIndex, cardIndex);
  const wasTouched = card.colorClued || card.numberClued;
  const wasFullyKnown = isFullyKnown(card);
  state.players[playerIndex].hand.splice(cardIndex, 1);
  consumeHintMarks(state.players[playerIndex].hand, card);

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
      cardIndex,
      card: { id: card.id, color: card.color, number: card.number },
      success: true,
      bonusHint,
      wasTouched,
      wasFullyKnown,
    });
  } else {
    state.discard.push(card);
    state.fuseTokens -= 1;
    pushLog(state, {
      type: 'play',
      playerIndex,
      cardIndex,
      card: { id: card.id, color: card.color, number: card.number },
      success: false,
      wasTouched,
      wasFullyKnown,
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
  const wasTouched = card.colorClued || card.numberClued;
  const wasFullyKnown = isFullyKnown(card);
  const knownColors = card.possibleColors.slice();
  const knownNumbers = card.possibleNumbers.slice();
  // When guard marks are public, a guarded card counts as "taken care of" and
  // is skipped when finding the chop, so the past-chop callout reflects what
  // every player can see.
  const chop = chopIndex(state.players[playerIndex].hand, { skipGuarded: state.shareGuarded });
  state.players[playerIndex].hand.splice(cardIndex, 1);
  consumeHintMarks(state.players[playerIndex].hand, card);
  state.discard.push(card);
  state.hintTokens += 1;
  pushLog(state, {
    type: 'discard',
    playerIndex,
    card: { id: card.id, color: card.color, number: card.number },
    wasTouched,
    wasFullyKnown,
    knownColors,
    knownNumbers,
    chopIndex: chop,
    cardIndex,
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

  const hintIndex = state.nextHintIndex++;
  for (const i of touchedIndexes) {
    // If this card already carries a mark with the same (hintType, value),
    // drop the older one so the repeat hint replaces it instead of stacking
    // a duplicate dot. Only this card is affected; other cards that shared
    // the old hintIndex keep their marker.
    targetHand[i].lastHints = targetHand[i].lastHints.filter(
      (h) => !(h.hintType === hintType && h.value === value),
    );
    targetHand[i].lastHints.push({ hintIndex, hintType, value });
  }
  // Cap each touched card at HINT_MARK_LIMIT; when a card overflows, drop its
  // oldest hintIndex from EVERY card in the receiver's hand (a hint mark is
  // tied to a hint event, not to a single card).
  for (const i of touchedIndexes) {
    while (targetHand[i].lastHints.length > HINT_MARK_LIMIT) {
      const dropped = targetHand[i].lastHints.shift();
      dropHintMarkFromHand(targetHand, dropped.hintIndex);
    }
  }

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
