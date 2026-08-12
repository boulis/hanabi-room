import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInitialState, deckExportPayload, maxPossibleScore, score } from './game.js';
import { BOT_SCORE_VERSION, botScoreForSaveHeader } from './botScore.js';
import { gameStats } from './stats.js';
import {
  annotateAction,
  discardAction,
  hintAction,
  playAction,
  undoneLogEntries,
} from './rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAVED_DIR = path.resolve(__dirname, '..', 'saved-games');

export function savedDir() {
  return process.env.HANABI_SAVED_DIR || DEFAULT_SAVED_DIR;
}

const UNDOABLE_ACTIONS = new Set(['play', 'discard', 'hint']);
const ABANDON_THRESHOLD = 2;

export async function ensureSavedDir() {
  await fs.mkdir(savedDir(), { recursive: true });
}

function timestampSlug(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

export async function openSave(state, hostId, botIds = new Set()) {
  await ensureSavedDir();
  const filename = `${timestampSlug()}-${state.variantId}.jsonl`;
  const filePath = path.join(savedDir(), filename);
  const header = {
    kind: 'start',
    startedAt: new Date().toISOString(),
    seed: state.seed,
    variantId: state.variantId,
    endRule: state.endRule,
    shareGuarded: state.shareGuarded,
    allowEmptyHints: state.allowEmptyHints,
    hostId,
    // isBot marks seats a resume/branch should re-staff with server bots.
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      ...(botIds.has(p.id) ? { isBot: true } : {}),
    })),
    deck: state.initialDeckCards,
  };
  await fs.writeFile(filePath, JSON.stringify(header) + '\n');
  return filePath;
}

export async function appendEvent(filePath, event) {
  if (!filePath) return;
  const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n';
  await fs.appendFile(filePath, line);
}

export async function closeSave(filePath, endReason) {
  await appendEvent(filePath, { kind: 'end', endReason });
}

async function readLines(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0);
}

