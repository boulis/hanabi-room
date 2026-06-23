import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from './game.js';
import { annotateAction, hintAction } from './rules.js';
import { viewState } from './view.js';

const PLAYERS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
];

function fresh(overrides = {}) {
  return createInitialState({ variantId: 'simple', players: PLAYERS, seed: 7, ...overrides });
}

test('viewState hides own card identity but shows constraints', () => {
  const s = fresh();
  const v = viewState(s, 0);
  const own = v.players[0].hand[0];
  assert.equal(own.color, undefined);
  assert.equal(own.number, undefined);
  assert.deepEqual(own.possibleColors.sort(), ['blue', 'green', 'red', 'white', 'yellow']);
  assert.deepEqual(own.possibleNumbers, [1, 2, 3, 4, 5]);
});

test('viewState reveals other players cards', () => {
  const s = fresh();
  const v = viewState(s, 0);
  const other = v.players[1].hand[0];
  assert.ok(typeof other.color === 'string');
  assert.ok(typeof other.number === 'number');
});

test('viewState shows annotations on own cards only by default', () => {
  const s = fresh();
  const cardId = s.players[1].hand[0].id;
  annotateAction(s, 1, cardId, { note: 'red two?' });
  const ownView = viewState(s, 1);
  assert.equal(ownView.players[1].hand[0].annotations.note, 'red two?');
  const otherView = viewState(s, 0);
  assert.equal(otherView.players[1].hand[0].annotations, undefined);
});

test('viewState shares annotations when shareAnnotations is true', () => {
  const s = fresh({ shareAnnotations: true });
  const cardId = s.players[1].hand[0].id;
  annotateAction(s, 1, cardId, { note: 'red two?' });
  const otherView = viewState(s, 0);
  assert.equal(otherView.players[1].hand[0].annotations.note, 'red two?');
});

test('viewState exposes pile direction, top, and hintable colors', () => {
  const s = fresh({ variantId: 'rainbowCriticalBlackReverse' });
  const v = viewState(s, 0);
  assert.equal(v.suits.find((x) => x.color === 'black').direction, 'down');
  assert.equal(v.playedPiles.black.top, 6);
  assert.ok(!v.hintableColors.includes('rainbow'));
  assert.ok(!v.hintableColors.includes('black'));
});

test('viewState reflects hint constraints visible to the owner', () => {
  const s = fresh();
  hintAction(s, 0, 1, 'number', 1);
  const v = viewState(s, 1);
  const hand = v.players[1].hand;
  for (const card of hand) {
    if (card.numberClued) {
      assert.deepEqual(card.possibleNumbers, [1]);
    } else {
      assert.ok(!card.possibleNumbers.includes(1));
    }
  }
});
