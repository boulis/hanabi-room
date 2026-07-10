const statusEl = document.getElementById('status');
const joinScreen = document.getElementById('join-screen');
const serverLobbyScreen = document.getElementById('server-lobby-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');

const PLAYER_KEY = 'hanabi-room.playerId';
const NAME_KEY = 'hanabi-room.name';
const ROOM_KEY = 'hanabi-room.roomId';
const ART_KEY = 'hanabi-room.useArt';
const VERBOSE_KEY = 'hanabi-room.verbose';
const TAP_KEY = 'hanabi-room.tap';
const SIZE_KEY = 'hanabi-room.size';
const SIZE_FACTORS = { S: 0.85, M: 1.0, L: 1.2, XL: 1.5 };
nameInput.value = localStorage.getItem(NAME_KEY) || '';
let useArt = localStorage.getItem(ART_KEY) === 'on';
let verbose = localStorage.getItem(VERBOSE_KEY) === 'on';
let tapMode = localStorage.getItem(TAP_KEY) === 'on';

function applySize(name) {
  if (!SIZE_FACTORS[name]) name = 'M';
  document.body.style.zoom = String(SIZE_FACTORS[name]);
  localStorage.setItem(SIZE_KEY, name);
  for (const b of document.querySelectorAll('#size-controls button')) {
    b.classList.toggle('active', b.dataset.size === name);
  }
}
for (const b of document.querySelectorAll('#size-controls button')) {
  b.addEventListener('click', () => applySize(b.dataset.size));
}
applySize(localStorage.getItem(SIZE_KEY) || 'M');

let ws = null;
let playerId = localStorage.getItem(PLAYER_KEY) || null;
let roomId = localStorage.getItem(ROOM_KEY) || null;
let view = null;

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    statusEl.textContent = 'connected';
    // If we remember a name + room, try to re-enter it. If the room is gone,
    // the server will error and we'll land in the server-lobby view.
    const savedName = nameInput.value.trim() || localStorage.getItem(NAME_KEY) || '';
    if (savedName && roomId) {
      send({ type: 'enterRoom', roomId, playerName: savedName, playerId });
    }
  });
  ws.addEventListener('close', () => {
    statusEl.textContent = 'disconnected — retrying…';
    setTimeout(connect, 1500);
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  });
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      populateVariants(msg.variants);
      break;
    case 'identity':
      playerId = msg.playerId;
      localStorage.setItem(PLAYER_KEY, playerId);
      if (msg.roomId) {
        roomId = msg.roomId;
        localStorage.setItem(ROOM_KEY, roomId);
      }
      // Fresh room, fresh animation baseline — a stale one (e.g. from replay
      // stepping before a branch) would silently swallow animations for
      // turns it thinks it has already shown.
      lastAnimatedActionTurn = null;
      break;
    case 'roomCreated':
      // Emitted when a save was resumed into a fresh room; auto-enter it.
      send({
        type: 'enterRoom',
        roomId: msg.roomId,
        playerName: nameInput.value.trim() || localStorage.getItem(NAME_KEY) || '',
        playerId,
      });
      break;
    case 'sync':
      if (replay) {
        if (msg.view.kind === 'server-lobby') {
          // Keep the lobby fresh behind the replay; don't disturb it.
          preReplayView = msg.view;
          break;
        }
        // An in-room sync means we joined a room (e.g. "Play from here") —
        // the live game takes over.
        closeReplay(false);
      }
      view = msg.view;
      render();
      break;
    case 'deckExport':
      triggerDownload(msg.data, msg.filename);
      break;
    case 'reaction':
      showReaction(msg.playerIndex, msg.emoji);
      break;
    case 'replayView':
      onReplayView(msg);
      break;
    case 'error':
      console.warn('server error:', msg.code, msg.error);
      flashError(msg.error);
      if (msg.code === 'no_room' && roomId) {
        // The room we thought we were in is gone; forget it so the lobby is
        // the natural landing spot.
        roomId = null;
        playerId = null;
        localStorage.removeItem(ROOM_KEY);
        localStorage.removeItem(PLAYER_KEY);
      }
      break;
  }
}

function flashError(text) {
  statusEl.textContent = `error: ${text}`;
  setTimeout(() => {
    statusEl.textContent = ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
  }, 2500);
}

function populateVariants(variants) {
  const sel = document.getElementById('opt-variant');
  sel.innerHTML = '';
  for (const v of variants) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    sel.append(opt);
  }
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  localStorage.setItem(NAME_KEY, name);
  // Nothing else to send — the server-lobby is already open. Render will
  // switch screens now that we have a name in storage.
  render();
});

document.getElementById('create-room-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = (localStorage.getItem(NAME_KEY) || nameInput.value.trim() || '').trim();
  if (!name) return;
  const roomName = document.getElementById('create-room-name').value.trim();
  send({ type: 'createRoom', roomName, playerName: name, playerId });
  document.getElementById('create-room-name').value = '';
});

document.getElementById('opt-variant').addEventListener('change', (e) => {
  send({ type: 'configure', options: { variantId: e.target.value } });
});
document.getElementById('opt-endRule').addEventListener('change', (e) => {
  send({ type: 'configure', options: { endRule: e.target.value } });
});
document.getElementById('opt-shareGuarded').addEventListener('change', (e) => {
  send({ type: 'configure', options: { shareGuarded: e.target.checked } });
});
document.getElementById('opt-allowEmptyHints').addEventListener('change', (e) => {
  send({ type: 'configure', options: { allowEmptyHints: e.target.checked } });
});
function readSeedInput() {
  const raw = document.getElementById('opt-seed').value.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n) >>> 0;
}

document.getElementById('start-button').addEventListener('click', () => {
  send({ type: 'start', seed: readSeedInput() });
});
document.getElementById('add-bot-button').addEventListener('click', () => {
  send({ type: 'addBot' });
});
document.getElementById('reaction-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-emoji]');
  if (btn) send({ type: 'react', emoji: btn.dataset.emoji });
});

// Reactions are ephemeral overlays over a player's row: shown briefly, then
// gone. Kept in a map so a re-render mid-lifetime re-attaches the bubble.
const REACTION_MS = 3000;
const activeReactions = new Map(); // playerIndex -> { emoji, until }

function showReaction(playerIndex, emoji) {
  activeReactions.set(playerIndex, { emoji, until: Date.now() + REACTION_MS });
  attachReactionBubble(playerIndex);
}

// --- Replay mode: step through a saved game on the game screen. The server
// rebuilds the state after `upto` events per request; we just render views.
let replay = null;        // { file, upto, total }
let preReplayView = null; // the server-lobby view to restore on close

function openReplay(file) {
  replay = { file, upto: 0, total: 0 };
  preReplayView = view;
  lastAnimatedActionTurn = null; // fresh baseline; steps animate like live play
  send({ type: 'replaySave', file, upto: 0 });
}

function onReplayView(msg) {
  if (!replay || replay.file !== msg.file) return; // stale response
  replay.upto = msg.upto;
  replay.total = msg.total;
  view = msg.view;
  render();
}

function closeReplay(restore = true) {
  if (!replay) return;
  replay = null;
  lastAnimatedActionTurn = null; // replay stepping must not suppress live animations
  document.getElementById('replay-bar').hidden = true;
  if (restore && preReplayView) {
    view = preReplayView;
    preReplayView = null;
    render();
  } else {
    preReplayView = null;
  }
}

