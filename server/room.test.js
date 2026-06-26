import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GameError } from './rules.js';
import {
  applyAction,
  createRoom,
  joinRoom,
  leaveRoom,
  renamePlayer,
  resumeRoom,
  returnToLobby,
  startGame,
  undoLast,
  viewFor,
  voteAbandon,
} from './room.js';

async function withTmpSaveDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanabi-saves-'));
  const prev = process.env.HANABI_SAVED_DIR;
  process.env.HANABI_SAVED_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HANABI_SAVED_DIR;
    else process.env.HANABI_SAVED_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function setupRoom() {
  const room = createRoom();
  const alice = joinRoom(room, { name: 'Alice' });
  const bob = joinRoom(room, { name: 'Bob' });
  await startGame(room, alice.id, { seed: 12345 });
  return { room, alice, bob };
}

test('abandon: single vote does not abandon the game', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    const result = await voteAbandon(room, alice.id);
    assert.equal(result.abandoned, false);
    assert.equal(room.phase, 'playing');
    assert.equal(room.abandonVotes.size, 1);
  });
});

test('abandon: two votes marks the game finished with reason=abandoned', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    const result = await voteAbandon(room, bob.id);
    assert.equal(result.abandoned, true);
    assert.equal(room.phase, 'playing', 'room stays in playing phase…');
    assert.equal(room.state.status, 'finished', '…but state is finished');
    assert.equal(room.state.endReason, 'abandoned');
    assert.ok(room.state.endedAt, 'endedAt is stamped');
    assert.equal(room.abandonVotes.size, 0);
    assert.equal(room.undoStack.length, 0);
  });
});

test('abandon: same player voting twice toggles their vote', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    await voteAbandon(room, alice.id);
    assert.equal(room.abandonVotes.size, 1);
    await voteAbandon(room, alice.id);
    assert.equal(room.abandonVotes.size, 0);
    assert.equal(room.phase, 'playing');
  });
});

test('abandon: rejected outside a playing game', async () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  await assert.rejects(() => voteAbandon(room, a.id), GameError);
});

test('abandon: votes reset when a new game starts', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    assert.equal(room.abandonVotes.size, 1);
    await voteAbandon(room, bob.id);
    await startGame(room, alice.id, { seed: 99 });
    assert.equal(room.abandonVotes.size, 0);
  });
});

test('viewFor exposes abandonVotes count and self-vote flag', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    const aliceView = viewFor(room, alice.id);
    assert.equal(aliceView.abandonVotes.count, 1);
    assert.equal(aliceView.abandonVotes.threshold, 2);
    assert.equal(aliceView.abandonVotes.me, true);
    const bobView = viewFor(room, bob.id);
    assert.equal(bobView.abandonVotes.me, false);
  });
});

test('join: a second connection sharing an id reuses the same seat (duplicate tab)', () => {
  const room = createRoom();
  const first = joinRoom(room, { name: 'Alice' });
  const second = joinRoom(room, { name: 'Alice', playerId: first.id });
  assert.equal(second.id, first.id, 'duplicate tab takes the same seat');
  assert.equal(room.players.length, 1);
  assert.equal(room.hostId, first.id);
});

test('join: name-based recovery reclaims an offline seat mid-game', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, alice.id, { seed: 1 });
    leaveRoom(room, alice.id);
    assert.equal(alice.online, false);
    const recovered = joinRoom(room, { name: 'Alice' });
    assert.equal(recovered.id, alice.id, 'same seat returned');
    assert.equal(recovered.online, true);
    assert.equal(room.players.length, 2);
  });
});

test('join: name-based recovery is case-insensitive and trims whitespace', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, alice.id, { seed: 1 });
    leaveRoom(room, alice.id);
    const recovered = joinRoom(room, { name: '  alice ' });
    assert.equal(recovered.id, alice.id);
    assert.equal(recovered.name, '  alice ', 'name is updated to what the user typed');
  });
});

test('rename: updates the player name without changing the seat', async () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  await renamePlayer(room, a.id, '  Alicia ');
  assert.equal(a.name, 'Alicia');
  assert.equal(room.players.length, 1);
});

test('rename: rejects empty or whitespace-only names', async () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'Alice' });
  await assert.rejects(() => renamePlayer(room, a.id, ''), GameError);
  await assert.rejects(() => renamePlayer(room, a.id, '   '), GameError);
  await assert.rejects(() => renamePlayer(room, a.id, null), GameError);
});

test('rename: rejects unknown player', async () => {
  const room = createRoom();
  await assert.rejects(() => renamePlayer(room, 'nobody', 'Anyone'), GameError);
});

