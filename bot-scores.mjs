// Backfill the bot par score ("what would the robots have scored on this
// deck?") for every saved game that has none, or whose stored par was made by
// an older brain. Writes saved-games/bot-scores.json.
//
// The server does the same pass in the background at boot; this is the one-off
// for a library that has never been scored, or right after a BOT_VERSION bump.
//
// Usage: npm run bot-scores   (or: node bot-scores.mjs)
import { BOT_SCORE_VERSION } from './server/botScore.js';
import { backfillBotScores } from './server/savedGame.js';

const started = Date.now();
console.log(`Scoring saved games with bot ${BOT_SCORE_VERSION}…`);
const { total, computed } = await backfillBotScores({
  onProgress: ({ basename, entry }) => {
    const par = entry ? `${entry.score}/${entry.maxScore} (${entry.endReason})` : 'failed';
    console.log(`  ${basename.padEnd(48)} ${par}`);
  },
});
console.log(
  computed === 0
    ? `All ${total} saved games already scored with bot ${BOT_SCORE_VERSION}.`
    : `Scored ${computed} of ${total} saved games in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
);
