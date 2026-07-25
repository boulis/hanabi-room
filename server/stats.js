// Per-player statistics for a single game, derived from the log.
//
// Everything here is a pure function of the state, so the same code serves a
// live finished game (view.js) and a save reconstructed from disk
// (savedGame.js's library summaries). The client aggregates the per-game
// summaries it receives in the lobby view into all-time tables.

const ACTION_TYPES = new Set(['play', 'discard', 'hint']);

// Games get paused — someone walks away, a game sits open overnight. Charging
// that whole gap to whoever was on turn makes the time column meaningless (one
// AFK move can outweigh a whole evening of play), so a single move counts for
// at most this much. The game's wall-clock length is reported separately and
// is not capped.
export const MAX_MOVE_MS = 5 * 60 * 1000;

function actorOf(entry) {
  return entry.type === 'hint' ? entry.fromIndex : entry.playerIndex;
}

// One row per seat. Counts exclude undone actions (they were rolled back), but
// move time includes them — the player still spent that time thinking, and
// dropping it would leave the per-player times summing to less than the game.
// `botFlags` names which seats were bots — the game state itself doesn't know
// (the flag lives on the room's seat list, or in a save header), so callers
// that do know pass it in.
export function gameStats(state, { botFlags = [] } = {}) {
  const rows = state.players.map((p, i) => ({
    index: i,
    name: p.name,
    isBot: !!(botFlags[i] ?? p.isBot),
    plays: 0,
    discards: 0,
    hints: 0,
    undos: 0,
    moves: 0,
    moveMs: 0,
  }));

  // Undo re-appends the undone entries at the end of the log, so array order
  // isn't time order; `at` is.
  const actions = state.log
    .filter((e) => ACTION_TYPES.has(e.type) && typeof e.at === 'number')
    .sort((a, b) => a.at - b.at);

  let prev = typeof state.startedAt === 'number' ? state.startedAt : null;
  for (const e of actions) {
    const row = rows[actorOf(e)];
    if (!row) continue;
    if (prev != null) {
      row.moveMs += Math.min(MAX_MOVE_MS, Math.max(0, e.at - prev));
      row.moves += 1;
    }
    prev = e.at;
    // An undone action counts as an undo for whoever took it (only that player
    // can undo it) and contributes to nothing else.
    if (e.undone) {
      row.undos += 1;
      continue;
    }
    if (e.type === 'play') row.plays += 1;
    else if (e.type === 'discard') row.discards += 1;
    else row.hints += 1;
  }

  const totalMoveMs = rows.reduce((sum, r) => sum + r.moveMs, 0);
  return {
    // Wall-clock length of the game, including any time after the last move.
    durationMs:
      typeof state.startedAt === 'number' && typeof state.endedAt === 'number'
        ? Math.max(0, state.endedAt - state.startedAt)
        : null,
    // The denominator for each row's share: time actually spent on moves.
    totalMoveMs,
    players: rows,
  };
}

// Sum per-game stats into one row per player name. Names are the only identity
// that survives across games (playerIds are per-room), so two people sharing a
// name share a row — the tailnet is a handful of friends, which is fine.
export function aggregateStats(games) {
  const byName = new Map();
  for (const g of games) {
    for (const p of g.players ?? []) {
      let row = byName.get(p.name);
      if (!row) {
        row = { name: p.name, isBot: p.isBot, games: 0, plays: 0, discards: 0, hints: 0, undos: 0, moves: 0, moveMs: 0 };
        byName.set(p.name, row);
      }
      // A name is a bot only if every game it appears in was played by a bot.
      row.isBot = row.isBot && p.isBot;
      row.games += 1;
      row.plays += p.plays;
      row.discards += p.discards;
      row.hints += p.hints;
      row.undos += p.undos;
      row.moves += p.moves;
      row.moveMs += p.moveMs;
    }
  }
  const players = [...byName.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
  return {
    games: games.length,
    totalMoveMs: players.reduce((sum, r) => sum + r.moveMs, 0),
    players,
  };
}