function parseLineSafe(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// maxEvents caps how many events are applied (for replay stepping); the
// returned totalEvents always counts every parseable event in the file.
export async function loadSave(filePath, { maxEvents = Infinity } = {}) {
  const lines = await readLines(filePath);
  if (lines.length === 0) throw new Error(`Empty save file: ${filePath}`);
  const header = JSON.parse(lines[0]);
  if (header.kind !== 'start') {
    throw new Error(`First line of ${filePath} is not a 'start' record`);
  }
  const state = createInitialState({
    variantId: header.variantId,
    endRule: header.endRule,
    shareGuarded: header.shareGuarded,
    allowEmptyHints: header.allowEmptyHints,
    players: header.players,
    seed: header.seed,
    // header.deck is the explicit draw order (added in 0.9.0 for imports);
    // older saves lack it and fall back to seed-shuffle inside createInitialState.
    deckCards: header.deck,
  });
  // createInitialState stamps startedAt = Date.now(); replace with the real
  // start time from the save header so export durations stay accurate after
  // a resume.
  if (header.startedAt) {
    const parsed = Date.parse(header.startedAt);
    if (!Number.isNaN(parsed)) state.startedAt = parsed;
  }
  const undoStack = [];
  const abandonVotes = new Set();
  let endReason = null;
  const events = [];
  let totalEvents = 0;
  // Wall-clock time of the newest event actually applied — replay uses it to
  // show elapsed game time rather than time since the original start until now.
  let lastAppliedAt = null;

  for (let i = 1; i < lines.length; i++) {
    const ev = parseLineSafe(lines[i]);
    if (!ev) {
      // Tolerate a truncated last line (crash mid-write). Stop replay.
      if (i === lines.length - 1) break;
      throw new Error(`Corrupt event line ${i + 1} in ${filePath}`);
    }
    totalEvents++;
    if (events.length >= maxEvents) continue; // still counting, no longer applying
    events.push(ev);
    applyEvent(state, ev, { undoStack, abandonVotes, players: header.players });
    if (ev.t) {
      const parsedAt = Date.parse(ev.t);
      if (!Number.isNaN(parsedAt)) lastAppliedAt = parsedAt;
    }
    if (ev.kind === 'end') {
      endReason = ev.endReason ?? null;
      // Don't stop — a continuation (e.g. undo of the game-ending move) may
      // follow. Final resumability is determined by state.status after replay.
    }
  }

  return { header, state, undoStack, abandonVotes, events, endReason, totalEvents, lastAppliedAt };
}

function applyEvent(state, ev, ctx) {
  const { undoStack, abandonVotes } = ctx;
  switch (ev.kind) {
    case 'action': {
      const idx = state.players.findIndex((p) => p.id === ev.playerId);
      if (idx < 0) throw new Error(`Unknown playerId ${ev.playerId} in action`);
      if (UNDOABLE_ACTIONS.has(ev.action.type)) {
        undoStack.push({ playerId: ev.playerId, snapshot: structuredClone(state) });
      }
      const logLenBefore = state.log.length;
      switch (ev.action.type) {
        case 'play':
          playAction(state, idx, ev.action.cardIndex);
          break;
        case 'discard':
          discardAction(state, idx, ev.action.cardIndex);
          break;
        case 'hint':
          hintAction(
            state,
            idx,
            ev.action.toPlayerIndex,
            ev.action.hintType,
            ev.action.value,
          );
          break;
        case 'annotate':
          annotateAction(state, idx, ev.action.cardId, {
            guarded: ev.action.guarded,
            note: ev.action.note,
          });
          break;
        default:
          throw new Error(`Unknown action type during replay: ${ev.action.type}`);
      }
      // Stamp any recorded reasoning on the action's own log entry (the
      // first one it appended) so replay and finished-game review show it.
      if (typeof ev.reasoning === 'string' && state.log.length > logLenBefore) {
        state.log[logLenBefore].reasoning = ev.reasoning;
      }
      // pushLog stamped `at` with the replay's own clock; replace it with when
      // the move was actually made, so stats are about the original game.
      if (ev.t) {
        const parsedAt = Date.parse(ev.t);
        if (!Number.isNaN(parsedAt)) {
          for (let j = logLenBefore; j < state.log.length; j++) state.log[j].at = parsedAt;
        }
      }
      break;
    }
    case 'undo': {
      const top = undoStack.pop();
      if (!top) throw new Error(`undo event with empty stack`);
      // Same as the live undo path: keep the undone action's log entries,
      // struck out, so a resumed game shows the identical log.
      const struck = undoneLogEntries(state.log, top.snapshot.log);
      // Keep nextLogSeq monotonic across the whole replay — see the matching
      // comment in room.js's undoLast for why restoring the snapshot's value
      // wholesale would let the next action reuse a struck entry's seq.
      const nextLogSeq = Math.max(state.nextLogSeq, top.snapshot.nextLogSeq);
      // Overwrite each property of state in place so the outer reference stays valid.
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, top.snapshot);
      state.nextLogSeq = nextLogSeq;
      state.log.push(...struck);
      break;
    }
    case 'rename': {
      const p = state.players.find((sp) => sp.id === ev.playerId);
      if (p) p.name = ev.name;
      break;
    }
    case 'abandon-vote': {
      if (abandonVotes.has(ev.playerId)) abandonVotes.delete(ev.playerId);
      else abandonVotes.add(ev.playerId);
      if (abandonVotes.size >= ABANDON_THRESHOLD) {
        state.status = 'finished';
        state.endReason = 'abandoned';
        if (ev.t) {
          const parsed = Date.parse(ev.t);
          if (!Number.isNaN(parsed)) state.endedAt = parsed;
        }
      }
      break;
    }
    case 'end':
      // Replace the replay-time endedAt with the original event time, so
      // export durations are honest after a resume.
      if (ev.t) {
        const parsed = Date.parse(ev.t);
        if (!Number.isNaN(parsed)) state.endedAt = parsed;
      }
      break;
    default:
      throw new Error(`Unknown event kind during replay: ${ev.kind}`);
  }
}

