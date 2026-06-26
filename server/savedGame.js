import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from './game.js';
import {
  annotateAction,
  discardAction,
  hintAction,
  playAction,
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

export async function openSave(state, hostId) {
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
    players: state.players.map((p) => ({ id: p.id, name: p.name })),
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

export async function loadSave(filePath) {
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
  });
  const undoStack = [];
  const abandonVotes = new Set();
  let endReason = null;
  const events = [];

  for (let i = 1; i < lines.length; i++) {
    const ev = parseLineSafe(lines[i]);
    if (!ev) {
      // Tolerate a truncated last line (crash mid-write). Stop replay.
      if (i === lines.length - 1) break;
      throw new Error(`Corrupt event line ${i + 1} in ${filePath}`);
    }
    events.push(ev);
    applyEvent(state, ev, { undoStack, abandonVotes, players: header.players });
    if (ev.kind === 'end') {
      endReason = ev.endReason ?? null;
      // Don't stop — a continuation (e.g. undo of the game-ending move) may
      // follow. Final resumability is determined by state.status after replay.
    }
  }

  return { header, state, undoStack, abandonVotes, events, endReason };
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
      break;
    }
    case 'undo': {
      const top = undoStack.pop();
      if (!top) throw new Error(`undo event with empty stack`);
      // Overwrite each property of state in place so the outer reference stays valid.
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, top.snapshot);
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
      }
      break;
    }
    case 'end':
      // Loader handles termination — nothing to apply.
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