function replayStep(upto) {
  if (!replay) return;
  const clamped = Math.max(0, Math.min(upto, replay.total));
  send({ type: 'replaySave', file: replay.file, upto: clamped });
}

document.getElementById('replay-first').addEventListener('click', () => replayStep(0));
document.getElementById('replay-prev').addEventListener('click', () => replayStep(replay ? replay.upto - 1 : 0));
document.getElementById('replay-next').addEventListener('click', () => replayStep(replay ? replay.upto + 1 : 0));
document.getElementById('replay-last').addEventListener('click', () => replayStep(replay ? replay.total : 0));
document.getElementById('replay-close').addEventListener('click', () => closeReplay());
document.getElementById('replay-branch').addEventListener('click', () => {
  if (!replay) return;
  if (!confirm(`Open a new room continuing this game from move ${replay.upto}?`)) return;
  send({ type: 'branchSave', file: replay.file, upto: replay.upto });
});

function renderReplayBar() {
  const bar = document.getElementById('replay-bar');
  bar.hidden = !replay;
  if (!replay) return;
  document.getElementById('replay-pos').textContent = `move ${replay.upto} / ${replay.total}`;
  document.getElementById('replay-first').disabled = replay.upto === 0;
  document.getElementById('replay-prev').disabled = replay.upto === 0;
  document.getElementById('replay-next').disabled = replay.upto >= replay.total;
  document.getElementById('replay-last').disabled = replay.upto >= replay.total;
  document.getElementById('replay-branch').disabled = view?.status !== 'playing';
}

function attachReactionBubble(playerIndex) {
  const row = document.querySelector(`#game-hands .player-row[data-seat="${playerIndex}"]`);
  if (!row) return;
  row.querySelector('.reaction-bubble')?.remove();
  const r = activeReactions.get(playerIndex);
  if (!r || Date.now() >= r.until) {
    activeReactions.delete(playerIndex);
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = 'reaction-bubble';
  bubble.textContent = r.emoji;
  // Keep the CSS animation length tied to REACTION_MS so a re-attached
  // bubble (mid-lifetime re-render) doesn't get cut off before it fades.
  bubble.style.animationDuration = `${REACTION_MS}ms`;
  row.append(bubble);
  setTimeout(() => bubble.remove(), r.until - Date.now());
}

document.getElementById('import-deck-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const deck = data?.cards;
    if (!Array.isArray(deck)) throw new Error('JSON has no "cards" array');
    send({ type: 'importDeck', deck });
  } catch (err) {
    flashError(`Import failed: ${err.message}`);
  } finally {
    // Allow re-picking the same file later.
    e.target.value = '';
  }
});
document.getElementById('abandon-button').addEventListener('click', () => {
  send({ type: 'abandon' });
});
document.getElementById('undo-button').addEventListener('click', () => {
  send({ type: 'undo' });
});
document.getElementById('request-undo-button').addEventListener('click', () => {
  send({ type: 'requestUndo' });
});

let lastAnimatedActionTurn = null;

function maybeAnimateAction(v) {
  const latest = latestActionEntry(v.log);
  if (!latest) {
    // No action yet (game just started or restarted). Re-baseline so the
    // first action in the new game does animate.
    lastAnimatedActionTurn = -1;
    return;
  }
  if (lastAnimatedActionTurn === null) {
    // First time we're seeing actions (fresh connect mid-game). Baseline
    // silently — don't replay history with animations.
    lastAnimatedActionTurn = latest.turn;
    return;
  }
  if (latest.turn <= lastAnimatedActionTurn) return;
  lastAnimatedActionTurn = latest.turn;
  // Defer one frame so the post-action DOM is in place before we measure.
  if (latest.type === 'hint') {
    requestAnimationFrame(() => animateHint(latest));
    return;
  }
  if (latest.type !== 'play' && latest.type !== 'discard') return;
  requestAnimationFrame(() => animateLeavingCard(v, latest));
}

// A hint flies as a large chip (colour disc or number) from the hinter's row
// to the receiver's — landing on the touched cards — then fades. Makes "who
// hinted whom" legible without reading the latest-action panel.
function animateHint(latest) {
  const rows = document.querySelectorAll('#game-hands .player-row');
  const from = rows[latest.fromIndex];
  const to = rows[latest.toIndex];
  if (!from || !to) return;
  const fr = from.getBoundingClientRect();
  const startX = fr.left + fr.width / 2;
  const startY = fr.top + fr.height / 2;

  // Land on the newest touched card (the one the conventions mark for play);
  // fall back to the row centre (e.g. an allowed empty hint touches nothing).
  const tr = to.getBoundingClientRect();
  let endX = tr.left + tr.width / 2;
  let endY = tr.top + tr.height / 2;
  const cards = to.querySelectorAll('.hand > *');
  const newest = Math.max(...(latest.touchedIndexes || [-1]));
  const target = newest >= 0 ? cards[newest] : null;
  if (target) {
    const r = target.getBoundingClientRect();
    endX = r.left + r.width / 2;
    endY = r.top + r.height / 2;
  }

  const SIZE = 56; // keep in sync with .hint-fly .latest-hint-chip CSS
  const fly = document.createElement('div');
  fly.className = 'hint-fly';
  fly.append(renderHintChip(latest.hintType, latest.value));
  fly.style.left = `${startX - SIZE / 2}px`;
  fly.style.top = `${startY - SIZE / 2}px`;
  fly.style.setProperty('--fly-x', `${endX - startX}px`);
  fly.style.setProperty('--fly-y', `${endY - startY}px`);
  document.body.append(fly);
  setTimeout(() => fly.remove(), 1600);

  // Pulse the receiver's row as the chip arrives.
  setTimeout(() => {
    to.classList.add('hint-received');
    setTimeout(() => to.classList.remove('hint-received'), 800);
  }, 800);
}

function animateLeavingCard(v, latest) {
  const rows = document.querySelectorAll('#game-hands .player-row');
  const row = rows[latest.playerIndex];
  if (!row) return;
  const hand = row.querySelector('.hand');
  if (!hand) return;
  const handRect = hand.getBoundingClientRect();
  // Card width and gap match the .card and .hand CSS.
  const cardWidth = 96;
  const gap = 8;
  const x = handRect.left + latest.cardIndex * (cardWidth + gap);
  const y = handRect.top;

  const ghost = document.createElement('div');
  ghost.dataset.color = latest.card.color;
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
  // A successful play flies to its pile; discards and misplays (which end up
  // in the discard pile) keep the float-up-and-fade animation.
  const pile = latest.type === 'play' && latest.success !== false
    ? document.querySelector(`#game-piles .pile[data-color="${latest.card.color}"]`)
    : null;
  if (pile) {
    ghost.className = 'card ghost-play';
    // Move the ghost's center onto the pile's center; the keyframes scale it
    // down to pile size (60/96) around that center so it lands flush.
    const pr = pile.getBoundingClientRect();
    ghost.style.setProperty('--fly-x', `${pr.left + pr.width / 2 - (x + cardWidth / 2)}px`);
    ghost.style.setProperty('--fly-y', `${pr.top + pr.height / 2 - (y + 72)}px`);
  } else {
    ghost.className = 'card ghost-leave';
    if (latest.type === 'play' && latest.success === false) ghost.classList.add('misplay');
  }
  const face = document.createElement('div');
  face.className = 'card-face';
  face.textContent = String(latest.card.number);
  ghost.append(face);
  document.body.append(ghost);
  setTimeout(() => ghost.remove(), 1300);
}

