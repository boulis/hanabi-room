// Bot par score: what a table of bots scores on the very same deck.
//
// Every game is played from a fixed deck (the save header's draw order, or the
// seed that shuffles it), so "how would the robots have done with these cards?"
// is a deterministic function of that deck plus the rules the humans played
// under. That makes it a par score: 24/25 on a deck the bots wring 25 out of
// reads very differently from 24/25 on a deck they only manage 20 on.
//
// The simulation is the benchmark's `playOut` — the same brain, driven through
// the real rules engine against filtered views, so it cannot cheat and an
// illegal move throws. It is pure: no filesystem, no room. Persistence of the
// results lives in savedGame.js (a sidecar next to the saves, like tags), which
// is also why this module must not import it.
import { createInitialState, maxPossibleScore, score } from './game.js';
import { annotateAction, discardAction, hintAction, playAction } from './rules.js';
import { viewState } from './view.js';
import * as brain from './botBrain.js';

// Stamped on every stored result: a brain change moves par, so an entry made by
// an older version is stale and gets recomputed rather than compared against.
export const BOT_SCORE_VERSION = brain.BOT_VERSION ?? '1.0';

// A bot game is a few hundred moves at most; this only exists so a brain bug
// can't spin the server forever.
const MAX_TURNS = 1000;

// Bots read each other's guard marks (the alarm convention needs it), exactly
// as in benchmark.mjs — so par is comparable across the library no matter what
// the humans had `shareGuarded` set to. The rules that decide what score is
// *reachable* (variant, end rule, empty hints) come from the real game.
export function simulateBotGame({
  variantId,
  endRule,
  allowEmptyHints,
  playerCount,
  seed,
  deckCards,
}) {
  // endRule/allowEmptyHints left undefined fall back to createInitialState's
  // own defaults, so a legacy save missing them replays as it was dealt.
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` }));
  const state = createInitialState({
    variantId,
    endRule,
    allowEmptyHints,
    shareGuarded: true,
    players,
    seed,
    deckCards,
  });
  const memories = players.map(() => ({}));
  let moves = 0;
  let guard = 0;
  while (state.status === 'playing' && guard++ < MAX_TURNS) {
    const idx = state.currentPlayer;
    // Annotations are turn-free, so guards are applied before deciding — the
    // same order the live bot driver uses.
    for (const cardId of brain.alarmGuards(viewState(state, idx))) {
      annotateAction(state, idx, cardId, { guarded: true });
    }
    const { action } = brain.decide(viewState(state, idx), undefined, memories[idx]);
    switch (action.type) {
      case 'play': playAction(state, idx, action.cardIndex); break;
      case 'discard': discardAction(state, idx, action.cardIndex); break;
      case 'hint': hintAction(state, idx, action.toPlayerIndex, action.hintType, action.value); break;
      default: throw new Error(`bot proposed unknown action ${action.type}`);
    }
    moves++;
  }
  if (state.status !== 'finished') {
    throw new Error(`bot game did not end (${variantId}, ${playerCount}p, seed ${seed})`);
  }
  return {
    version: BOT_SCORE_VERSION,
    score: score(state),
    maxScore: maxPossibleScore(state),
    misplays: 3 - state.fuseTokens,
    endReason: state.endReason,
    moves,
    playerCount,
  };
}

// The deck a game was actually dealt from. `initialDeckCards` (draw order) is
// stamped on every state since 0.9.0; older saves fall back to the seed, which
// createInitialState shuffles the same way it did back then.
function deckConfigOf({ initialDeckCards, deck, seed }) {
  const cards = initialDeckCards ?? deck;
  return Array.isArray(cards) && cards.length ? { deckCards: cards } : { seed };
}

// Par for a live game state (the room computes this when the game ends).
export function botScoreForState(state) {
  return simulateBotGame({
    variantId: state.variantId,
    endRule: state.endRule,
    allowEmptyHints: state.allowEmptyHints,
    playerCount: state.players.length,
    ...deckConfigOf(state),
  });
}

// Par for a save, straight from its header — no need to replay the game itself,
// since only the deal matters.
export function botScoreForSaveHeader(header) {
  return simulateBotGame({
    variantId: header.variantId,
    endRule: header.endRule,
    allowEmptyHints: header.allowEmptyHints,
    playerCount: header.players.length,
    ...deckConfigOf(header),
  });
}
