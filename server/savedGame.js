import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState, maxPossibleScore, score } from './game.js';
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
    if (ev.kind === 'end') {
      endReason = ev.endReason ?? null;
      // Don't stop — a continuation (e.g. undo of the game-ending move) may
      // follow. Final resumability is determined by state.status after replay.
    }
  }

  return { header, state, undoStack, abandonVotes, events, endReason, totalEvents };
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

async function summarizeForLibrary(filePath) {
  const basename = path.basename(filePath);
  try {
    const { header, state, events, totalEvents } = await loadSave(filePath);
    const finished = state.status === 'finished';
    return {
      basename,
      startedAt: header.startedAt,
      variantId: header.variantId,
      playerNames: header.players.map((p) => p.name),
      moves: events.filter((e) => e.kind === 'action').length,
      totalEvents,
      status: finished ? (state.endReason || 'finished') : 'in-progress',
      score: score(state),
      maxScore: maxPossibleScore(state),
      // The seed reveals the deck order, so only expose it once finished.
      seed: finished ? state.seed : null,
    };
  } catch (err) {
    return { basename, status: 'unreadable', error: err.message };
  }
}

export async function listLibrary() {
  const names = await listSaves(); // already newest-first (timestamp prefix)
  const tags = await readAllTags();
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
    out.push({ ...cached.entry, tags: tags[name] || [] });
  }
  return out;
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