let lastFinishedStatus = null;

function maybeFireworks(v) {
  const prev = lastFinishedStatus;
  lastFinishedStatus = v.status;
  // Fire only on the in-session transition into 'finished'. If a client
  // reconnects directly into an already-finished game, prev is null and we
  // skip — they missed the moment.
  if (prev == null || prev === 'finished' || v.status !== 'finished') return;
  const gap = (v.maxScore ?? 0) - (v.score ?? 0);
  let tier = null;
  if (gap <= 0) tier = 'high';
  else if (gap <= 2) tier = 'medium';
  else if (gap <= 4) tier = 'low';
  if (!tier) return;
  playFireworks(tier);
}

function playFireworks(tier) {
  const overlay = document.getElementById('fireworks');
  if (!overlay) return;
  const { bursts, particles, spread } = {
    high:   { bursts: 22, particles: 32, spread: 4800 },
    medium: { bursts: 12, particles: 24, spread: 3400 },
    low:    { bursts: 5,  particles: 18, spread: 2000 },
  }[tier];
  for (let i = 0; i < bursts; i++) {
    const delay = (i / bursts) * spread + Math.random() * 240;
    setTimeout(() => spawnBurst(overlay, particles), delay);
  }
}

function spawnBurst(overlay, count) {
  const x = 8 + Math.random() * 84;    // 8-92% of viewport width
  const y = 15 + Math.random() * 55;   // 15-70% (keep above the hands)
  const baseHue = Math.floor(Math.random() * 360);
  const burst = document.createElement('div');
  burst.className = 'firework-burst';
  burst.style.left = `${x}%`;
  burst.style.top = `${y}%`;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.22;
    const distance = 90 + Math.random() * 80;
    const p = document.createElement('div');
    p.className = 'firework-particle';
    p.style.setProperty('--fw-dx', `${Math.cos(angle) * distance}px`);
    p.style.setProperty('--fw-dy', `${Math.sin(angle) * distance}px`);
    p.style.setProperty('--fw-color', `hsl(${baseHue + (Math.random() - 0.5) * 50}, 92%, 65%)`);
    burst.append(p);
  }
  overlay.append(burst);
  setTimeout(() => burst.remove(), 1400);
}

function formatElapsed(startedAt, endedAt) {
  if (!startedAt) return '00:00';
  const end = endedAt || Date.now();
  const totalSec = Math.max(0, Math.floor((end - startedAt) / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

setInterval(() => {
  const el = document.getElementById('game-timer');
  if (!el || !view) return;
  el.textContent = formatElapsed(view.startedAt, view.endedAt);
}, 1000);

function triggerDownload(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function render() {
  if (!view) return;
  renderHeader();
  const savedName = localStorage.getItem(NAME_KEY) || '';
  if (!savedName) {
    show(joinScreen);
    return;
  }
  if (view.kind === 'server-lobby') {
    show(serverLobbyScreen);
    renderServerLobby(view);
    return;
  }
  if (view.status === 'lobby') {
    show(lobbyScreen);
    renderLobby();
  } else {
    show(gameScreen);
    renderGame();
    renderReplayBar();
  }
}

function renderServerLobby(v) {
  const listEl = document.getElementById('rooms-list');
  listEl.innerHTML = '';
  const savedName = localStorage.getItem(NAME_KEY) || '';
  const rooms = v.rooms || [];
  if (rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lobby-empty';
    empty.textContent = 'No rooms yet — create one below.';
    listEl.append(empty);
  }
  for (const r of rooms) {
    const row = document.createElement('div');
    row.className = 'room-row status-' + r.status;
    const label = document.createElement('div');
    label.className = 'room-label';
    const title = document.createElement('div');
    title.className = 'room-title';
    title.textContent = r.name;
    label.append(title);
    const meta = document.createElement('div');
    meta.className = 'room-meta';
    const playerNames = r.players
      .map((p) => (p.isBot ? `🤖 ${p.name}` : p.online ? p.name : `${p.name} (offline)`))
      .join(', ') || '(empty)';
    const statusText = r.status === 'lobby'
      ? `lobby · ${r.variantId || 'no variant'}`
      : r.status === 'playing'
        ? `playing · turn ${r.turn} · ${r.variantId}`
        : `finished · ${r.variantId}`;
    meta.textContent = `${statusText} — ${playerNames}`;
    label.append(meta);
    row.append(label);
    const enter = document.createElement('button');
    enter.type = 'button';
    enter.textContent = 'Enter';
    enter.disabled = !savedName;
    enter.addEventListener('click', () => {
      send({ type: 'enterRoom', roomId: r.id, playerName: savedName, playerId });
    });
    row.append(enter);
    // Deletable when you created the room, or when no human is in it (no
    // players, or every seat offline or a bot). Mirrors the server's rule.
    const idle = r.players.every((p) => !p.online || p.isBot);
    if (idle || (playerId && r.creatorId === playerId)) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete-button';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        if (!confirm(`Delete room "${r.name}"?`)) return;
        send({ type: 'deleteRoom', roomId: r.id, playerId });
      });
      row.append(del);
    }
    listEl.append(row);
  }

  const savesEl = document.getElementById('resumable-saves');
  savesEl.innerHTML = '';
  const saves = v.resumableSaves || [];
  if (saves.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lobby-empty';
    empty.textContent = 'No incomplete saves.';
    savesEl.append(empty);
  }
  for (const s of saves) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const label = document.createElement('div');
    label.className = 'save-label';
    const title = document.createElement('div');
    title.className = 'save-title';
    title.textContent = s.basename;
    label.append(title);
    const meta = document.createElement('div');
    meta.className = 'save-meta';
    meta.textContent = `${s.variantId} · ${s.moves} moves · ${(s.playerNames || []).join(', ')}`;
    label.append(meta);
    row.append(label);
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.textContent = 'Resume';
    resume.disabled = !savedName;
    resume.addEventListener('click', () => {
      send({ type: 'resumeSave', file: s.basename });
    });
    row.append(resume);
    // Anyone may delete a save; the server moves it to saved-games/trash/
    // (recoverable by the host) and refuses if an open room is playing it.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete-button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (!confirm(`Delete saved game "${s.basename}"?`)) return;
      send({ type: 'deleteSave', file: s.basename });
    });
    row.append(del);
    savesEl.append(row);
  }

  renderLibrary(v.library || []);
}

async function copyText(text) {
  // navigator.clipboard needs a secure context; the app runs on plain http
  // over the tailnet, so fall back to the legacy path.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const done = document.execCommand('copy');
    ta.remove();
    return done;
  }
}

