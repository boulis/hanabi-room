import { getVariant, VARIANTS } from './variants.js';
import { hintableColors, maxPossibleScore, pileTop, score } from './game.js';

function viewCard(card, { revealIdentity, includeAnnotations }) {
  const out = {
    id: card.id,
    possibleColors: card.possibleColors.slice(),
    possibleNumbers: card.possibleNumbers.slice(),
    colorClued: card.colorClued,
    numberClued: card.numberClued,
  };
  if (revealIdentity) {
    out.color = card.color;
    out.number = card.number;
  }
  if (includeAnnotations) {
    out.annotations = {
      manualColors: card.annotations.manualColors.slice(),
      manualNumbers: card.annotations.manualNumbers.slice(),
      note: card.annotations.note,
    };
  }
  return out;
}

export function viewState(state, viewerIndex) {
  const variant = getVariant(state.variantId);
  return {
    status: state.status,
    variantId: state.variantId,
    variantName: variant.name,
    suits: variant.suits.map((s) => ({
      color: s.color,
      direction: s.direction,
      hintMatches: s.hintMatches,
    })),
    hintableColors: hintableColors(state.variantId),
    endRule: state.endRule,
    shareAnnotations: state.shareAnnotations,
    viewerIndex,
    currentPlayer: state.currentPlayer,
    turn: state.turn,
    finalTurn: state.finalTurn,
    hintTokens: state.hintTokens,
    fuseTokens: state.fuseTokens,
    deckSize: state.deck.length,
    score: score(state),
    maxScore: maxPossibleScore(state),
    endReason: state.endReason,
    playedPiles: Object.fromEntries(
      Object.entries(state.playedPiles).map(([color, pile]) => [
        color,
        { top: pileTop(state, color), count: pile.length },
      ]),
    ),
    discard: state.discard.map((c) => ({ id: c.id, color: c.color, number: c.number })),
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      hand: p.hand.map((c) =>
        viewCard(c, {
          revealIdentity: i !== viewerIndex,
          includeAnnotations: i === viewerIndex || state.shareAnnotations,
        }),
      ),
    })),
    log: state.log.slice(-50),
  };
}

export function lobbyView(lobby) {
  return {
    status: 'lobby',
    options: { ...lobby.options },
    variants: Object.values(VARIANTS).map((v) => ({ id: v.id, name: v.name })),
    players: lobby.players.map((p) => ({ id: p.id, name: p.name, online: p.online })),
    hostId: lobby.hostId,
  };
}
