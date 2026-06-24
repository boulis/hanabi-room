import { WebSocket } from 'ws';

const URL = `ws://127.0.0.1:${process.env.PORT || 3999}`;

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const pending = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (waiters.length) waiters.shift()(msg);
      else pending.push(msg);
    });
    ws.on('open', () =>
      resolve({
        ws,
        recv: () =>
          pending.length
            ? Promise.resolve(pending.shift())
            : new Promise((r) => waiters.push(r)),
      }),
    );
    ws.on('error', reject);
  });
}

function send(client, payload) {
  client.ws.send(JSON.stringify(payload));
}

async function recvOf(client, type, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msg = await Promise.race([
      client.recv(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs - (Date.now() - start) + 50)),
    ]);
    if (msg.type === type) return msg;
    if (msg.type === 'error') throw new Error(`server error: ${msg.code} ${msg.error}`);
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function recvSyncWhere(client, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msg = await Promise.race([
      client.recv(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sync wait timeout')), timeoutMs - (Date.now() - start) + 50)),
    ]);
    if (msg.type === 'sync') {
      let matched = false;
      try { matched = predicate(msg.view); } catch { matched = false; }
      if (matched) return msg.view;
    }
    if (msg.type === 'error') throw new Error(`server error: ${msg.code} ${msg.error}`);
  }
  throw new Error('Timed out waiting for matching sync');
}

async function main() {
  const a = await open();
  const b = await open();

  await recvOf(a, 'hello');
  await recvOf(b, 'hello');

  send(a, { type: 'join', name: 'Alice' });
  await recvOf(a, 'identity');
  send(b, { type: 'join', name: 'Bob' });
  await recvOf(b, 'identity');

  await recvSyncWhere(a, (v) => v.status === 'lobby' && v.players.length === 2);

  send(a, { type: 'configure', options: { variantId: 'rainbow', endRule: 'standard', shareGuarded: true } });
  send(a, { type: 'start', seed: 42 });

  const aView0 = await recvSyncWhere(a, (v) => v.status === 'playing');
  console.log('Game started. Alice viewerIndex:', aView0.viewerIndex);

  const bobHand = aView0.players[1].hand;
  console.log('Bob hand (as seen by Alice):', bobHand.map((c) => `${c.color}-${c.number}`).join(', '));

  // Hint Bob using a number that exists in his hand
  const knownNumber = bobHand[0].number;
  send(a, { type: 'action', action: { type: 'hint', toPlayerIndex: 1, hintType: 'number', value: knownNumber } });
  const v1 = await recvSyncWhere(a, (v) => v.turn === 1);
  console.log(`After hint number=${knownNumber}: hintTokens=${v1.hintTokens}, currentPlayer=${v1.currentPlayer}`);
  if (v1.hintTokens !== 7) throw new Error('expected 7 hint tokens after hint');

  // Bob plays card 0
  send(b, { type: 'action', action: { type: 'play', cardIndex: 0 } });
  const v2a = await recvSyncWhere(a, (v) => v.turn === 2);
  console.log(`After Bob plays card 0: score=${v2a.score} fuses=${v2a.fuseTokens}`);

  // Visibility: Alice's own card has no color/number; Bob's cards do (seen by Alice)
  const aliceOwn = v2a.players[v2a.viewerIndex].hand[0];
  if (aliceOwn.color !== undefined) throw new Error('Own color should be undefined');
  const aliceSeesBob = v2a.players[1].hand[0];
  if (!aliceSeesBob.color) throw new Error('Alice should see Bob colors');
  console.log('Visibility check passed');

  // Annotate Alice's first card with guarded=true and a private note. With
  // shareGuarded=true Bob should see the guarded flag, but the note stays private.
  console.log('viewer index:', v2a.viewerIndex, 'hand length:', v2a.players[v2a.viewerIndex].hand.length);
  const aliceCardId = v2a.players[v2a.viewerIndex].hand[0].id;
  send(a, {
    type: 'action',
    action: { type: 'annotate', cardId: aliceCardId, guarded: true, note: 'guess' },
  });
  await recvSyncWhere(a, (v) => v.players[v.viewerIndex].hand[0].annotations?.note === 'guess');
  const bGuarded = await recvSyncWhere(b, (v) => v.players[0].hand[0]?.annotations?.guarded === true);
  if (bGuarded.players[0].hand[0].annotations.note !== undefined) {
    throw new Error('Bob should not see the private note');
  }
  console.log('Shared guarded flag visible across players; note remains private');

  console.log('\nALL SMOKE CHECKS PASSED');
  a.ws.close();
  b.ws.close();
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
