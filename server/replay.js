import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPLAY_DIR = path.resolve(__dirname, '..', 'replays');

export async function ensureReplayDir() {
  await fs.mkdir(REPLAY_DIR, { recursive: true });
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function writeReplay(state) {
  await ensureReplayDir();
  const filename = `${timestampSlug()}-${state.variantId}.json`;
  const payload = {
    variantId: state.variantId,
    endRule: state.endRule,
    shareAnnotations: state.shareAnnotations,
    players: state.players.map((p) => ({ id: p.id, name: p.name })),
    log: state.log,
    finalScore: Object.values(state.playedPiles).reduce((s, p) => s + p.length, 0),
    endReason: state.endReason,
    finishedAt: new Date().toISOString(),
  };
  const filePath = path.join(REPLAY_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