function renderLibrary(entries) {
  const listEl = document.getElementById('library-list');
  listEl.innerHTML = '';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lobby-empty';
    empty.textContent = 'No saved games yet.';
    listEl.append(empty);
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'save-row library-row';
    const label = document.createElement('div');
    label.className = 'save-label';

    const title = document.createElement('div');
    title.className = 'save-title';
    const when = e.startedAt ? new Date(e.startedAt).toLocaleString() : e.basename;
    const status = e.status === 'unreadable'
      ? 'unreadable'
      : e.status === 'in-progress'
        ? `in progress · ${e.moves} moves`
        : `${e.status} · ${e.score}/${e.maxScore}`;
    title.textContent = `${when} — ${status}`;
    label.append(title);

    const meta = document.createElement('div');
    meta.className = 'save-meta';
    meta.textContent = `${e.variantId ?? ''}${e.playerNames ? ' · ' + e.playerNames.join(', ') : ''}`;
    label.append(meta);

    if (e.tags && e.tags.length) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'save-tags';
      for (const t of e.tags) {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = t;
        tagsEl.append(chip);
      }
      label.append(tagsEl);
    }
    row.append(label);

    if (e.status !== 'unreadable') {
      const replayBtn = document.createElement('button');
      replayBtn.type = 'button';
      replayBtn.textContent = 'Replay';
      replayBtn.addEventListener('click', () => openReplay(e.basename));
      row.append(replayBtn);

      if (e.seed != null) {
        const seedBtn = document.createElement('button');
        seedBtn.type = 'button';
        seedBtn.textContent = 'Copy seed';
        seedBtn.title = `Seed ${e.seed} — paste into the lobby seed box to re-deal this deck`;
        seedBtn.addEventListener('click', async () => {
          const done = await copyText(String(e.seed));
          statusEl.textContent = done ? `seed ${e.seed} copied` : `seed: ${e.seed}`;
          setTimeout(() => { statusEl.textContent = 'connected'; }, 2500);
        });
        row.append(seedBtn);
      }

      const tagBtn = document.createElement('button');
      tagBtn.type = 'button';
      tagBtn.textContent = 'Tags';
      tagBtn.addEventListener('click', () => {
        const next = prompt('Tags (comma-separated):', (e.tags || []).join(', '));
        if (next == null) return;
        send({ type: 'tagSave', file: e.basename, tags: next.split(',').map((t) => t.trim()).filter(Boolean) });
      });
      row.append(tagBtn);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete-button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (!confirm(`Delete saved game from ${e.startedAt ? new Date(e.startedAt).toLocaleString() : e.basename}?`)) return;
      send({ type: 'deleteSave', file: e.basename });
    });
    row.append(del);

    listEl.append(row);
  }
}

function renderHeader() {
  const meEl = document.getElementById('me');
  const savedName = localStorage.getItem(NAME_KEY) || '';
  // In the server-lobby view we only have a stored name (no seat / playerId
  // yet). Still surface it in the header so the user can rename or see who
  // they'll be identified as.
  if (view?.kind === 'server-lobby') {
    if (!savedName) { meEl.hidden = true; return; }
    meEl.hidden = false;
    meEl.textContent = `you are ${savedName}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'change';
    btn.addEventListener('click', () => {
      const next = prompt('Your name:', savedName);
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === savedName) return;
      localStorage.setItem(NAME_KEY, trimmed);
      nameInput.value = trimmed;
      render();
    });
    meEl.append(' ', btn);
    return;
  }
  const players = view?.players ?? [];
  const me = players.find((p) => p.id === playerId);
  if (!me) {
    meEl.hidden = true;
    return;
  }
  meEl.hidden = false;
  meEl.textContent = `playing as ${me.name}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'change';
  btn.addEventListener('click', () => {
    const next = prompt('Your name:', me.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === me.name) return;
    send({ type: 'rename', name: trimmed });
    localStorage.setItem(NAME_KEY, trimmed);
    nameInput.value = trimmed;
  });
  meEl.append(' ', btn);
  if (view?.kind === 'in-room' && view.roomName) {
    const roomLabel = document.createElement('span');
    roomLabel.className = 'header-room';
    roomLabel.textContent = ` · in ${view.roomName}`;
    meEl.append(roomLabel);
    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.textContent = 'leave room';
    leaveBtn.addEventListener('click', () => {
      roomId = null;
      playerId = null;
      localStorage.removeItem(ROOM_KEY);
      localStorage.removeItem(PLAYER_KEY);
      send({ type: 'leaveRoom' });
    });
    meEl.append(' ', leaveBtn);
  }
}

function show(screen) {
  for (const s of [joinScreen, serverLobbyScreen, lobbyScreen, gameScreen]) {
    s.hidden = s !== screen;
  }
}

function renderLobby() {
  const listEl = document.getElementById('lobby-players');
  listEl.innerHTML = '';
  const isHost = view.hostId === playerId;
  view.players.forEach((p, i) => {
    const li = document.createElement('div');
    li.className = 'lobby-player';
    const tags = [];
    if (p.id === playerId) tags.push('you');
    if (p.id === view.hostId) tags.push('host');
    if (p.isBot) tags.push('bot');
    else if (!p.online) tags.push('offline');
    const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
    const label = document.createElement('span');
    label.textContent = `${i + 1}. ${p.isBot ? '🤖 ' : ''}${p.name} [${p.id}]${tagStr}`;
    li.append(label);
    if (p.isBot) {
      // Anyone may remove a bot.
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.className = 'delete-button';
      remove.addEventListener('click', () => send({ type: 'removeBot', playerId: p.id }));
      li.append(remove);
    }
    if (isHost && view.players.length > 1) {
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '↑';
      up.title = 'Move up';
      up.disabled = i === 0;
      up.addEventListener('click', () => send({ type: 'movePlayer', targetId: p.id, direction: 'up' }));
      li.append(up);
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '↓';
      down.title = 'Move down';
      down.disabled = i === view.players.length - 1;
      down.addEventListener('click', () => send({ type: 'movePlayer', targetId: p.id, direction: 'down' }));
      li.append(down);
    }
    listEl.append(li);
  });
  const addBotBtn = document.getElementById('add-bot-button');
  const slotsFree = view.botSlotsFree ?? 0;
  addBotBtn.disabled = view.players.length >= 5 || slotsFree <= 0;
  addBotBtn.textContent = slotsFree > 0
    ? '+ Add bot'
    : '+ Add bot (server bot limit reached)';
  document.getElementById('opt-variant').disabled = !isHost;
  document.getElementById('opt-endRule').disabled = !isHost;
  document.getElementById('opt-shareGuarded').disabled = !isHost;
  document.getElementById('opt-allowEmptyHints').disabled = !isHost;
  document.getElementById('start-button').disabled = !isHost || view.players.length < 2;
  document.getElementById('opt-variant').value = view.options.variantId;
  document.getElementById('opt-endRule').value = view.options.endRule;
  document.getElementById('opt-shareGuarded').checked = view.options.shareGuarded;
  document.getElementById('opt-allowEmptyHints').checked = view.options.allowEmptyHints;
  const importFile = document.getElementById('import-deck-file');
  importFile.disabled = !isHost;
  const importStatus = document.getElementById('import-deck-status');
  importStatus.innerHTML = '';
  if (view.importedDeck) {
    importStatus.hidden = false;
    const span = document.createElement('span');
    span.textContent = `Imported deck loaded (${view.importedDeck.count} cards) — used when the next game starts.`;
    importStatus.append(span);
    if (isHost) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Clear';
      clear.addEventListener('click', () => send({ type: 'clearImportedDeck' }));
      importStatus.append(' ', clear);
    }
  } else {
    importStatus.hidden = true;
  }
}