test('rename: updates the in-game name when a game is in progress', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const a = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, a.id, { seed: 1 });
    await renamePlayer(room, a.id, 'Alicia');
    assert.equal(a.name, 'Alicia');
    const inGame = room.state.players.find((p) => p.id === a.id);
    assert.equal(inGame.name, 'Alicia');
  });
});

test('join: name-based recovery does not steal an online seat', async () => {
  await withTmpSaveDir(async () => {
    const room = createRoom();
    const alice = joinRoom(room, { name: 'Alice' });
    joinRoom(room, { name: 'Bob' });
    await startGame(room, alice.id, { seed: 1 });
    assert.throws(() => joinRoom(room, { name: 'Alice' }), GameError);
    assert.equal(room.players.length, 2);
  });
});

test('join: same id without an active conflict restores the seat (reconnect)', () => {
  const room = createRoom();
  const first = joinRoom(room, { name: 'Alice' });
  const reconnected = joinRoom(room, { name: 'Alice', playerId: first.id });
  assert.equal(reconnected.id, first.id);
  assert.equal(room.players.length, 1);
});

test('join: ids are non-sequential random tokens', () => {
  const room = createRoom();
  const a = joinRoom(room, { name: 'A' });
  const b = joinRoom(room, { name: 'B' });
  assert.notEqual(a.id, 'p1');
  assert.notEqual(b.id, 'p2');
  assert.ok(a.id.length >= 6);
});

test('undo: play/discard/hint push snapshots; annotate does not', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    assert.equal(room.undoStack.length, 1);
    await applyAction(room, bob.id, { type: 'annotate', cardId: room.state.players[1].hand[0].id, note: 'hmm' });
    assert.equal(room.undoStack.length, 1);
  });
});

test('undo: only the player who took the last action can undo it', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    await assert.rejects(() => undoLast(room, bob.id), GameError);
    await undoLast(room, alice.id);
    assert.equal(room.state.currentPlayer, 0, 'turn restored to alice');
    assert.equal(room.undoStack.length, 0);
  });
});

test('undo: sequential undos walk back across players', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    await applyAction(room, bob.id, { type: 'discard', cardIndex: 0 });
    assert.equal(room.undoStack.length, 2);
    await undoLast(room, bob.id);
    assert.equal(room.state.currentPlayer, 1, 'bob is current again');
    await undoLast(room, alice.id);
    assert.equal(room.state.currentPlayer, 0, 'alice is current again');
    assert.equal(room.undoStack.length, 0);
  });
});

test('undo: starting a new game clears the undo stack', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    room.state.status = 'finished';
    await startGame(room, alice.id, { seed: 7 });
    assert.equal(room.undoStack.length, 0);
  });
});

test('undo: viewFor exposes canUndo only to the player at the top of the stack', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    assert.equal(viewFor(room, alice.id).canUndo, true);
    assert.equal(viewFor(room, bob.id).canUndo, false);
  });
});

test('undo: failed action does not leave a stale snapshot behind', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 8;
    await assert.rejects(applyAction(room, alice.id, { type: 'discard', cardIndex: 0 }));
    assert.equal(room.undoStack.length, 0);
  });
});

test('returnToLobby: host can drop back to lobby after a finished game', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    assert.equal(room.state.status, 'finished');
    returnToLobby(room, alice.id);
    assert.equal(room.phase, 'lobby');
    assert.equal(room.state, null);
    assert.equal(room.savePath, null);
    assert.equal(room.undoStack.length, 0);
    assert.equal(room.players.length, 2, 'players stay in the room');
  });
});

test('returnToLobby: non-host cannot trigger', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    assert.throws(() => returnToLobby(room, bob.id), GameError);
    assert.equal(room.phase, 'playing');
  });
});

test('returnToLobby: refused while the game is still in progress', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    assert.throws(() => returnToLobby(room, alice.id), GameError);
  });
});

test('startGame stores the seed and lets it propagate to view when finished', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    assert.equal(room.state.seed, 12345);
    room.state.status = 'finished';
    const v = viewFor(room, alice.id);
    assert.equal(v.seed, 12345);
  });
});

test('save: starting a game creates a JSONL file with a header line', async () => {
  await withTmpSaveDir(async (dir) => {
    const { room } = await setupRoom();
    assert.ok(room.savePath, 'savePath set');
    assert.ok(room.savePath.startsWith(dir), 'save lives under tmp dir');
    const raw = await fs.readFile(room.savePath, 'utf8');
    const [headerLine] = raw.split('\n');
    const header = JSON.parse(headerLine);
    assert.equal(header.kind, 'start');
    assert.equal(header.seed, 12345);
    assert.equal(header.variantId, 'simple');
    assert.equal(header.hostId, room.hostId);
    assert.deepEqual(
      header.players.map((p) => p.name),
      ['Alice', 'Bob'],
    );
  });
});

