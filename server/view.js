import { getVariant, VARIANTS } from './variants.js';
import { hintableColors, maxAchievableScore, maxPossibleScore, pileCap, pileTop, score } from './game.js';

function viewCard(card, { revealIdentity, isOwner, shareGuarded }) {
  const out = {
    id: card.id,
    possibleColors: card.possibleColors.slice(),
    possibleNumbers: card.possibleNumbers.slice(),
    colorClued: card.colorClued,
    numberClued: card.numberClued,
    lastHints: card.lastHints.map((h) => ({ ...h })),
  };
  if (revealIdentity) {
    out.color = card.color;
    out.number = card.number;
  }
  if (isOwner) {
    out.annotations = {
      note: card.annotations.note,
      guarded: card.annotations.guarded,
    };
  } else if (shareGuarded) {
    out.annotations = { guarded: card.annotations.guarded };
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
    shareGuarded: state.shareGuarded,
    allowEmptyHints: state.allowEmptyHints,
    viewerIndex,
    currentPlayer: state.currentPlayer,
    turn: state.turn,
    finalTurn: state.finalTurn,
    hintTokens: state.hintTokens,
    fuseTokens: state.fuseTokens,
    deckSize: state.deck.length,
    score: score(state),
    maxScore: maxPossibleScore(state),
    maxAchievable: maxAchievableScore(state),
    endReason: state.endReason,
    seed: state.status === 'finished' ? state.seed : null,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    playedPiles: Object.fromEntries(
      Object.entries(state.playedPiles).map(([color, pile]) => [
        color,
        { top: pileTop(state, color), count: pile.length, cap: pileCap(state, color) },
      ]),
    ),
    discard: state.discard.map((c) => ({ id: c.id, color: c.color, number: c.number })),
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      hand: p.hand.map((c) =>
        viewCard(c, {
          // Reveal everyone's cards once the game is over — there's no hidden
          // information left to protect and players want to see what they had.
          revealIdentity: i !== viewerIndex || state.status === 'finished',
          isOwner: i === viewerIndex,
          shareGuarded: state.shareGuarded,
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
    players: lobby.players.map((p) => ({ id: p.id, name: p.name, online: p.online, isBot: !!p.isBot })),
    hostId: lobby.hostId,
    importedDeck: lobby.importedDeck ? { count: lobby.importedDeck.length } : null,
  };
}