function renderGame() {
  const v = view;
  maybeAnimateAction(v);
  maybeFireworks(v);
  const meta = document.getElementById('game-meta');
  meta.innerHTML = '';
  const timerItem = document.createElement('div');
  timerItem.className = 'meta-item meta-timer';
  const timerLabel = document.createElement('strong');
  timerLabel.textContent = 'Time';
  const timerVal = document.createElement('span');
  timerVal.id = 'game-timer';
  timerVal.textContent = formatElapsed(v.startedAt, v.endedAt);
  timerItem.append(timerLabel, timerVal);

  const items = [
    ['Variant', v.variantName],
    ['Turn', v.turn],
    ['Score', v.maxAchievable < v.maxScore
      ? `${v.score} / ${v.maxScore}  (cap ${v.maxAchievable})`
      : `${v.score} / ${v.maxScore}`],
    ['Deck', `${v.deckSize} cards`],
    ['End rule', v.endRule],
    ['Guard marks', v.shareGuarded ? 'shared' : 'private'],
  ];
  for (const [k, val] of items) {
    const div = document.createElement('div');
    div.className = 'meta-item';
    div.innerHTML = `<strong>${k}</strong>${val}`;
    meta.append(div);
    if (k === 'Variant') meta.append(timerItem); // Time slot is right after Variant.
  }
  const artItem = document.createElement('label');
  artItem.className = 'meta-item meta-toggle';
  const artLabel = document.createElement('strong');
  artLabel.textContent = 'Card art';
  artItem.append(artLabel);
  const artBox = document.createElement('input');
  artBox.type = 'checkbox';
  artBox.checked = useArt;
  artBox.addEventListener('change', () => {
    useArt = artBox.checked;
    localStorage.setItem(ART_KEY, useArt ? 'on' : 'off');
    render();
  });
  artItem.append(artBox);
  meta.append(artItem);

  const verboseItem = document.createElement('label');
  verboseItem.className = 'meta-item meta-toggle';
  const verboseLabel = document.createElement('strong');
  verboseLabel.textContent = 'Verbose info';
  verboseItem.append(verboseLabel);
  const verboseBox = document.createElement('input');
  verboseBox.type = 'checkbox';
  verboseBox.checked = verbose;
  verboseBox.addEventListener('change', () => {
    verbose = verboseBox.checked;
    localStorage.setItem(VERBOSE_KEY, verbose ? 'on' : 'off');
    render();
  });
  verboseItem.append(verboseBox);
  meta.append(verboseItem);

  const tapItem = document.createElement('label');
  tapItem.className = 'meta-item meta-toggle';
  const tapLabel = document.createElement('strong');
  tapLabel.textContent = 'Tap to act';
  tapItem.append(tapLabel);
  const tapBox = document.createElement('input');
  tapBox.type = 'checkbox';
  tapBox.checked = tapMode;
  tapBox.addEventListener('change', () => {
    tapMode = tapBox.checked;
    localStorage.setItem(TAP_KEY, tapMode ? 'on' : 'off');
    render();
  });
  tapItem.append(tapBox);
  meta.append(tapItem);

  if (v.status === 'finished') {
    const banner = document.createElement('div');
    banner.className = 'banner ' + (v.endReason === 'perfect' ? 'win' : v.endReason === 'fuses' ? 'loss' : '');
    const seedText = v.seed != null ? `  seed: ${v.seed}` : '';
    const text = document.createElement('span');
    text.className = 'banner-text';
    text.textContent = `Game over — ${v.endReason}. Final score: ${v.score}/${v.maxScore}.${seedText}`;
    banner.append(text);

    const actions = document.createElement('div');
    actions.className = 'banner-actions';
    const isHost = v.hostId === playerId;
    if (isHost) {
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.textContent = 'Start a new game';
      newBtn.addEventListener('click', () => send({ type: 'start', seed: readSeedInput() }));
      actions.append(newBtn);

      const lobbyBtn = document.createElement('button');
      lobbyBtn.type = 'button';
      lobbyBtn.textContent = 'Back to lobby';
      lobbyBtn.addEventListener('click', () => send({ type: 'returnToLobby' }));
      actions.append(lobbyBtn);
    }
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = 'Export deck order';
    exportBtn.addEventListener('click', () => send({ type: 'exportDeck' }));
    actions.append(exportBtn);

    banner.append(actions);
    meta.append(banner);
  }

  const piles = document.getElementById('game-piles');
  piles.innerHTML = '';
  const tokensCol = document.createElement('div');
  tokensCol.className = 'tokens-col';
  const fuseWrap = document.createElement('div');
  fuseWrap.className = 'fuse-tokens';
  fuseWrap.title = `${v.fuseTokens} / 3 fuse tokens remaining`;
  for (let i = 0; i < 3; i++) {
    const t = document.createElement('div');
    t.className = 'fuse-token' + (i < v.fuseTokens ? '' : ' empty');
    fuseWrap.append(t);
  }
  tokensCol.append(fuseWrap);
  const tokensWrap = document.createElement('div');
  tokensWrap.className = 'hint-tokens';
  tokensWrap.title = `${v.hintTokens} / 8 hint tokens available`;
  for (let i = 0; i < 8; i++) {
    const t = document.createElement('div');
    t.className = 'hint-token' + (i < v.hintTokens ? '' : ' empty');
    tokensWrap.append(t);
  }
  tokensCol.append(tokensWrap);
  piles.append(tokensCol);
  const discardsByColor = Object.fromEntries(v.suits.map((s) => [s.color, []]));
  for (const c of v.discard) discardsByColor[c.color].push(c.number);
  for (const color of Object.keys(discardsByColor)) {
    discardsByColor[color].sort((a, b) => a - b);
  }
  const pileGroup = document.createElement('div');
  pileGroup.className = 'pile-group';
  for (const suit of v.suits) {
    const p = v.playedPiles[suit.color];
    const column = document.createElement('div');
    column.className = 'pile-column';

    const pile = document.createElement('div');
    pile.className = 'pile';
    pile.dataset.color = suit.color;
    pile.dataset.direction = suit.direction;
    if (p.count >= p.cap) {
      pile.classList.add('done');
      pile.title = p.count === 5 ? 'Pile complete' : `Pile capped at ${p.count} (critical cards discarded)`;
    }
    pile.textContent = suit.direction === 'up'
      ? (p.top > 0 ? p.top : '–')
      : (p.top < 6 ? p.top : '–');
    column.append(pile);

    const summary = document.createElement('div');
    summary.className = 'discard-summary';
    for (const n of discardsByColor[suit.color]) {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = n;
      summary.append(num);
    }
    column.append(summary);
    pileGroup.append(column);
  }
  piles.append(pileGroup);

  renderLatestAction(v);

  const hands = document.getElementById('game-hands');
  hands.innerHTML = '';
  hands.dataset.count = String(v.players.length);
  const isMyTurn = v.currentPlayer === v.viewerIndex && v.status === 'playing';
  for (let i = 0; i < v.players.length; i++) {
    const row = renderPlayerRow(v.players[i], i, isMyTurn);
    row.dataset.seat = String(i);
    hands.append(row);
  }
  // Re-attach any reaction bubble still mid-lifetime (renders wipe the rows).
  for (const idx of [...activeReactions.keys()]) attachReactionBubble(idx);

  const log = document.getElementById('game-log');
  log.innerHTML = '';
  for (const e of v.log.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    if (e.undone) {
      div.classList.add('undone');
      const text = document.createElement('span');
      text.className = 'undone-text';
      text.textContent = formatLog(e);
      const badge = document.createElement('span');
      badge.className = 'undo-badge';
      badge.textContent = '[UNDO]';
      div.append(text, ' ', badge);
    } else {
      div.textContent = formatLog(e);
    }
    log.append(div);
  }

  renderDiscard();
  const undoBtn = document.getElementById('undo-button');
  undoBtn.hidden = !v.canUndo;
  const requested = v.undoRequests || [];
  undoBtn.classList.toggle('requested', v.canUndo && requested.length > 0);
  const reqBtn = document.getElementById('request-undo-button');
  reqBtn.hidden = !(v.canRequestUndo && v.status === 'playing');
  reqBtn.textContent = v.undoRequestedByMe ? 'Cancel undo request' : 'Request undo';
  reqBtn.classList.toggle('requested', !!v.undoRequestedByMe);
  const reqNote = document.getElementById('undo-request-note');
  if (v.canUndo && requested.length > 0) {
    reqNote.hidden = false;
    const names = requested.length > 1
      ? `${requested.slice(0, -1).join(', ')} and ${requested.at(-1)}`
      : requested[0];
    reqNote.textContent = `${names} ${requested.length > 1 ? 'have' : 'has'} requested you undo`;
  } else {
    reqNote.hidden = true;
    reqNote.textContent = '';
  }
  const abandonBtn = document.getElementById('abandon-button');
  if (v.status === 'playing' && v.abandonVotes) {
    abandonBtn.hidden = false;
    const { count, threshold, me } = v.abandonVotes;
    abandonBtn.textContent = me
      ? `Cancel my abandon vote (${count}/${threshold})`
      : `Abandon game (${count}/${threshold})`;
    abandonBtn.classList.toggle('voted', me);
  } else {
    abandonBtn.hidden = true;
  }
}