test('save: each action appends an event line', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice } = await setupRoom();
    room.state.hintTokens = 4;
    await applyAction(room, alice.id, { type: 'discard', cardIndex: 0 });
    const raw = await fs.readFile(room.savePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'header + 1 action');
    const ev = JSON.parse(lines[1]);
    assert.equal(ev.kind, 'action');
    assert.equal(ev.playerId, alice.id);
    assert.equal(ev.action.type, 'discard');
  });
});

test('resume: a partially-played game can be reconstructed from its save', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    const aliceN = room.state.players[0].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'hint', toPlayerIndex: 0, hintType: 'number', value: aliceN });
    await renamePlayer(room, alice.id, 'Alicia');
    const bobN2 = room.state.players[1].hand[1].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN2 });

    const savePath = room.savePath;
    const liveTurn = room.state.turn;
    const liveScore = Object.values(room.state.playedPiles).reduce((s, p) => s + p.length, 0);
    const liveHints = room.state.hintTokens;

    const resumed = await resumeRoom(savePath);
    assert.equal(resumed.phase, 'playing');
    assert.equal(resumed.hostId, alice.id);
    assert.equal(resumed.state.turn, liveTurn);
    assert.equal(resumed.state.hintTokens, liveHints);
    assert.deepEqual(
      resumed.state.players.map((p) => p.name),
      ['Alicia', 'Bob'],
      'rename event replayed',
    );
    const resumedScore = Object.values(resumed.state.playedPiles).reduce((s, p) => s + p.length, 0);
    assert.equal(resumedScore, liveScore);
    assert.equal(resumed.undoStack.length, 3, 'undo snapshots reconstructed');
    assert.ok(resumed.players.every((p) => p.online === false));
  });
});

test('resume: undo events in the save are honored on replay', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    const bobN = room.state.players[1].hand[0].number;
    const aliceN = room.state.players[0].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });
    await applyAction(room, bob.id, { type: 'hint', toPlayerIndex: 0, hintType: 'number', value: aliceN });
    await undoLast(room, bob.id);
    const liveTurn = room.state.turn;
    const liveCurrent = room.state.currentPlayer;

    const resumed = await resumeRoom(room.savePath);
    assert.equal(resumed.state.turn, liveTurn);
    assert.equal(resumed.state.currentPlayer, liveCurrent);
    assert.equal(resumed.undoStack.length, 1, 'one snapshot remains after undo replay');
  });
});

test('resume: continuation after a natural game-end (e.g. undo the final fuse) is persisted', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    // With seed 12345 + 2 players, three misplays of card 0 walk fuses 3→0.
    await applyAction(room, alice.id, { type: 'play', cardIndex: 0 });
    await applyAction(room, bob.id, { type: 'play', cardIndex: 0 });
    await applyAction(room, alice.id, { type: 'play', cardIndex: 0 });
    assert.equal(room.state.status, 'finished');
    assert.equal(room.state.endReason, 'fuses');
    assert.ok(room.savePath, 'savePath retained after natural end so undo can continue');

    await undoLast(room, alice.id);
    assert.equal(room.state.status, 'playing');

    // Alice hints instead of misplaying. Persisted past the prior 'end' line.
    const bobN = room.state.players[1].hand[0].number;
    await applyAction(room, alice.id, { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: bobN });

    const raw = await fs.readFile(room.savePath, 'utf8');
    const kinds = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);
    assert.deepEqual(
      kinds,
      ['start', 'action', 'action', 'action', 'end', 'undo', 'action'],
      'file has events after the end marker',
    );

    const liveTurn = room.state.turn;
    const liveFuses = room.state.fuseTokens;
    const resumed = await resumeRoom(room.savePath);
    assert.equal(resumed.state.status, 'playing');
    assert.equal(resumed.state.turn, liveTurn);
    assert.equal(resumed.state.fuseTokens, liveFuses);
  });
});

test('resume: refuses a save that has already ended', async () => {
  await withTmpSaveDir(async () => {
    const { room, alice, bob } = await setupRoom();
    await voteAbandon(room, alice.id);
    await voteAbandon(room, bob.id);
    const files = await fs.readdir(process.env.HANABI_SAVED_DIR);
    const filePath = path.join(process.env.HANABI_SAVED_DIR, files[0]);
    await assert.rejects(() => resumeRoom(filePath), /already ended/);
  });
});
