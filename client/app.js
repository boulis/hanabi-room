const statusEl = document.getElementById('status');
const joinScreen = document.getElementById('join-screen');
const serverLobbyScreen = document.getElementById('server-lobby-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');

const PLAYER_KEY = 'hanabi-room.playerId';
const NAME_KEY = 'hanabi-room.name';

// Player names joined for display, each bot prefixed with the robot badge.
// `bots` is a parallel boolean array (from a save summary's playerBots); a
// missing array just renders plain names.
// A bot seat is only as good as the brain of the day, so a name list prints
// the version that sat there — `🤖 Robo (2.29)`. Saves written before the
// header carried one leave it null and render as a bare 🤖.
function joinPlayerNames(names, bots, versions) {
  return (names || []).map((n, i) => (
    bots?.[i] ? `🤖 ${n}${versions?.[i] ? ` (${versions[i]})` : ''}` : n
  )).join(', ');
}

// Bot ids whose convention-options panel is expanded, so it survives the full
// lobby re-render every sync triggers.
const openBotOptions = new Set();
// Toggleable per-bot convention options, in display order: key, label, and a
// short explanation shown under the label.
const BOT_OPTION_LABELS = [
  ['alarmDiscards', 'Alarm discards',
    'A warning signal for danger a hint can’t cover. The bot makes a deliberately odd discard (burning a useful card, or discarding despite an obvious play) to tell the next player "guard your oldest card". As receiver, it reacts to such a discard by guarding its own oldest unclued card(s).'],
  ['forcedPlaySignals', 'Forced plays',
    'A 2-player deadlock breaker for when hint tokens run out and one player is stuck with nothing safe to do. The free player’s discards step a pointer across the stuck player’s maybe-playable cards, and their eventual play commands the pointed card to be played.'],
  ['zeroHintPlaysChop', '0-card hint → play chop',
    'Only works if the room allows empty hints. A hint that touches none of your cards means "play your chop" — your oldest unclued card. The bot both sends these (when your chop is playable but not cleanly hintable) and obeys them.'],
];
const ROOM_KEY = 'hanabi-room.roomId';
const SPECTATE_KEY = 'hanabi-room.spectating';
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
// Spectators are never persisted by id (a fresh spectator record is cheap to
// create) — just whether we were watching a room, so a reload rejoins the
// same way instead of trying to reclaim a seat that was never ours.
let isSpectating = localStorage.getItem(SPECTATE_KEY) === 'on';
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
      if (isSpectating) send({ type: 'spectateRoom', roomId, playerName: savedName });
      else send({ type: 'enterRoom', roomId, playerName: savedName, playerId });
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
      isSpectating = !!msg.isSpectator;
      if (isSpectating) localStorage.setItem(SPECTATE_KEY, 'on');
      else localStorage.removeItem(SPECTATE_KEY);
      // Fresh room, fresh animation baseline — a stale one (e.g. from replay
      // stepping before a branch) would silently swallow animations for
      // turns it thinks it has already shown.
      lastAnimatedActionSeq = null;
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
      if (detailRefreshOnSync && detailFile) {
        detailRefreshOnSync = false;
        send({ type: 'gameDetail', file: detailFile });
      }
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
    case 'statsView':
      renderStatsView(msg);
      break;
    case 'gameDetailView':
      onGameDetailView(msg.detail);
      break;
    case 'error':
      console.warn('server error:', msg.code, msg.error);
      flashError(msg.error);
      if (msg.code === 'no_room' && roomId) {
        // The room we thought we were in is gone; forget it so the lobby is
        // the natural landing spot.
        roomId = null;
        playerId = null;
        isSpectating = false;
        localStorage.removeItem(ROOM_KEY);
        localStorage.removeItem(PLAYER_KEY);
        localStorage.removeItem(SPECTATE_KEY);
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
document.getElementById('opt-allowSpectators').addEventListener('change', (e) => {
  send({ type: 'configure', options: { allowSpectators: e.target.checked } });
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
  replay = { file, upto: 0, total: 0, pending: 0 };
  preReplayView = view;
  lastAnimatedActionSeq = null; // fresh baseline; steps animate like live play
  send({ type: 'replaySave', file, upto: 0 });
}

function onReplayView(msg) {
  if (!replay || replay.file !== msg.file) return; // stale response
  // Arrow-key repeat can put several requests in flight; only the newest one's
  // view is current, so drop any response for a superseded position.
  if (replay.pending != null && msg.upto !== replay.pending) return;
  replay.pending = null;
  replay.upto = msg.upto;
  replay.total = msg.total;
  view = msg.view;
  render();
}

function closeReplay(restore = true) {
  if (!replay) return;
  replay = null;
  lastAnimatedActionSeq = null; // replay stepping must not suppress live animations
  document.getElementById('replay-bar').hidden = true;
  if (restore && preReplayView) {
    view = preReplayView;
    preReplayView = null;
    render();
  } else {
    preReplayView = null;
  }
}

// Where the next step counts from: the position we last asked for while a
// request is still in flight (key repeat outruns the round trip), else the
// position on screen.
function replayCursor() {
  return replay ? (replay.pending ?? replay.upto) : 0;
}

function replayStep(upto) {
  if (!replay) return;
  const clamped = Math.max(0, Math.min(upto, replay.total));
  replay.pending = clamped;
  send({ type: 'replaySave', file: replay.file, upto: clamped });
}

// ←/→ step through the replay, Home/End jump to the ends. Ignored while the
// user is typing (a name field, the tag box) or holding a modifier, so browser
// and text-editing shortcuts keep working.
document.addEventListener('keydown', (e) => {
  if (!replay || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const step = {
    ArrowLeft: () => replayCursor() - 1,
    ArrowRight: () => replayCursor() + 1,
    Home: () => 0,
    End: () => replay.total,
  }[e.key];
  if (!step) return;
  e.preventDefault();
  replayStep(step());
});

document.getElementById('replay-first').addEventListener('click', () => replayStep(0));
document.getElementById('replay-prev').addEventListener('click', () => replayStep(replayCursor() - 1));
document.getElementById('replay-next').addEventListener('click', () => replayStep(replayCursor() + 1));
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

// Keyed on the log entry's seq (a monotonic id assigned server-side), not its
// turn number: after an undo, the replacement action reuses the same turn
// number as the action it replaced, so turn alone can't tell "a new action
// landed" from "the log just got its struck entries re-appended" — which
// used to make the replacement action's animation silently not fire.
let lastAnimatedActionSeq = null;

function maybeAnimateAction(v) {
  const latest = latestActionEntry(v.log);
  if (!latest) {
    // No action yet (game just started or restarted). Re-baseline so the
    // first action in the new game does animate.
    lastAnimatedActionSeq = -1;
    return;
  }
  if (lastAnimatedActionSeq === null) {
    // First time we're seeing actions (fresh connect mid-game). Baseline
    // silently — don't replay history with animations.
    lastAnimatedActionSeq = latest.seq;
    return;
  }
  if (latest.seq <= lastAnimatedActionSeq) return;
  lastAnimatedActionSeq = latest.seq;
  // Defer one frame so the post-action DOM is in place before we measure.
  if (latest.type === 'hint') {
    requestAnimationFrame(() => animateHint(latest));
    return;
  }
  if (latest.type !== 'play' && latest.type !== 'discard') return;
  requestAnimationFrame(() => animateLeavingCard(v, latest));
}

// A hint flies as large chips (colour discs or numbers) from the hinter's row
// to the receiver's — one chip per touched card, fanning out from a single
// launch point to land on each card — then fades. Makes "who hinted whom" and
// "which cards" legible without reading the latest-action panel.
function animateHint(latest) {
  const rows = document.querySelectorAll('#game-hands .player-row');
  const from = rows[latest.fromIndex];
  const to = rows[latest.toIndex];
  if (!from || !to) return;
  const fr = from.getBoundingClientRect();
  const startX = fr.left + fr.width / 2;
  const startY = fr.top + fr.height / 2;

  // One landing spot per touched card; fall back to the row centre (e.g. an
  // allowed empty hint touches nothing).
  const cards = to.querySelectorAll('.hand > *');
  const targets = (latest.touchedIndexes || [])
    .map((i) => cards[i])
    .filter(Boolean)
    .map((card) => {
      const r = card.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  if (targets.length === 0) {
    const tr = to.getBoundingClientRect();
    targets.push({ x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 });
  }

  const SIZE = 56; // keep in sync with .hint-fly .latest-hint-chip CSS
  const STAGGER = 70; // ms between discs, so the fan-out reads as several
  targets.forEach((t, i) => {
    const fly = document.createElement('div');
    fly.className = 'hint-fly';
    fly.append(renderHintChip(latest.hintType, latest.value));
    fly.style.left = `${startX - SIZE / 2}px`;
    fly.style.top = `${startY - SIZE / 2}px`;
    fly.style.setProperty('--fly-x', `${t.x - startX}px`);
    fly.style.setProperty('--fly-y', `${t.y - startY}px`);
    fly.style.animationDelay = `${i * STAGGER}ms`;
    document.body.append(fly);
    setTimeout(() => fly.remove(), 1600 + i * STAGGER);
  });

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
    const watchingText = r.spectatorCount > 0 ? ` · 👀 ${r.spectatorCount} watching` : '';
    meta.textContent = `${statusText} — ${playerNames}${watchingText}`;
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
    // A clearly distinct action from "Enter" — spectators watch, they don't
    // take a seat. Only offered when the host has opted the room in.
    if (r.allowSpectators) {
      const spectate = document.createElement('button');
      spectate.type = 'button';
      spectate.className = 'spectate-button';
      spectate.textContent = 'Spectator';
      spectate.disabled = !savedName;
      spectate.addEventListener('click', () => {
        send({ type: 'spectateRoom', roomId: r.id, playerName: savedName });
      });
      row.append(spectate);
    }
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
    meta.textContent = `${s.variantId} · ${s.moves} moves · ${joinPlayerNames(s.playerNames, s.playerBots, s.playerBotVersions)}`;
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
    // The label opens the game's info page; the buttons beside it are their
    // own click targets and never reach this handler.
    const label = document.createElement(e.status === 'unreadable' ? 'div' : 'button');
    label.className = 'save-label';
    if (e.status !== 'unreadable') {
      label.type = 'button';
      label.title = 'Open game info';
      label.addEventListener('click', () => openGameDetail(e.basename));
    }

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
    const metaText = document.createElement('span');
    metaText.className = 'save-meta-text';
    metaText.textContent = `${e.variantId ?? ''}${e.playerNames ? ' · ' + joinPlayerNames(e.playerNames, e.playerBots, e.playerBotVersions) : ''}`;
    meta.append(metaText);
    // Par for the same deck, so a row says whether the score was the deck's
    // doing or the players'.
    // (An unreadable save has no score to compare a stored par against.)
    if (e.botScore && typeof e.score === 'number') meta.append(' · ', parDeltaChip(e.botScore, e.score));
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
      replayBtn.textContent = 'Review';
      replayBtn.title = 'Step through this game move by move, with every hand visible';
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

// --- Player stats: one table per game (on the game-over banner) and an
// aggregate over a chosen set of saved games (server lobby). The server does
// the counting; the client only asks and renders.

function formatMinsSecs(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function statsTable(rows, { extraColumns = [], shareLabel, shareOf }) {
  const table = document.createElement('table');
  table.className = 'stats-table';
  const columns = [
    { key: 'name', label: 'Player' },
    ...extraColumns,
    { key: 'plays', label: 'Cards played' },
    { key: 'discards', label: 'Cards discarded' },
    { key: 'hints', label: 'Hints given' },
    { key: 'hintsReceived', label: 'Hints received' },
    { key: 'undos', label: 'Undos' },
    { key: 'moveMs', label: 'Time' },
    { key: 'perMove', label: 'Avg s/move' },
    { key: 'share', label: shareLabel },
  ];
  const head = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c.label;
    head.append(th);
  }
  table.append(head);
  for (const r of rows) {
    const tr = document.createElement('tr');
    const share = shareOf(r);
    const cells = {
      name: r.isBot ? `🤖 ${r.name}` : r.name,
      moveMs: formatMinsSecs(r.moveMs),
      // Pooled over every move, unlike the share column: seconds-per-move is
      // an absolute pace, so each move should count once regardless of which
      // game it was in.
      perMove: r.moves > 0 ? (r.moveMs / r.moves / 1000).toFixed(1) : '—',
      share: share == null ? '—' : `${Math.round(share * 100)}%`,
    };
    for (const c of columns) {
      const td = document.createElement('td');
      td.textContent = cells[c.key] ?? String(r[c.key] ?? 0);
      tr.append(td);
    }
    table.append(tr);
  }
  return table;
}

function renderGameStats(stats) {
  const box = document.createElement('div');
  box.className = 'stats-block';
  const title = document.createElement('div');
  title.className = 'stats-title';
  title.textContent = stats.durationMs != null
    ? `Player stats — game length ${formatMinsSecs(stats.durationMs)}`
    : 'Player stats';
  box.append(title, statsTable(stats.players, {
    shareLabel: '% of game time',
    shareOf: (r) => r.timeShare,
  }));
  return box;
}

const statsSection = document.getElementById('stats-section');
const statsPlayersSelect = document.getElementById('stats-players');
const statsVariantSelect = document.getElementById('stats-variant');
const statsPeopleList = document.getElementById('stats-people-list');
const statsFromInput = document.getElementById('stats-from');
const statsToInput = document.getElementById('stats-to');
// Names that must all appear in a game for it to count ("3-player games with
// Ann, Bob and Cid" = this plus the player-count filter).
let statsWithPlayers = new Set();
const statsTagsList = document.getElementById('stats-tags-list');
// 'any' (no tag filter), 'none' (untagged games only), or a set of tags a game
// must carry at least one of.
let statsTagMode = 'any';
let statsTags = new Set();

function requestStats() {
  send({
    type: 'statsSummary',
    players: Number(statsPlayersSelect.value) || null,
    variantId: statsVariantSelect.value || null,
    withPlayers: [...statsWithPlayers],
    from: statsFromInput.value || null,
    to: statsToInput.value || null,
    tags: statsTagMode === 'some' ? [...statsTags] : [],
    untaggedOnly: statsTagMode === 'none',
  });
}

statsSection.addEventListener('toggle', () => {
  if (statsSection.open) requestStats();
});
statsPlayersSelect.addEventListener('change', requestStats);
statsVariantSelect.addEventListener('change', requestStats);
statsFromInput.addEventListener('change', requestStats);
statsToInput.addEventListener('change', requestStats);
document.getElementById('stats-dates-clear').addEventListener('click', () => {
  statsFromInput.value = '';
  statsToInput.value = '';
  requestStats();
});

// Keep a select's options in sync with what the saves actually offer, without
// losing the current choice (the user may have picked before the reply).
function syncFilterOptions(select, values, label) {
  const wanted = ['', ...values.map(String)];
  const have = [...select.options].map((o) => o.value);
  if (wanted.length === have.length && wanted.every((v, i) => v === have[i])) return;
  const current = select.value;
  select.innerHTML = '';
  for (const v of wanted) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v === '' ? 'All' : label(v);
    select.append(opt);
  }
  select.value = wanted.includes(current) ? current : '';
}

// One toggle per name that has ever played. Re-rendered on every reply, so a
// name is never offered that no save contains.
function renderPeopleFilter(names) {
  const stale = [...statsWithPlayers].filter((n) => !names.includes(n));
  for (const n of stale) statsWithPlayers.delete(n);
  statsPeopleList.innerHTML = '';
  for (const name of names) {
    const label = document.createElement('label');
    label.className = 'stats-person' + (statsWithPlayers.has(name) ? ' on' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = statsWithPlayers.has(name);
    box.addEventListener('change', () => {
      if (box.checked) statsWithPlayers.add(name);
      else statsWithPlayers.delete(name);
      requestStats();
    });
    label.append(box, name);
    statsPeopleList.append(label);
  }
}

// "Any tag" (the default) and "No tags" are exclusive with picking tags; a
// game matches a picked set if it carries any one of them.
function renderTagFilter(tags) {
  const known = new Set(tags.map((t) => t.tag));
  for (const t of [...statsTags]) if (!known.has(t)) statsTags.delete(t);
  if (statsTagMode === 'some' && statsTags.size === 0) statsTagMode = 'any';
  statsTagsList.innerHTML = '';

  const addMode = (mode, label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stats-person stats-tag-mode' + (statsTagMode === mode ? ' on' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (statsTagMode === mode) return;
      statsTagMode = mode;
      statsTags.clear();
      requestStats();
    });
    statsTagsList.append(btn);
  };
  addMode('any', 'Any tag');
  addMode('none', 'No tags');

  for (const { tag, count } of tags) {
    const label = document.createElement('label');
    const on = statsTagMode === 'some' && statsTags.has(tag);
    label.className = 'stats-person' + (on ? ' on' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.addEventListener('change', () => {
      if (box.checked) statsTags.add(tag);
      else statsTags.delete(tag);
      statsTagMode = statsTags.size ? 'some' : 'any';
      requestStats();
    });
    const count_ = document.createElement('span');
    count_.className = 'stats-tag-count';
    count_.textContent = count;
    label.append(box, tag, count_);
    statsTagsList.append(label);
  }
  if (tags.length === 0) {
    const none = document.createElement('span');
    none.className = 'lobby-empty';
    none.textContent = 'no tagged games yet';
    statsTagsList.append(none);
  }
}

function renderStatsView(msg) {
  syncFilterOptions(statsPlayersSelect, msg.available.playerCounts, (v) => `${v} players`);
  syncFilterOptions(statsVariantSelect, msg.available.variantIds, (v) => v);
  renderPeopleFilter(msg.available.playerNames || []);
  renderTagFilter(msg.available.tags || []);
  // Bound the pickers to the span the library actually covers.
  for (const input of [statsFromInput, statsToInput]) {
    input.min = msg.available.firstDay || '';
    input.max = msg.available.lastDay || '';
  }
  document.getElementById('stats-scope').textContent =
    `${msg.gamesMatched} of ${msg.gamesTotal} saved games`;
  const box = document.getElementById('stats-table');
  box.innerHTML = '';
  const summary = msg.summary;
  if (!summary.players.length) {
    const empty = document.createElement('div');
    empty.className = 'lobby-empty';
    empty.textContent = 'No games match this filter.';
    box.append(empty);
    return;
  }
  // Not a share of the summed time: each game contributes its own share and
  // they're averaged, so a long game doesn't outweigh a short one.
  box.append(statsTable(summary.players, {
    extraColumns: [{ key: 'games', label: 'Games' }],
    shareLabel: 'Per game % time (avg)',
    shareOf: (r) => r.timeShareAvg,
  }));
}

// --- Game info: everything about one saved game, in a modal. Opened by
// clicking a library row; the server assembles it (`gameDetail`) so the lobby
// broadcast doesn't have to carry per-game stats for the whole library.

const detailModal = document.getElementById('game-detail-modal');
const detailContent = document.getElementById('game-detail-content');
const detailActions = document.getElementById('game-detail-actions');
const detailTitle = document.getElementById('game-detail-title');
const detailBackBtn = document.getElementById('game-detail-back');
// The file whose detail we're waiting for / showing, plus the trail of games we
// arrived through (following a same-deck link), so ← walks back.
let detailFile = null;
let detailTrail = [];
// Set when we changed something the detail shows (tags) and are waiting for the
// server's own confirmation — the lobby broadcast — before re-reading it.
let detailRefreshOnSync = false;

// Entry point (a library row): a fresh visit, so the back trail starts empty.
function openGameDetail(file) {
  detailTrail = [];
  loadGameDetail(file);
}

function loadGameDetail(file) {
  detailFile = file;
  detailModal.hidden = false;
  detailBackBtn.hidden = detailTrail.length === 0;
  detailTitle.textContent = 'Game';
  detailActions.innerHTML = '';
  detailContent.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'lobby-empty';
  loading.textContent = 'Loading…';
  detailContent.append(loading);
  send({ type: 'gameDetail', file });
}

function closeGameDetail() {
  detailModal.hidden = true;
  detailFile = null;
  detailTrail = [];
  detailRefreshOnSync = false;
}

detailBackBtn.addEventListener('click', () => {
  const prev = detailTrail.pop();
  if (prev) loadGameDetail(prev);
  else closeGameDetail();
});
document.getElementById('game-detail-close').addEventListener('click', closeGameDetail);
detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) closeGameDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !detailModal.hidden) closeGameDetail();
});

function onGameDetailView(detail) {
  if (!detail || detail.basename !== detailFile) return; // stale response
  renderGameDetail(detail);
}

// The signed gap on its own, coloured: green when the bots came out ahead of
// the table, red when they fell short, grey on a tie. Only the number is
// coloured — the words around it are label, not signal.
function parDeltaNumber(delta) {
  const n = document.createElement('span');
  n.className = 'par-delta ' + (delta > 0 ? 'par-up' : delta < 0 ? 'par-down' : 'par-even');
  n.textContent = `${delta > 0 ? '+' : ''}${delta}`;
  return n;
}

// The par as the eye reads it in a list: not the bots' absolute score but the
// gap, read from the bots' side — "[all bots score +2]" says a bench of bots
// took two more points off this deck than the players did.
function parDeltaChip(par, score) {
  const el = document.createElement('span');
  // The bracketed words are label and sit at the same weight as whatever line
  // they're in; only the number is meant to catch the eye. They're a sibling
  // span rather than a wrapper because opacity multiplies down a subtree — a
  // child cannot undo a parent's dimming.
  const open = document.createElement('span');
  open.className = 'par-chip-label';
  open.textContent = '[all bots score ';
  const close = document.createElement('span');
  close.className = 'par-chip-label';
  close.textContent = ']';
  el.append(open, parDeltaNumber(par.score - score), close);
  return el;
}

// The same gap said the other way round — from the table's side, where a plus
// means the players came out ahead. Deliberately UNcoloured: the chip's green
// means "the bots did better", and this number's plus means the opposite, so
// carrying the colour across would have one hue mean two things.
function vsAllBots(delta) {
  return [` — you ${delta === 0 ? 'matched' : `${delta > 0 ? '+' : ''}${delta} vs`} all bots score`];
}

// "24/30" plus the fine print — which brain produced it and how its game ended.
// The version here is the brain that SIMULATED the par — always the current
// one, since a stale entry is recomputed on demand — never the brain that
// played the game. On a game from months ago the two differ, so the wording
// has to say which it is.
function parNote(par) {
  const bits = [`scored by bot ${par.version}`];
  if (par.endReason) bits.push(par.endReason);
  if (par.misplays) bits.push(`${par.misplays} misplay${par.misplays === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

function factRow(label, value) {
  const row = document.createElement('div');
  row.className = 'detail-fact';
  const l = document.createElement('span');
  l.className = 'detail-fact-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'detail-fact-value';
  if (value instanceof Node) v.append(value);
  else v.textContent = value;
  row.append(l, v);
  return row;
}

function renderGameDetail(d) {
  detailTitle.textContent = d.startedAt ? new Date(d.startedAt).toLocaleString() : d.basename;
  detailContent.innerHTML = '';

  const facts = document.createElement('div');
  facts.className = 'detail-facts';
  const inProgress = d.status === 'in-progress';
  facts.append(factRow('Result', inProgress
    ? `in progress — ${d.score}/${d.maxScore} so far, ${d.moves} moves`
    : `${d.status} — ${d.score}/${d.maxScore}`));
  facts.append(factRow('Players', joinPlayerNames(d.playerNames, d.playerBots, d.playerBotVersions)));
  facts.append(factRow('Game type', `${d.variantId} · ${d.endRule} end rule` +
    (d.allowEmptyHints ? ' · empty hints allowed' : '') +
    (d.shareGuarded ? ' · guards shared' : '')));
  facts.append(factRow('Moves', `${d.moves}` + (d.misplays ? ` · ${d.misplays} misplay${d.misplays === 1 ? '' : 's'}` : '')));
  if (d.stats?.durationMs != null) facts.append(factRow('Length', formatMinsSecs(d.stats.durationMs)));

  // Par: the same deck, played by a table of bots. It says whether the score
  // was the deck's doing or the players'.
  if (d.botScore) {
    const par = document.createElement('span');
    par.textContent = `🤖 ${d.botScore.score}/${d.botScore.maxScore}`;
    if (!inProgress) par.append(...vsAllBots(d.score - d.botScore.score));
    const note = document.createElement('span');
    note.className = 'detail-par-note';
    note.textContent = ` (${parNote(d.botScore)})`;
    par.append(note);
    facts.append(factRow('Bots on this deck', par));
  } else if (!inProgress) {
    facts.append(factRow('Bots on this deck', 'not computed'));
  }
  if (d.seed != null) facts.append(factRow('Seed', String(d.seed)));
  facts.append(factRow('File', d.basename));
  if (d.tags?.length) {
    const tagsEl = document.createElement('span');
    tagsEl.className = 'save-tags';
    for (const t of d.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = t;
      tagsEl.append(chip);
    }
    facts.append(factRow('Tags', tagsEl));
  }
  detailContent.append(facts);

  if (d.stats) detailContent.append(renderGameStats(d.stats));

  // Other games dealt from the same deck — the point of pasting a seed back
  // into the lobby. Finished games only (see the server's gameDetail).
  if (d.sameDeck?.length) {
    const same = document.createElement('div');
    same.className = 'detail-section';
    const h = document.createElement('div');
    h.className = 'stats-title';
    h.textContent = `Same deck (${d.sameDeck.length} other game${d.sameDeck.length === 1 ? '' : 's'})`;
    same.append(h);
    for (const s of d.sameDeck) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'detail-deck-row';
      const when = document.createElement('span');
      when.className = 'detail-deck-when';
      when.textContent = s.startedAt ? new Date(s.startedAt).toLocaleString() : s.basename;
      const res = document.createElement('span');
      res.className = 'detail-deck-score';
      res.textContent = `${s.score}/${s.maxScore}`;
      if (s.botScore) res.append(' ', parDeltaChip(s.botScore, s.score));
      const who = document.createElement('span');
      who.className = 'detail-deck-who';
      who.textContent = joinPlayerNames(s.playerNames, s.playerBots, s.playerBotVersions);
      row.append(when, res, who);
      row.addEventListener('click', () => {
        detailTrail.push(d.basename);
        loadGameDetail(s.basename);
      });
      same.append(row);
    }
    detailContent.append(same);
  }

  detailActions.innerHTML = '';
  const replayBtn = document.createElement('button');
  replayBtn.type = 'button';
  replayBtn.textContent = 'Review';
  replayBtn.title = 'Step through this game move by move, with every hand visible';
  replayBtn.addEventListener('click', () => {
    const file = d.basename;
    closeGameDetail();
    openReplay(file);
  });
  detailActions.append(replayBtn);
  if (d.seed != null) {
    const seedBtn = document.createElement('button');
    seedBtn.type = 'button';
    seedBtn.textContent = 'Copy seed';
    seedBtn.addEventListener('click', async () => {
      const done = await copyText(String(d.seed));
      statusEl.textContent = done ? `seed ${d.seed} copied` : `seed: ${d.seed}`;
      setTimeout(() => { statusEl.textContent = 'connected'; }, 2500);
    });
    detailActions.append(seedBtn);
  }
  const tagBtn = document.createElement('button');
  tagBtn.type = 'button';
  tagBtn.textContent = 'Tags';
  tagBtn.addEventListener('click', () => {
    const next = prompt('Tags (comma-separated):', (d.tags || []).join(', '));
    if (next == null) return;
    send({ type: 'tagSave', file: d.basename, tags: next.split(',').map((t) => t.trim()).filter(Boolean) });
    // The lobby re-broadcast doesn't carry the detail, so re-ask for it — but
    // only once that broadcast lands, since it's what tells us the tags have
    // actually been written (asking straight away can race the write).
    detailRefreshOnSync = true;
  });
  detailActions.append(tagBtn);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeGameDetail);
  detailActions.append(closeBtn);
}

// Shared by both the player and spectator header branches: leaving clears
// every bit of persisted room identity, including whether we were spectating
// (otherwise the next reconnect would try to spectateRoom into thin air).
function leaveRoomAndClearState() {
  roomId = null;
  playerId = null;
  isSpectating = false;
  localStorage.removeItem(ROOM_KEY);
  localStorage.removeItem(PLAYER_KEY);
  localStorage.removeItem(SPECTATE_KEY);
  send({ type: 'leaveRoom' });
}

// "👀 watching: …" — shown to everyone in the room (players and spectators
// alike), so nobody is being watched without knowing it.
function appendSpectatorsList(meEl, v) {
  const specs = v.spectators || [];
  if (specs.length === 0) return;
  const el = document.createElement('span');
  el.className = 'header-spectators';
  el.textContent = ` · 👀 watching: ${specs.map((s) => s.name).join(', ')}`;
  meEl.append(el);
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
  if (view?.isSpectator) {
    const mySpec = (view.spectators || []).find((s) => s.id === playerId);
    meEl.hidden = false;
    meEl.textContent = `spectating as ${mySpec?.name || savedName}`;
    if (view.kind === 'in-room' && view.roomName) {
      const roomLabel = document.createElement('span');
      roomLabel.className = 'header-room';
      roomLabel.textContent = ` · in ${view.roomName}`;
      meEl.append(roomLabel);
    }
    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.textContent = 'leave room';
    leaveBtn.addEventListener('click', leaveRoomAndClearState);
    meEl.append(' ', leaveBtn);
    appendSpectatorsList(meEl, view);
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
    leaveBtn.addEventListener('click', leaveRoomAndClearState);
    meEl.append(' ', leaveBtn);
    appendSpectatorsList(meEl, view);
  }
}

function show(screen) {
  for (const s of [joinScreen, serverLobbyScreen, lobbyScreen, gameScreen]) {
    s.hidden = s !== screen;
  }
}

// A ⚙️ panel of a bot's toggleable convention options. Native <details> so it
// collapses/expands without extra state; open state is mirrored into
// openBotOptions so it persists across the re-render each toggle triggers.
function renderBotOptions(p) {
  const det = document.createElement('details');
  det.className = 'bot-options';
  det.open = openBotOptions.has(p.id);
  det.addEventListener('toggle', () => {
    if (det.open) openBotOptions.add(p.id);
    else openBotOptions.delete(p.id);
  });
  const sum = document.createElement('summary');
  sum.textContent = '⚙️';
  sum.title = 'Bot conventions';
  det.append(sum);
  const panel = document.createElement('div');
  panel.className = 'bot-options-panel';
  const title = document.createElement('div');
  title.className = 'bot-options-title';
  title.textContent = 'Conventions';
  panel.append(title);
  const opts = p.botOptions || {};
  for (const [key, text, description] of BOT_OPTION_LABELS) {
    const item = document.createElement('div');
    item.className = 'bot-option-item';
    const row = document.createElement('label');
    row.className = 'bot-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!opts[key];
    cb.addEventListener('change', () => {
      send({ type: 'configureBot', playerId: p.id, options: { [key]: cb.checked } });
    });
    row.append(cb, document.createTextNode(' ' + text));
    item.append(row);
    const desc = document.createElement('div');
    desc.className = 'bot-option-desc';
    desc.textContent = description;
    item.append(desc);
    panel.append(item);
  }
  det.append(panel);
  return det;
}

// How long the room's bots pause before moving. Auto is 1.2s with a single
// bot and 4s from two upward — bots play back-to-back, and at the solo pace a
// bench of them blurs past faster than anyone can read the table. Manual holds
// each bot turn until someone presses Play now.
const BOT_PACE_CHOICES = [
  ['auto', 'Auto'],
  ['500', '0.5s'],
  ['1200', '1.2s'],
  ['2000', '2s'],
  ['4000', '4s'],
  ['6000', '6s'],
  ['10000', '10s'],
  ['manual', 'Manual'],
];

// The pace picker, shared by the lobby and the game screen. Returns null when
// there's nothing to pace (no bots) or nobody who may set it (spectators,
// replays).
function botPaceControl(v) {
  if (!v.hasBots || v.kind !== 'in-room' || v.isSpectator) return null;
  const wrap = document.createElement('label');
  wrap.className = 'meta-item meta-select';
  const label = document.createElement('strong');
  label.textContent = 'Bot pace';
  wrap.append(label);
  const sel = document.createElement('select');
  const current = v.botPaceMs == null ? 'auto' : String(v.botPaceMs);
  // The server accepts any millisecond value, so a pace set outside this list
  // still has to be selectable — otherwise the picker would quietly show Auto
  // while the room ran on something else.
  const choices = BOT_PACE_CHOICES.some(([value]) => value === current)
    ? BOT_PACE_CHOICES
    : [...BOT_PACE_CHOICES, [current, `${Number(current) / 1000}s`]];
  for (const [value, text] of choices) {
    const opt = document.createElement('option');
    opt.value = value;
    // Auto reads as "auto", but say what it currently comes to — the number
    // is what the reader is actually asking about.
    opt.textContent = value === 'auto' && v.botDelayMs != null
      ? `Auto (${(v.botDelayMs / 1000).toFixed(1).replace(/\.0$/, '')}s)`
      : text;
    if (value === current) opt.selected = true;
    sel.append(opt);
  }
  sel.title = 'How long each bot waits before taking its turn';
  sel.addEventListener('change', () => {
    const val = sel.value;
    send({ type: 'botPace', pace: val === 'auto' || val === 'manual' ? val : Number(val) });
  });
  wrap.append(sel);
  return wrap;
}

// Is the seat on turn a bot we may release? One predicate for the Play now
// button and its keyboard shortcut, so the two can't come to disagree about
// when the release is on offer.
function botOnTurnReleasable() {
  const v = view;
  if (!v || v.kind !== 'in-room' || v.status !== 'playing' || v.isSpectator) return false;
  return !!v.players?.[v.currentPlayer]?.isBot;
}

// "p" is the keyboard twin of Play now, and it's what makes the Manual pace
// comfortable: a bench of bots steps forward one turn per keypress, with no
// hunting for a button that moves down the table between turns. Ignored while
// typing (the note box, a name field) or with a modifier held, so text editing
// and browser shortcuts keep working.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'p' && e.key !== 'P') return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!botOnTurnReleasable()) return;
  e.preventDefault();
  send({ type: 'botNow' });
});

function renderLobby() {
  const listEl = document.getElementById('lobby-players');
  listEl.innerHTML = '';
  const isHost = view.hostId === playerId;
  const isSpectator = !!view.isSpectator;
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
    label.textContent = `${i + 1}. ${p.isBot ? '🤖 ' : ''}${p.name}` +
      `${p.isBot && p.botVersion ? ` (${p.botVersion})` : ''} [${p.id}]${tagStr}`;
    li.append(label);
    if (p.isBot && !isSpectator) {
      // Anyone seated may configure or remove a bot — spectators aren't seated.
      li.append(renderBotOptions(p));
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
  const specsEl = document.getElementById('lobby-spectators');
  const specs = view.spectators || [];
  specsEl.hidden = specs.length === 0;
  specsEl.textContent = specs.length ? `Watching: ${specs.map((s) => s.name).join(', ')}` : '';
  const addBotBtn = document.getElementById('add-bot-button');
  addBotBtn.hidden = isSpectator;
  const slotsFree = view.botSlotsFree ?? 0;
  addBotBtn.disabled = view.players.length >= 5 || slotsFree <= 0;
  addBotBtn.textContent = slotsFree > 0
    ? '+ Add bot'
    : '+ Add bot (server bot limit reached)';
  const paceEl = document.getElementById('lobby-bot-pace');
  paceEl.innerHTML = '';
  const pace = botPaceControl(view);
  paceEl.hidden = !pace;
  if (pace) paceEl.append(pace);
  document.getElementById('opt-variant').disabled = !isHost;
  document.getElementById('opt-endRule').disabled = !isHost;
  document.getElementById('opt-shareGuarded').disabled = !isHost;
  document.getElementById('opt-allowEmptyHints').disabled = !isHost;
  document.getElementById('opt-allowSpectators').disabled = !isHost;
  document.getElementById('start-button').disabled = !isHost || view.players.length < 2;
  document.getElementById('opt-variant').value = view.options.variantId;
  document.getElementById('opt-endRule').value = view.options.endRule;
  document.getElementById('opt-shareGuarded').checked = view.options.shareGuarded;
  document.getElementById('opt-allowEmptyHints').checked = view.options.allowEmptyHints;
  document.getElementById('opt-allowSpectators').checked = view.options.allowSpectators;
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
  // Reactions are a player-to-player thing; spectators (and replay, which
  // never sets isSpectator either) watch without joining in.
  document.getElementById('reaction-bar').hidden = v.kind !== 'in-room' || !!v.isSpectator;
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

  const paceItem = botPaceControl(v);
  if (paceItem) meta.append(paceItem);

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
    // In a replay we hold no seat, so the server can only find the game by
    // file; in a live room the seat is what identifies it.
    exportBtn.addEventListener('click', () => send(
      replay ? { type: 'exportDeck', file: replay.file } : { type: 'exportDeck' },
    ));
    actions.append(exportBtn);

    banner.append(actions);
    // Par for this deck: the same cards, played out by a table of bots. It's
    // the context the bare score lacks — 22/25 means one thing on a deck the
    // bots take 25 from and another on one they can only get 20 out of.
    if (v.botScore) {
      const par = document.createElement('div');
      par.className = 'banner-par';
      par.textContent = `🤖 Bots on this deck: ${v.botScore.score}/${v.botScore.maxScore}`;
      par.append(...vsAllBots(v.score - v.botScore.score), ` (${parNote(v.botScore)})`);
      banner.append(par);
    }
    if (v.stats) banner.append(renderGameStats(v.stats));
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
  // Draws are implied by the play/discard above them — and when no card comes
  // (empty deck) the shrinking hand shows it — so they'd only pad the log.
  // The entries stay in the state; this is purely what we render.
  for (const e of v.log.slice().reverse().filter((e) => e.type !== 'draw')) {
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
    // Recorded reasoning (bot's decision logic, or a human's note) — the
    // server only sends it on replays and finished games.
    if (e.reasoning) {
      const why = document.createElement('div');
      why.className = 'log-reasoning';
      why.textContent = `“${e.reasoning}”`;
      div.append(why);
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
  if (v.status === 'playing' && v.abandonVotes && !v.isSpectator) {
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
    // A bot on turn is waiting out its pace (or, on Manual, waiting for this
    // button). Anyone at the table may release it — it only brings forward a
    // move the bot was going to make anyway.
    if (player.isBot && botOnTurnReleasable()) {
      const now = document.createElement('button');
      now.type = 'button';
      now.className = 'bot-now-button';
      now.textContent = '▶ Play now';
      now.title = 'Stop waiting and let this bot take its turn (shortcut: P)';
      now.addEventListener('click', () => send({ type: 'botNow' }));
      head.append(now);
    }
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
  if (e.reasoning) {
    const why = document.createElement('div');
    why.className = 'log-reasoning';
    why.textContent = `“${e.reasoning}”`;
    body.append(why);
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