function renderPlayerRow(player, index, isMyTurn) {
  const row = document.createElement('div');
  row.className = 'player-row';
  if (index === view.currentPlayer && view.status === 'playing') row.classList.add('active');

  const head = document.createElement('header');
  const name = document.createElement('span');
  name.className = 'player-name';
  name.textContent = (player.isBot ? '🤖 ' : '') + player.name + (index === view.viewerIndex ? ' (you)' : '');
  head.append(name);
  if (index === view.currentPlayer && view.status === 'playing') {
    const marker = document.createElement('span');
    marker.className = 'turn-marker';
    marker.textContent = 'turn';
    head.append(marker);
  }
  const latest = latestActionEntry(view.log);
  if (latest && bubbleTargetIndex(latest) === index) {
    const notable = notableEntry(latest);
    if (notable) {
      const bubble = document.createElement('span');
      bubble.className = 'action-bubble ' + notable.kind;
      bubble.textContent = notable.text;
      head.append(bubble);
    }
  }
  row.append(head);

  const hand = document.createElement('div');
  hand.className = 'hand';
  player.hand.forEach((card, cardIndex) => {
    hand.append(renderCard(card, index, cardIndex, isMyTurn));
  });
  row.append(hand);

  if (isMyTurn && index !== view.viewerIndex && player.hand.length > 0) {
    if (tapMode) {
      // Tapping a card offers a hint matching that card (see renderCard);
      // tapping anywhere else in the row (header, gaps, padding) offers the
      // full colour/number picker — useful for a hint that touches nothing.
      // Cards call stopPropagation, so only "empty space" clicks reach here.
      row.classList.add('tap-hint-row');
      row.addEventListener('click', () => openHintPicker(index));
    } else {
      row.append(renderHintControls(index));
    }
  }
  return row;
}

function deriveCardDisplay(card, view, verboseOn) {
  const isMine = card.color === undefined;
  const nonBlackColorCount = view.suits.filter((s) => s.color !== 'black').length;
  const visibleColors = card.possibleColors.filter((c) => c !== 'black');

  if (isMine) {
    let knownColor = null;
    if (card.possibleColors.length === 1 && card.possibleColors[0] === 'black') {
      knownColor = 'black';
    } else if (visibleColors.length === 1 && !card.possibleColors.includes('black')) {
      knownColor = visibleColors[0];
    }
    const knownNumber = card.possibleNumbers.length === 1 ? card.possibleNumbers[0] : null;
    let possibleColorList = null;
    if (!knownColor && (verboseOn || visibleColors.length < nonBlackColorCount)) {
      possibleColorList = card.possibleColors.slice();
    }
    let possibleNumberList = null;
    if (!knownNumber && (verboseOn || card.possibleNumbers.length < 5)) {
      possibleNumberList = card.possibleNumbers;
    }
    return {
      faceColor: knownColor,
      faceNumber: knownNumber,
      possibleColorList,
      possibleNumberList,
      noInfo: false,
    };
  }

  const colorsAllOpen = visibleColors.length === nonBlackColorCount;
  const numbersAllOpen = card.possibleNumbers.length === 5;
  const noInfo = !verboseOn && colorsAllOpen && numbersAllOpen;
  return {
    faceColor: card.color,
    faceNumber: card.number,
    possibleColorList: noInfo ? null : card.possibleColors.slice(),
    possibleNumberList: noInfo ? null : card.possibleNumbers,
    noInfo,
  };
}

