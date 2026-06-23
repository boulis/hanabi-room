const statusEl = document.getElementById('status');
const joinScreen = document.getElementById('join-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');

const PLAYER_KEY = 'hanabi-room.playerId';
const NAME_KEY = 'hanabi-room.name';
nameInput.value = localStorage.getItem(NAME_KEY) || '';

let ws = null;
let playerId = localStorage.getItem(PLAYER_KEY) || null;
let view = null;

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    statusEl.textContent = 'connected';
    if (playerId && nameInput.value) {
      send({ type: 'join', name: nameInput.value, playerId });
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
      break;
    case 'sync':
      view = msg.view;
      render();
      break;
    case 'error':
      console.warn('server error:', msg.code, msg.error);
      flashError(msg.error);
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
  send({ type: 'join', name, playerId });
});

document.getElementById('opt-variant').addEventListener('change', (e) => {
  send({ type: 'configure', options: { variantId: e.target.value } });
});
document.getElementById('opt-endRule').addEventListener('change', (e) => {
  send({ type: 'configure', options: { endRule: e.target.value } });
});
document.getElementById('opt-shareAnnotations').addEventListener('change', (e) => {
  send({ type: 'configure', options: { shareAnnotations: e.target.checked } });
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
document.getElementById('new-game-button').addEventListener('click', () => {
  send({ type: 'start', seed: readSeedInput() });
});
document.getElementById('abandon-button').addEventListener('click', () => {
  send({ type: 'abandon' });
});

function render() {
  if (!view) return;
  if (!playerId) {
    show(joinScreen);
    return;
  }
  if (view.status === 'lobby') {
    show(lobbyScreen);
    renderLobby();
  } else {
    show(gameScreen);
    renderGame();
  }
}

function show(screen) {
  for (const s of [joinScreen, lobbyScreen, gameScreen]) {
    s.hidden = s !== screen;
  }
}

function renderLobby() {
  const listEl = document.getElementById('lobby-players');
  listEl.innerHTML = '';
  for (const p of view.players) {
    const li = document.createElement('div');
    li.textContent = `${p.name}${p.id === view.hostId ? ' (host)' : ''}${p.online ? '' : ' (offline)'}`;
    listEl.append(li);
  }
  const isHost = view.hostId === playerId;
  document.getElementById('opt-variant').disabled = !isHost;
  document.getElementById('opt-endRule').disabled = !isHost;
  document.getElementById('opt-shareAnnotations').disabled = !isHost;
  document.getElementById('opt-allowEmptyHints').disabled = !isHost;
  document.getElementById('start-button').disabled = !isHost || view.players.length < 2;
  document.getElementById('opt-variant').value = view.options.variantId;
  document.getElementById('opt-endRule').value = view.options.endRule;
  document.getElementById('opt-shareAnnotations').checked = view.options.shareAnnotations;
  document.getElementById('opt-allowEmptyHints').checked = view.options.allowEmptyHints;
}

function renderGame() {
  const v = view;
  const meta = document.getElementById('game-meta');
  meta.innerHTML = '';
  const items = [
    ['Variant', v.variantName],
    ['Turn', v.turn],
    ['Score', `${v.score} / ${v.maxScore}`],
    ['Hint tokens', `${v.hintTokens} / 8`],
    ['Fuse tokens', `${v.fuseTokens} / 3`],
    ['Deck', `${v.deckSize} cards`],
    ['End rule', v.endRule],
    ['Annotations', v.shareAnnotations ? 'shared' : 'private'],
  ];
  for (const [k, val] of items) {
    const div = document.createElement('div');
    div.className = 'meta-item';
    div.innerHTML = `<strong>${k}</strong>${val}`;
    meta.append(div);
  }

  if (v.status === 'finished') {
    const banner = document.createElement('div');
    banner.className = 'banner ' + (v.endReason === 'perfect' ? 'win' : v.endReason === 'fuses' ? 'loss' : '');
    const seedText = v.seed != null ? `  seed: ${v.seed}` : '';
    banner.textContent = `Game over — ${v.endReason}. Final score: ${v.score}/${v.maxScore}.${seedText}`;
    meta.append(banner);
  }

  const piles = document.getElementById('game-piles');
  piles.innerHTML = '';
  const discardsByColor = Object.fromEntries(v.suits.map((s) => [s.color, []]));
  for (const c of v.discard) discardsByColor[c.color].push(c.number);
  for (const color of Object.keys(discardsByColor)) {
    discardsByColor[color].sort((a, b) => a - b);
  }
  for (const suit of v.suits) {
    const p = v.playedPiles[suit.color];
    const column = document.createElement('div');
    column.className = 'pile-column';

    const pile = document.createElement('div');
    pile.className = 'pile';
    pile.dataset.color = suit.color;
    pile.dataset.direction = suit.direction;
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
    piles.append(column);
  }

  const hands = document.getElementById('game-hands');
  hands.innerHTML = '';
  const isMyTurn = v.currentPlayer === v.viewerIndex && v.status === 'playing';
  for (let i = 0; i < v.players.length; i++) {
    hands.append(renderPlayerRow(v.players[i], i, isMyTurn));
  }

  const log = document.getElementById('game-log');
  log.innerHTML = '';
  for (const e of v.log.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = formatLog(e);
    log.append(div);
  }

  renderDiscard();
  const newGameBtn = document.getElementById('new-game-button');
  newGameBtn.hidden = !(v.hostId === playerId && v.status === 'finished');
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
  name.textContent = player.name + (index === view.viewerIndex ? ' (you)' : '');
  head.append(name);
  if (index === view.currentPlayer && view.status === 'playing') {
    const marker = document.createElement('span');
    marker.className = 'turn-marker';
    marker.textContent = 'turn';
    head.append(marker);
  }
  row.append(head);

  const hand = document.createElement('div');
  hand.className = 'hand';
  player.hand.forEach((card, cardIndex) => {
    hand.append(renderCard(card, index, cardIndex, isMyTurn));
  });
  row.append(hand);

  if (isMyTurn && index !== view.viewerIndex && player.hand.length > 0) {
    row.append(renderHintControls(index));
  }
  return row;
}

function deriveCardDisplay(card, view) {
  const isMine = card.color === undefined;
  const nonBlackColorCount = view.suits.filter((s) => s.color !== 'black').length;
  const visibleColors = card.possibleColors.filter((c) => c !== 'black');

  if (isMine) {
    let knownColor = null;
    if (card.possibleColors.length === 1 && card.possibleColors[0] === 'black') {
      knownColor = 'black';
    } else if (visibleColors.length === 1) {
      knownColor = visibleColors[0];
    }
    const knownNumber = card.possibleNumbers.length === 1 ? card.possibleNumbers[0] : null;
    let possibleColorList = null;
    if (!knownColor && visibleColors.length < nonBlackColorCount) {
      possibleColorList = visibleColors;
    }
    let possibleNumberList = null;
    if (!knownNumber && card.possibleNumbers.length < 5) {
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
  const noInfo = colorsAllOpen && numbersAllOpen;
  return {
    faceColor: card.color,
    faceNumber: card.number,
    possibleColorList: noInfo ? null : visibleColors,
    possibleNumberList: noInfo ? null : card.possibleNumbers,
    noInfo,
  };
}

function renderCard(card, ownerIndex, cardIndex, isMyTurn) {
  const isMine = ownerIndex === view.viewerIndex;
  const { faceColor, faceNumber, possibleColorList, possibleNumberList, noInfo } = deriveCardDisplay(card, view);
  const el = document.createElement('div');
  el.className = 'card';
  if (!faceColor && !faceNumber) el.classList.add('face-down');
  if (faceColor) el.dataset.color = faceColor;
  if (card.colorClued || card.numberClued) el.classList.add('clued');
  if (card.colorClued) el.classList.add('clued-color');
  if (card.numberClued) el.classList.add('clued-number');
  if (faceColor && faceNumber) {
    el.style.setProperty('--card-svg', `url('/cards/${faceColor}-${faceNumber}.svg')`);
    el.style.backgroundImage = 'var(--card-svg)';
  }

  const face = document.createElement('div');
  face.className = 'card-face';
  face.textContent = faceNumber != null ? String(faceNumber) : '';
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
  if (card.annotations && (card.annotations.manualColors.length || card.annotations.manualNumbers.length)) {
    const manual = renderPossible(card.annotations.manualColors, card.annotations.manualNumbers, true);
    if (manual) el.append(manual);
  }
  if (card.annotations?.note) {
    const note = document.createElement('div');
    note.className = 'card-note';
    note.textContent = `“${card.annotations.note}”`;
    el.append(note);
  }

  if (isMine && view.status === 'playing') {
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
  return el;
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

function renderDiscard() {
  const root = document.getElementById('game-discard');
  root.innerHTML = '<h3>Discard Order</h3>';
  const pile = document.createElement('div');
  pile.className = 'discard-pile';
  for (const c of view.discard) {
    const el = document.createElement('div');
    el.className = 'discard-card';
    el.style.background = `var(--color-${c.color})`;
    el.style.color = (c.color === 'yellow' || c.color === 'white') ? '#111' : '#fff';
    el.textContent = c.number;
    pile.append(el);
  }
  root.append(pile);
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
const annotateColorsRow = document.getElementById('annotate-colors');
const annotateNumbersRow = document.getElementById('annotate-numbers');
const annotateNoteInput = document.getElementById('annotate-note');
let annotatingCardId = null;
let annotatingColors = new Set();
let annotatingNumbers = new Set();

function openAnnotateModal(card) {
  annotatingCardId = card.id;
  annotatingColors = new Set(card.annotations?.manualColors ?? []);
  annotatingNumbers = new Set(card.annotations?.manualNumbers ?? []);
  annotateNoteInput.value = card.annotations?.note ?? '';
  annotateCardInfo.textContent = `Card you can see as: ${card.colorClued ? 'colour-clued' : 'no colour clue'}, ${card.numberClued ? 'number-clued' : 'no number clue'}`;
  annotateColorsRow.innerHTML = '';
  for (const color of [...new Set(view.suits.map((s) => s.color))]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toggle' + (annotatingColors.has(color) ? ' on' : '');
    b.style.borderColor = `var(--color-${color})`;
    b.textContent = color;
    b.addEventListener('click', () => {
      if (annotatingColors.has(color)) annotatingColors.delete(color);
      else annotatingColors.add(color);
      b.classList.toggle('on');
    });
    annotateColorsRow.append(b);
  }
  annotateNumbersRow.innerHTML = '';
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toggle' + (annotatingNumbers.has(n) ? ' on' : '');
    b.textContent = n;
    b.addEventListener('click', () => {
      if (annotatingNumbers.has(n)) annotatingNumbers.delete(n);
      else annotatingNumbers.add(n);
      b.classList.toggle('on');
    });
    annotateNumbersRow.append(b);
  }
  annotateModal.hidden = false;
}

document.getElementById('annotate-cancel').addEventListener('click', () => {
  annotateModal.hidden = true;
});

document.getElementById('annotate-save').addEventListener('click', () => {
  send({
    type: 'action',
    action: {
      type: 'annotate',
      cardId: annotatingCardId,
      manualColors: [...annotatingColors],
      manualNumbers: [...annotatingNumbers],
      note: annotateNoteInput.value,
    },
  });
  annotateModal.hidden = true;
});

connect();