export async function listSaves() {
  try {
    const names = await fs.readdir(savedDir());
    return names.filter((n) => n.endsWith('.jsonl')).sort().reverse();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Deck order of a saved game, for the export button on a replay's game-over
// banner. Only for a save that ends finished: an unfinished one still has a
// draw pile, and its order is exactly what the live view hides. A save that was
// finished and then continued past its `end` line (an undo after game over)
// reconstructs as playing, so it is refused too — same rule the live room
// applies to itself.
export async function deckExportFromSave(filePath) {
  const { state } = await loadSave(filePath);
  if (state.status !== 'finished') return null;
  return deckExportPayload(state);
}

export async function summarizeSave(filePath) {
  const lines = await readLines(filePath);
  if (lines.length === 0) return null;
  const header = parseLineSafe(lines[0]);
  if (!header || header.kind !== 'start') return null;
  let lastEvent = null;
  let moves = 0;
  for (let i = 1; i < lines.length; i++) {
    const ev = parseLineSafe(lines[i]);
    if (!ev) continue;
    lastEvent = ev;
    if (ev.kind === 'action') moves += 1;
  }
  // A save is complete only if the LAST event is an end marker — a
  // continuation past game-over (e.g. undo of the final misplay) leaves
  // non-end events after the 'end' line.
  const complete = lastEvent?.kind === 'end';
  return {
    filePath,
    basename: path.basename(filePath),
    startedAt: header.startedAt,
    variantId: header.variantId,
    seed: header.seed,
    playerNames: header.players.map((p) => p.name),
    playerBots: header.players.map((p) => !!p.isBot),
    moves,
    complete,
    lastEventAt: lastEvent?.t ?? header.startedAt,
  };
}

function assertSaveBasename(basename) {
  if (
    !basename ||
    basename !== path.basename(basename) ||
    basename.startsWith('.') ||
    !basename.endsWith('.jsonl')
  ) {
    throw new Error(`Bad save filename: ${basename}`);
  }
}

// Soft-delete: move the file into saved-games/trash/ instead of unlinking,
// so a stray click can be undone by the host from the terminal. The trash
// subdirectory is invisible to listSaves (readdir entries ending in .jsonl).
export async function deleteSave(basename) {
  assertSaveBasename(basename);
  const trashDir = path.join(savedDir(), 'trash');
  await fs.mkdir(trashDir, { recursive: true });
  const dest = path.join(trashDir, basename);
  await fs.rename(path.join(savedDir(), basename), dest);
  await setSaveTags(basename, []); // drop its tags entry
  await setBotScore(basename, null); // …and its bot par
  return dest;
}

// --- Tags: sidecar JSON, so the .jsonl save format stays pure replay data.

function tagsPath() {
  return path.join(savedDir(), 'tags.json');
}

export async function readAllTags() {
  try {
    return JSON.parse(await fs.readFile(tagsPath(), 'utf8'));
  } catch {
    return {};
  }
}

export async function setSaveTags(basename, tags) {
  assertSaveBasename(basename);
  const all = await readAllTags();
  const clean = [...new Set(
    (Array.isArray(tags) ? tags : [])
      .map((t) => String(t).trim().slice(0, 24))
      .filter(Boolean),
  )].slice(0, 8);
  if (clean.length === 0) delete all[basename];
  else all[basename] = clean;
  await ensureSavedDir();
  await fs.writeFile(tagsPath(), JSON.stringify(all, null, 2));
  return clean;
}

// --- Bot par scores: sidecar JSON, same reasoning as tags — the .jsonl stays
// pure replay data, and a derived number that a brain version bump invalidates
// has no business inside it.
//
// Keyed by basename, value is simulateBotGame's result plus `computedAt`. The
// deck a game was dealt from never changes, so an entry only goes stale when
// BOT_SCORE_VERSION moves.

function botScoresPath() {
  return path.join(savedDir(), 'bot-scores.json');
}

export async function readAllBotScores() {
  try {
    return JSON.parse(await fs.readFile(botScoresPath(), 'utf8'));
  } catch {
    return {};
  }
}

// Read-modify-write, serialized: the backfill pass and a room finishing a game
// can land on the same file, and each holds only its own entry.
let botScoreWrites = Promise.resolve();

export function setBotScore(basename, entry) {
  assertSaveBasename(basename);
  const run = async () => {
    const all = await readAllBotScores();
    if (entry) all[basename] = entry;
    else delete all[basename];
    await ensureSavedDir();
    await fs.writeFile(botScoresPath(), JSON.stringify(all, null, 2));
    return entry;
  };
  botScoreWrites = botScoreWrites.then(run, run);
  return botScoreWrites;
}

function botScoreIsCurrent(entry) {
  return !!entry && entry.version === BOT_SCORE_VERSION;
}

// The stored par for one save, simulating it first if there is none or the
// brain has moved on since. `known` lets a caller that already read the whole
// sidecar (the backfill loop) skip re-reading it per file.
export async function botScoreFor(basename, { known } = {}) {
  assertSaveBasename(basename);
  const all = known ?? (await readAllBotScores());
  const existing = all[basename];
  if (botScoreIsCurrent(existing)) return existing;
  let header;
  try {
    const lines = await readLines(path.join(savedDir(), basename));
    header = parseLineSafe(lines[0] ?? '');
    if (!header || header.kind !== 'start') return null;
  } catch {
    return null;
  }
  let entry;
  try {
    entry = { ...botScoreForSaveHeader(header), computedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`bot par for ${basename} failed: ${err.message}`);
    return null;
  }
  // A par that can't be written is still a par — serve it and move on.
  try {
    await setBotScore(basename, entry);
  } catch (err) {
    console.error(`Could not store bot par for ${basename}: ${err.message}`);
  }
  if (known) known[basename] = entry;
  return entry;
}

// Fill in every missing or stale par. Cheap enough to run on a background tick
// at boot (a game is ~25ms), and exposed as `npm run bot-scores` for a one-off
// pass over a library that has never been scored.
export async function backfillBotScores({ onProgress } = {}) {
  const names = await listSaves();
  const known = await readAllBotScores();
  let computed = 0;
  for (const basename of names) {
    if (botScoreIsCurrent(known[basename])) continue;
    const entry = await botScoreFor(basename, { known });
    if (entry) computed++;
    onProgress?.({ basename, entry, computed, total: names.length });
  }
  return { total: names.length, computed };
}

// --- Branching: copy the header plus the first `uptoEvents` events into a
// fresh save file. The copy is a complete, self-contained save, so the
// existing resume path can open it; the original file is never touched.
export async function branchSave(basename, uptoEvents) {
  assertSaveBasename(basename);
  const lines = await readLines(path.join(savedDir(), basename));
  if (lines.length === 0) throw new Error(`Empty save file: ${basename}`);
  const upto = Math.max(0, Math.floor(uptoEvents));
  const kept = [lines[0], ...lines.slice(1, 1 + upto)];
  const header = parseLineSafe(lines[0]);
  const variant = header?.variantId ?? 'unknown';
  const filename = `${timestampSlug()}-branch-${variant}.jsonl`;
  const filePath = path.join(savedDir(), filename);
  await ensureSavedDir();
  await fs.writeFile(filePath, kept.join('\n') + '\n');
  return filePath;
}

// --- Library: every save summarized for the server-lobby listing. Entries
// are cached by mtime — summaries replay the whole file to get the score,
// and the lobby broadcasts after every action.

const libraryCache = new Map(); // filePath -> { mtimeMs, entry }

function deckKeyOf(drawOrder) {
  if (!Array.isArray(drawOrder) || drawOrder.length === 0) return null;
  return createHash('sha1').update(drawOrder.join(',')).digest('hex');
}

async function summarizeForLibrary(filePath) {
  const basename = path.basename(filePath);
  try {
    const { header, state, events, totalEvents } = await loadSave(filePath);
    const finished = state.status === 'finished';
    return {
      basename,
      startedAt: header.startedAt,
      endedAt: state.endedAt,
      variantId: header.variantId,
      endRule: header.endRule,
      shareGuarded: !!header.shareGuarded,
      allowEmptyHints: !!header.allowEmptyHints,
      playerNames: header.players.map((p) => p.name),
      playerBots: header.players.map((p) => !!p.isBot),
      playerCount: header.players.length,
      moves: events.filter((e) => e.kind === 'action').length,
      totalEvents,
      status: finished ? (state.endReason || 'finished') : 'in-progress',
      score: score(state),
      maxScore: maxPossibleScore(state),
      misplays: 3 - state.fuseTokens,
      // The seed reveals the deck order, so only expose it once finished.
      seed: finished ? state.seed : null,
      // What groups saves dealt from the same cards (see gameDetail). Not the
      // seed: the same seed shuffles a different deck in a different variant,
      // while an imported deck order reproduces a deck under a new seed. The
      // draw order itself is the identity — hashed because it's private, and
      // `publicEntry` strips it on the way out regardless.
      deckKey: deckKeyOf(state.initialDeckCards),
      // Per-player counts and timings. Stripped from the lobby listing (which
      // is broadcast after every action) and served only to the stats page.
      stats: gameStats(state, { botFlags: header.players.map((p) => !!p.isBot) }),
    };
  } catch (err) {
    return { basename, status: 'unreadable', error: err.message };
  }
}

// Scans never run concurrently. A cold scan replays every save through the
// rules engine — seconds over a library of hundreds — and the cache only fills
// as each file finishes, so two scans started together find the same empty
// cache and do the same work twice. Serializing through one chain (the same
// way bot-score writes are) means the first scan pays the cost and everyone
// queued behind it comes back warm in milliseconds. Each caller still gets its
// OWN scan rather than sharing the in-flight one, so a lobby broadcast that
// lands mid-scan reports the file as it is when its turn comes, not as it was
// when someone else's scan started.
let libraryScanChain = Promise.resolve();

function cachedLibraryEntries() {
  const run = libraryScanChain.then(scanLibrary, scanLibrary);
  libraryScanChain = run.then(() => {}, () => {});
  return run;
}

async function scanLibrary() {
  const names = await listSaves(); // already newest-first (timestamp prefix)
  const out = [];
  for (const name of names) {
    const filePath = path.join(savedDir(), name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    let cached = libraryCache.get(filePath);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      cached = { mtimeMs: stat.mtimeMs, entry: await summarizeForLibrary(filePath) };
      libraryCache.set(filePath, cached);
    }
    out.push(cached.entry);
  }
  return out;
}

// What a cached entry may be sent as: the per-player stats block stays behind
// (the lobby view rides on every broadcast, and the stats page asks for it
// separately), and so does the always-present seed.
function publicEntry({ stats, deckKey, ...rest }) {
  return rest;
}

export async function listLibrary() {
  const tags = await readAllTags();
  const pars = await readAllBotScores();
  return (await cachedLibraryEntries()).map(publicEntry).map((rest) => ({
    ...rest,
    tags: tags[rest.basename] || [],
    // Par is derived from the deck, so it's known from move 0 — but it's
    // withheld while the game is unfinished for the same reason the seed is:
    // both say something about a deck that is still being played.
    botScore: rest.status !== 'in-progress' ? pars[rest.basename] ?? null : null,
  }));
}

// Every readable save's per-player stats, with just enough metadata to filter
// on (game size, variant, status). Shares the library's mtime cache.
export async function listGameStats() {
  const tags = await readAllTags();
  return (await cachedLibraryEntries())
    .filter((e) => e.stats)
    .map((e) => ({
      basename: e.basename,
      tags: tags[e.basename] || [],
      startedAt: e.startedAt,
      variantId: e.variantId,
      playerCount: e.playerCount,
      status: e.status,
      score: e.score,
      maxScore: e.maxScore,
      stats: e.stats,
    }));
}

// Everything the game-info page shows for one save: the library row, the
// per-player stats table (the same one the game-over banner draws), the bot
// par, and the other games dealt from the same deck.
//
// Seed, par and the sibling list are all withheld for a game that hasn't
// finished — and the sibling list only ever relates *finished* games, because
// "this in-progress game shares a seed with that finished one" would hand over
// a deck you can already read off the finished game's replay.
export async function gameDetail(basename) {
  assertSaveBasename(basename);
  const entries = await cachedLibraryEntries();
  const entry = entries.find((e) => e.basename === basename);
  if (!entry || entry.status === 'unreadable') return null;
  const finished = entry.status !== 'in-progress';
  const tags = await readAllTags();
  const pars = await readAllBotScores();
  const sameDeck = !finished ? [] : entries
    .filter((e) => (
      e.basename !== basename &&
      e.status !== 'unreadable' &&
      e.status !== 'in-progress' &&
      e.deckKey != null &&
      e.deckKey === entry.deckKey
    ))
    .map((e) => ({
      basename: e.basename,
      startedAt: e.startedAt,
      variantId: e.variantId,
      status: e.status,
      score: e.score,
      maxScore: e.maxScore,
      playerNames: e.playerNames,
      playerBots: e.playerBots,
      tags: tags[e.basename] || [],
      botScore: pars[e.basename] ?? null,
    }));
  return {
    ...publicEntry(entry),
    tags: tags[basename] || [],
    stats: entry.stats,
    // Computed here if the background pass hasn't reached this save yet.
    botScore: finished ? await botScoreFor(basename, { known: pars }) : null,
    sameDeck,
  };
}

export async function listIncompleteSaves(limit = Infinity) {
  const names = await listSaves();
  const out = [];
  for (const name of names) {
    const filePath = path.join(savedDir(), name);
    let summary;
    try {
      summary = await summarizeSave(filePath);
    } catch {
      continue;
    }
    if (!summary || summary.complete) continue;
    out.push(summary);
    if (out.length >= limit) break;
  }
  return out;
}
