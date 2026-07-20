// Bot-vs-bot benchmark: runs the brain against itself over a fixed set of
// seeds and prints score statistics per variant and player count. Fully
// deterministic — the shuffle is seeded and the brain is pure — so two runs
// of the same code always print the same numbers. Use it to judge whether a
// convention change actually pays: run before and after, compare, and put the
// numbers in the commit message.
//
// Usage: node benchmark.mjs [--seeds N] [--players 2,3,4] [--variants a,b]
//                           [--end lax|standard]
import { createInitialState } from './server/game.js';
import { annotateAction, discardAction, hintAction, playAction } from './server/rules.js';
import { viewState } from './server/view.js';
import * as brain from './server/botBrain.js';
import { VARIANTS } from './server/variants.js';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const seeds = Number(flag('seeds', '50'));
const playerCounts = flag('players', '2,3,4').split(',').map(Number);
const variantIds = flag('variants', Object.keys(VARIANTS).join(',')).split(',');
const endRule = flag('end', 'lax');
// Off by default (matches a fresh room); pass --emptyhints to exercise the
// zero-card-hint convention (play-your-chop signals need allowEmptyHints).
const allowEmptyHints = process.argv.includes('--emptyhints');

function playOut(variantId, playerCount, seed) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` }));
  // shareGuarded lets the bots see each other's guard marks — the alarm
  // convention needs that to model teammates' chops accurately.
  const state = createInitialState({ variantId, endRule, players, seed, shareGuarded: true, allowEmptyHints });
  const memories = players.map(() => ({}));
  let guard = 0;
  while (state.status === 'playing' && guard++ < 1000) {
    const idx = state.currentPlayer;
    const guards = brain.alarmGuards ? brain.alarmGuards(viewState(state, idx)) : [];
    for (const cardId of guards) annotateAction(state, idx, cardId, { guarded: true });
    const { action } = brain.decide(viewState(state, idx), undefined, memories[idx]);
    switch (action.type) {
      case 'play': playAction(state, idx, action.cardIndex); break;
      case 'discard': discardAction(state, idx, action.cardIndex); break;
      case 'hint': hintAction(state, idx, action.toPlayerIndex, action.hintType, action.value); break;
      default: throw new Error(`bot proposed unknown action ${action.type}`);
    }
  }
  if (state.status !== 'finished') throw new Error(`game did not end (${variantId} ${playerCount}p seed ${seed})`);
  return state;
}

const started = Date.now();
console.log(`bot ${brain.BOT_VERSION ?? '1.0'} — ${seeds} seeds per row, end rule: ${endRule}\n`);
console.log(
  'variant'.padEnd(31), 'players', '  avg', '  min', ' max', ' perfect', ' fused', ' misplays/game',
);
for (const variantId of variantIds) {
  const max = VARIANTS[variantId].suits.length * 5;
  for (const playerCount of playerCounts) {
    let total = 0, min = Infinity, best = 0, perfect = 0, fused = 0, misplays = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const end = playOut(variantId, playerCount, seed);
      const score = Object.values(end.playedPiles).reduce((a, p) => a + p.length, 0);
      total += score;
      min = Math.min(min, score);
      best = Math.max(best, score);
      if (end.endReason === 'perfect') perfect++;
      if (end.endReason === 'fuses') fused++;
      misplays += 3 - end.fuseTokens;
    }
    console.log(
      `${variantId}/${max}`.padEnd(31),
      String(playerCount).padStart(7),
      (total / seeds).toFixed(2).padStart(5),
      String(min).padStart(5),
      String(best).padStart(4),
      String(perfect).padStart(8),
      String(fused).padStart(6),
      (misplays / seeds).toFixed(2).padStart(14),
    );
  }
}
console.log(`\n${variantIds.length * playerCounts.length * seeds} games in ${Date.now() - started}ms`);