function renderCard(card, ownerIndex, cardIndex, isMyTurn) {
  const isMine = ownerIndex === view.viewerIndex;
  const { faceColor, faceNumber, possibleColorList, possibleNumberList, noInfo } = deriveCardDisplay(card, view, verbose);
  const showArt = useArt && !!faceColor && faceNumber != null;
  const el = document.createElement('div');
  el.className = 'card';
  if (!faceColor) {
    el.classList.add('face-down');
    if (useArt) {
      el.classList.add('art');
      el.style.backgroundImage = `url('/cards/back')`;
    }
  }
  if (faceColor && !showArt) el.dataset.color = faceColor;
  if (card.colorClued || card.numberClued) el.classList.add('clued');
  if (card.colorClued) el.classList.add('clued-color');
  if (card.numberClued) el.classList.add('clued-number');
  if (showArt) {
    el.classList.add('art');
    el.style.backgroundImage = `url('/cards/${faceColor}-${faceNumber}')`;
  }

  const face = document.createElement('div');
  face.className = 'card-face';
  face.textContent = (faceNumber != null && !showArt) ? String(faceNumber) : '';
  el.append(face);

  if (noInfo) {
    const tag = document.createElement('div');
    tag.className = 'no-info';
    tag.textContent = 'no info';
    el.append(tag);
  } else {
    const possible = renderPossible(possibleColorList ?? [], possibleNumberList ?? [], false);
    if (possible) el.append(possible);
  }
  if (card.lastHints && card.lastHints.length) {
    // Newest is the last entry. Render newest at center, older fanning to the
    // right with overlap; newest sits on top via descending z-index.
    const total = card.lastHints.length;
    card.lastHints.forEach((h, i) => {
      const ageFromNewest = total - 1 - i;
      const marker = document.createElement('div');
      marker.className = 'latest-hint ' + h.hintType;
      if (h.hintType === 'color') {
        marker.dataset.color = h.value;
        marker.title = `Hint: ${h.value}`;
      } else {
        marker.textContent = String(h.value);
        marker.title = `Hint: ${h.value}`;
      }
      marker.style.setProperty('--hint-offset', String(ageFromNewest));
      marker.style.zIndex = String(10 - ageFromNewest);
      el.append(marker);
    });
  }
  if (card.annotations?.guarded) {
    const dot = document.createElement('div');
    dot.className = 'guard-dot';
    dot.title = 'Guarded';
    el.append(dot);
  }
  if (card.annotations?.note) {
    const note = document.createElement('div');
    note.className = 'card-note';
    note.textContent = `“${card.annotations.note}”`;
    el.append(note);
  }

  if (!isMine && tapMode && isMyTurn && view.status === 'playing') {
    el.classList.add('tap-target');
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openHintCardActions(card, ownerIndex);
    });
  }

  if (isMine && view.status === 'playing') {
    if (tapMode) {
      el.classList.add('tap-target');
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openCardActions(card, cardIndex, isMyTurn);
      });
    } else {
      const actions = document.createElement('div');
      actions.className = 'card-actions';

      const row1 = document.createElement('div');
      row1.className = 'row';
      if (isMyTurn) {
        const playBtn = document.createElement('button');
        playBtn.textContent = 'Play';
        playBtn.addEventListener('click', () => send({ type: 'action', action: { type: 'play', cardIndex } }));
        row1.append(playBtn);
      }
      const noteBtn = document.createElement('button');
      noteBtn.className = 'edit-btn';
      noteBtn.textContent = '✎';
      noteBtn.title = 'Annotate';
      noteBtn.addEventListener('click', () => openAnnotateModal(card));
      row1.append(noteBtn);
      actions.append(row1);

      if (isMyTurn) {
        const row2 = document.createElement('div');
        row2.className = 'row';
        const discardBtn = document.createElement('button');
        discardBtn.textContent = 'Discard';
        discardBtn.disabled = view.hintTokens >= 8;
        discardBtn.addEventListener('click', () => send({ type: 'action', action: { type: 'discard', cardIndex } }));
        row2.append(discardBtn);
        actions.append(row2);
      }
      el.append(actions);
    }
  }
  return el;
}

function openCardActions(card, cardIndex, isMyTurn) {
  const overlay = document.getElementById('card-action-overlay');
  const pop = document.getElementById('card-action-popover');
  pop.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'popover-title';
  title.textContent = `Card ${cardIndex + 1}`;
  pop.append(title);

  const make = (text, className, disabled, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (className) b.className = className;
    if (disabled) b.disabled = true;
    b.addEventListener('click', onClick);
    pop.append(b);
    return b;
  };

  if (isMyTurn) {
    make('Play', 'big-action play', false, () => {
      send({ type: 'action', action: { type: 'play', cardIndex } });
      closeCardActions();
    });
    make('Discard', 'big-action discard', view.hintTokens >= 8, () => {
      send({ type: 'action', action: { type: 'discard', cardIndex } });
      closeCardActions();
    });
  }
  make('Annotate', 'big-action annotate', false, () => {
    closeCardActions();
    openAnnotateModal(card);
  });
  make('Cancel', 'big-action cancel', false, closeCardActions);

  overlay.hidden = false;
}

function closeCardActions() {
  document.getElementById('card-action-overlay').hidden = true;
}

// Tap-to-act, tapping an opponent's card: offer the two hints that touch it.
function openHintCardActions(card, targetIndex) {
  const overlay = document.getElementById('card-action-overlay');
  const pop = document.getElementById('card-action-popover');
  pop.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'popover-title';
  title.textContent = 'Give a hint';
  pop.append(title);

  const disabled = view.hintTokens <= 0;
  const sendHint = (hintType, value) => {
    send({ type: 'action', action: { type: 'hint', toPlayerIndex: targetIndex, hintType, value } });
    closeCardActions();
  };

  // Some suits (black, rainbow) are never directly hintable by colour — skip
  // the button rather than show a permanently-disabled option.
  if (view.hintableColors.includes(card.color)) {
    const colorBtn = document.createElement('button');
    colorBtn.type = 'button';
    colorBtn.className = 'big-action hint-color-action';
    colorBtn.dataset.color = card.color;
    colorBtn.textContent = `Hint colour: ${card.color}`;
    colorBtn.disabled = disabled;
    colorBtn.addEventListener('click', () => sendHint('color', card.color));
    pop.append(colorBtn);
  }

  const numberBtn = document.createElement('button');
  numberBtn.type = 'button';
  numberBtn.className = 'big-action hint-number-action';
  numberBtn.textContent = `Hint number: ${card.number}`;
  numberBtn.disabled = disabled;
  numberBtn.addEventListener('click', () => sendHint('number', card.number));
  pop.append(numberBtn);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'big-action cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeCardActions);
  pop.append(cancel);

  overlay.hidden = false;
}

// Tap-to-act, tapping a player's empty space: every hintable colour and
// number, for a hint that touches nothing in particular (or just to pick
// freely rather than from one card).
function openHintPicker(targetIndex) {
  const overlay = document.getElementById('card-action-overlay');
  const pop = document.getElementById('card-action-popover');
  pop.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'popover-title';
  title.textContent = 'Give a hint';
  pop.append(title);

  const controls = renderHintControls(targetIndex);
  // Close the popover after the hint is sent — renderHintControls' buttons
  // send the action directly, so wrap with a capture-phase listener.
  controls.addEventListener('click', (ev) => {
    if (ev.target.closest('.chip')) closeCardActions();
  });
  pop.append(controls);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'big-action cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeCardActions);
  pop.append(cancel);

  overlay.hidden = false;
}

function renderPossible(colors, numbers, manual) {
  if (colors.length === 0 && numbers.length === 0) return null;
  const div = document.createElement('div');
  div.className = 'possible' + (manual ? ' manual' : '');
  if (manual) div.title = 'Manual marks';
  for (const c of colors) {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.dataset.color = c;
    sw.title = c;
    div.append(sw);
  }
  for (const n of numbers) {
    const sp = document.createElement('span');
    sp.className = 'num';
    sp.textContent = n;
    div.append(sp);
  }
  return div;
}

function renderHintControls(targetIndex) {
  const wrap = document.createElement('div');
  wrap.className = 'hint-controls';
  const disabled = view.hintTokens <= 0;
  for (const color of view.hintableColors) {
    const b = document.createElement('button');
    b.className = 'chip color';
    b.dataset.color = color;
    b.style.background = `var(--color-${color})`;
    b.textContent = color;
    b.disabled = disabled;
    b.addEventListener('click', () => send({
      type: 'action',
      action: { type: 'hint', toPlayerIndex: targetIndex, hintType: 'color', value: color },
    }));
    wrap.append(b);
  }
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = n;
    b.disabled = disabled;
    b.addEventListener('click', () => send({
      type: 'action',
      action: { type: 'hint', toPlayerIndex: targetIndex, hintType: 'number', value: n },
    }));
    wrap.append(b);
  }
  return wrap;
}

function renderHintChip(hintType, value) {
  const chip = document.createElement('span');
  chip.className = 'latest-hint-chip ' + hintType;
  if (hintType === 'color') {
    chip.dataset.color = value;
    chip.title = String(value);
  } else {
    chip.textContent = String(value);
    chip.title = String(value);
  }
  return chip;
}

function renderCardSymbol(color, number) {
  const el = document.createElement('span');
  el.className = 'card-symbol';
  el.style.background = `var(--color-${color})`;
  el.style.color = (color === 'yellow' || color === 'white') ? '#111' : '#fff';
  el.textContent = number;
  return el;
}

function renderDiscard() {
  const root = document.getElementById('game-discard');
  root.innerHTML = '<h3>Discard Order</h3>';
  const pile = document.createElement('div');
  pile.className = 'discard-pile';
  for (const c of view.discard) {
    pile.append(renderCardSymbol(c.color, c.number));
  }
  root.append(pile);
}

function latestActionEntry(log) {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    // Undone actions are kept in the log (struck out) but are no longer the
    // "latest action" — the banner, bubbles, and animations ignore them.
    if (e.undone) continue;
    if (e.type === 'play' || e.type === 'discard' || e.type === 'hint') return e;
  }
  return null;
}

function notableEntry(e) {
  if (!e) return null;
  if (e.type === 'hint' && e.touchedIndexes && e.touchedIndexes.length === 0) {
    return { kind: 'hint-empty', text: 'No cards touched' };
  }
  if (e.type === 'play' && e.wasTouched === false) {
    return { kind: 'play-unclued', text: 'Played an untouched card' };
  }
  if (e.type === 'discard') {
    if (e.wasTouched) return { kind: 'discard-touched', text: 'Discarded a touched card' };
    if (e.chopIndex != null && e.chopIndex >= 0 && e.cardIndex !== e.chopIndex) {
      return { kind: 'discard-past-chop', text: 'Discarded past the chop' };
    }
  }
  return null;
}

function bubbleTargetIndex(e) {
  if (!e) return -1;
  // Hints flag the receiver (the row whose cards visibly got nothing).
  if (e.type === 'hint') return e.toIndex;
  return e.playerIndex;
}

function renderLatestAction(v) {
  const root = document.getElementById('latest-action');
  root.innerHTML = '';
  const header = document.createElement('h3');
  header.textContent = 'Latest action';
  root.append(header);

  const e = latestActionEntry(v.log);
  if (!e) {
    const empty = document.createElement('div');
    empty.className = 'latest-empty';
    empty.textContent = 'Waiting for the first action…';
    root.append(empty);
    return;
  }
  const name = (i) => v.players[i]?.name ?? `P${i}`;
  const body = document.createElement('div');
  body.className = 'latest-body';

  if (e.type === 'hint') {
    const line = document.createElement('div');
    line.className = 'latest-line';
    line.append(`${name(e.fromIndex)} hinted ${name(e.toIndex)}: `);
    line.append(renderHintChip(e.hintType, e.value));
    body.append(line);
    if (e.touchedIndexes && e.touchedIndexes.length === 0) {
      const warn = document.createElement('div');
      warn.className = 'latest-highlight';
      warn.textContent = 'No cards touched.';
      body.append(warn);
    }
  } else if (e.type === 'play') {
    const line = document.createElement('div');
    line.className = 'latest-line';
    line.append(`${name(e.playerIndex)} played `);
    line.append(renderCardSymbol(e.card.color, e.card.number));
    if (e.success === false) line.append(' (MISPLAY)');
    body.append(line);
    if (e.wasTouched === false) {
      const warn = document.createElement('div');
      warn.className = 'latest-highlight';
      warn.textContent = 'Card was not touched.';
      body.append(warn);
    }
  } else if (e.type === 'discard') {
    const line = document.createElement('div');
    line.className = 'latest-line';
    line.append(`${name(e.playerIndex)} discarded `);
    line.append(renderCardSymbol(e.card.color, e.card.number));
    body.append(line);
    if (e.wasTouched) {
      const touched = document.createElement('div');
      if (e.wasFullyKnown) {
        touched.textContent = 'Card was touched. Full info was known.';
        body.append(touched);
      } else if (e.knownColors || e.knownNumbers) {
        touched.className = 'latest-line';
        touched.append(`Card was touched. ${name(e.playerIndex)} knew `);
        const possible = renderPossible(e.knownColors ?? [], e.knownNumbers ?? [], false);
        if (possible) touched.append(possible);
        body.append(touched);
      } else {
        // Older save / log entry without the snapshot — fall back to the previous wording.
        touched.textContent = 'Card was touched. Full info was not known.';
        body.append(touched);
      }
    } else if (e.chopIndex != null && e.chopIndex >= 0 && e.cardIndex !== e.chopIndex) {
      const chop = document.createElement('div');
      chop.className = 'latest-highlight';
      chop.textContent = 'Card was not the chop.';
      body.append(chop);
    }
  }
  root.append(body);
}

function formatLog(e) {
  const name = (i) => view.players[i]?.name ?? `P${i}`;
  switch (e.type) {
    case 'play':
      return `t${e.turn}: ${name(e.playerIndex)} played ${e.card.color} ${e.card.number}${e.success ? '' : ' (MISPLAY)'}${e.bonusHint ? ' +hint' : ''}`;
    case 'discard':
      return `t${e.turn}: ${name(e.playerIndex)} discarded ${e.card.color} ${e.card.number}`;
    case 'hint':
      return `t${e.turn}: ${name(e.fromIndex)} hinted ${name(e.toIndex)} ${e.hintType}=${e.value} (touched ${e.touchedIndexes.length})`;
    case 'draw':
      return `t${e.turn}: ${name(e.playerIndex)} drew`;
    default:
      return JSON.stringify(e);
  }
}

const annotateModal = document.getElementById('annotate-modal');
const annotateCardInfo = document.getElementById('annotate-card-info');
const annotateGuardedInput = document.getElementById('annotate-guarded');
const annotateNoteInput = document.getElementById('annotate-note');
let annotatingCardId = null;

function openAnnotateModal(card) {
  annotatingCardId = card.id;
  annotateGuardedInput.checked = !!card.annotations?.guarded;
  annotateNoteInput.value = card.annotations?.note ?? '';
  annotateCardInfo.textContent = `Card you can see as: ${card.colorClued ? 'colour-clued' : 'no colour clue'}, ${card.numberClued ? 'number-clued' : 'no number clue'}`;
  annotateModal.hidden = false;
}

document.getElementById('annotate-cancel').addEventListener('click', () => {
  annotateModal.hidden = true;
});

document.getElementById('card-action-overlay').addEventListener('click', (ev) => {
  // Close when the user taps the backdrop (anywhere outside the popover).
  if (ev.target.id === 'card-action-overlay') closeCardActions();
});

document.getElementById('annotate-save').addEventListener('click', () => {
  send({
    type: 'action',
    action: {
      type: 'annotate',
      cardId: annotatingCardId,
      guarded: annotateGuardedInput.checked,
      note: annotateNoteInput.value,
    },
  });
  annotateModal.hidden = true;
});

connect();
