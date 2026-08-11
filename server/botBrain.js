// Decision logic for the built-in Hanabi bot. Pure: takes the same filtered
// view a human client renders (own cards hidden, constraints visible) and
// returns one action. The bot cannot cheat — hidden information never reaches
// it: the endgame search below simulates with the public rules over worlds
// hypothesised from the view, never from actual hidden state. Transport lives
// in bot.mjs.
import { getVariant } from './variants.js';
import { discardAction, hintAction, playAction } from './rules.js';
import { viewState } from './view.js';

// Bumped on every change to the decision logic; bot-performance.md records
// what each version does and the benchmark numbers it achieves.
export const BOT_VERSION = '2.22';

// Thresholds for the free gamble (see gambleChance): better-than-even odds,
// and never on the last fuse. Both were swept — the score plateau runs from
// ~0.25 to ~0.5 with the mean flat, so the tighter bound is taken because it
// halves the extra fuse-outs and keeps the bot legible to a human partner.
const GAMBLE_MIN_CHANCE = 0.5;
const GAMBLE_MIN_FUSES = 2;

// The convention set the bot plays by. Kept as data so alternative convention
// sets can be added without touching the decision code's shape.
export const STANDARD_CONVENTIONS = {
  id: 'standard',
  // A colour hint marks the newest touched card for play. Every colour hint
  // still marked on the hand stays a pending play target (oldest first)
  // until the server consumes its markers. If the hint fully pins another
  // touched card AND that card is playable, the pinned card is played first
  // (the play consumes the hint's markers, so the newest touched card stops
  // being a target); a pinned-but-unplayable card changes nothing — the
  // newest touched card is still expected to be played.
  colorHintPlaysNewest: true,
  // A number hint means "keep these" unless a card is provably playable.
  numberHintSaves: true,
  // Exception to the above: a "1" hint asks for every touched card to be
  // played (oldest first), as long as the card can still be a playable 1.
  playAllOnes: true,
  // The chop (default discard) is the oldest untouched, unguarded card.
  discardOldestUntouched: true,
  // Attention-drawing discards: when hints can't cover the danger, an
  // out-of-the-ordinary discard tells the next player to guard their oldest
  // unclued card(s) — see findAlarmMove (sender) / alarmGuards (receiver).
  alarmDiscards: true,
  // Forced-play signals in the 2-player deadlock: a discard by the player
  // who could play advances a pointer over the locked player's possibly-
  // playable cards; their eventual play orders the pointed card played.
  // Needs driver-provided memory — see forcedPlayStep.
  forcedPlaySignals: true,
  // Zero-card hint = "play your chop". Only meaningful when the room allows
  // empty hints (view.allowEmptyHints); a hint that touches none of the
  // receiver's cards tells them to play their oldest untouched card.
  zeroHintPlaysChop: true,
  // Don't race a teammate for the same card. When a convention has pinned what
  // our own card must be, and a teammate is already obliged to play that exact
  // identity but cannot tell (their own card is just "a 1" to them), the copy
  // is ours to shed, not to play — see yieldSlots.
  yieldDuplicatePlays: true,
};

export const CONVENTION_SETS = { standard: STANDARD_CONVENTIONS };

// The convention flags a bot's creator can toggle per bot from the room lobby
// (each governs both sides — using the signal and reacting to it). All default
// on; the rest of the standard set is always active.
export const BOT_OPTION_KEYS = ['alarmDiscards', 'forcedPlaySignals', 'zeroHintPlaysChop'];

export function defaultBotOptions() {
  return Object.fromEntries(BOT_OPTION_KEYS.map((k) => [k, true]));
}

// Sanitize an options object to just the known boolean flags (unknown keys and
// non-booleans are ignored, so it's safe to feed straight from the wire).
export function sanitizeBotOptions(options = {}) {
  const out = {};
  for (const k of BOT_OPTION_KEYS) if (typeof options?.[k] === 'boolean') out[k] = options[k];
  return out;
}

// A conventions object for a bot with the given per-bot option overrides.
export function conventionsFromOptions(options = {}) {
  return { ...STANDARD_CONVENTIONS, ...sanitizeBotOptions(options) };
}

// --- Pile arithmetic (all from the view's playedPiles {top, count, cap}). ---

function suitOf(view, color) {
  return view.suits.find((s) => s.color === color);
}

// The number this pile needs next, or null if it can't grow.
function neededNumber(view, color) {
  const pile = view.playedPiles[color];
  const suit = suitOf(view, color);
  if (pile.count >= pile.cap) return null;
  return suit.direction === 'up' ? pile.top + 1 : pile.top - 1;
}

function isPlayable(view, color, number) {
  return neededNumber(view, color) === number;
}

// True when this identity can never be played again (already played, or the
// pile can't reach it because every copy of an intermediate card is gone —
// the view's pile cap already accounts for discarded criticals).
function isUseless(view, color, number) {
  const pile = view.playedPiles[color];
  const suit = suitOf(view, color);
  if (suit.direction === 'up') {
    if (pile.count > 0 && number <= pile.top) return true; // already played
    return number > pile.cap;                              // unreachable
  }
  if (pile.count > 0 && number >= pile.top) return true;   // already played (5→1)
  return number < 6 - pile.cap;                            // unreachable
}

// --- Identity deduction. ---
// A card's candidate identities start from its hint constraints
// (possibleColors × possibleNumbers) and are narrowed by copy-counting: an
// identity whose every copy is already visible to the deducing player —
// played, discarded, or sitting in a hand they can see — can't be this card.

// Copies of each identity in the variant's full deck (memoized — the search
// rollouts call this on every simulated turn).
const deckCountsCache = new Map();
function deckCounts(view) {
  let totals = deckCountsCache.get(view.variantId);
  if (totals) return totals;
  totals = new Map();
  for (const suit of getVariant(view.variantId).suits) {
    for (const n of suit.distribution) {
      const k = `${suit.color}_${n}`;
      totals.set(k, (totals.get(k) || 0) + 1);
    }
  }
  deckCountsCache.set(view.variantId, totals);
  return totals;
}

// Copies visible in the piles, the discard, and every hand not in hiddenSeats.
function visibleCounts(view, hiddenSeats) {
  const counts = new Map();
  const add = (color, number) => {
    const k = `${color}_${number}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (const [color, pile] of Object.entries(view.playedPiles)) {
    const dir = suitOf(view, color).direction;
    for (let i = 0; i < pile.count; i++) add(color, dir === 'up' ? i + 1 : 5 - i);
  }
  for (const c of view.discard) add(c.color, c.number);
  view.players.forEach((p, seat) => {
    if (hiddenSeats.includes(seat)) return;
    for (const c of p.hand) if (c.color !== undefined) add(c.color, c.number);
  });
  return counts;
}

function deduceCombos(card, visible, totals) {
  const out = [];
  for (const c of card.possibleColors) {
    for (const n of card.possibleNumbers) {
      const k = `${c}_${n}`;
      if ((visible.get(k) || 0) < (totals.get(k) || 0)) out.push([c, n]);
    }
  }
  return out;
}

function combosFor(view, hand, hiddenSeats) {
  const totals = deckCounts(view);
  const visible = visibleCounts(view, hiddenSeats);
  let combos = hand.map((card) => deduceCombos(card, visible, totals));
  // Cross-card elimination: a card pinned to a single identity claims one
  // copy of it. When the claimed copies plus the visible ones account for
  // every copy, that identity is ruled out for the rest of the hand. Each
  // pass can pin new cards, so iterate to a fixpoint (at most one new pin
  // per pass bounds the loop by the hand size).
  for (let pass = 0; pass < hand.length; pass++) {
    const pinned = new Map();
    for (const cs of combos) {
      if (cs.length !== 1) continue;
      const k = `${cs[0][0]}_${cs[0][1]}`;
      pinned.set(k, (pinned.get(k) || 0) + 1);
    }
    let changed = false;
    combos = combos.map((cs) => {
      if (cs.length <= 1) return cs;
      const kept = cs.filter(([c, n]) => {
        const k = `${c}_${n}`;
        return (visible.get(k) || 0) + (pinned.get(k) || 0) < (totals.get(k) || 0);
      });
      // Never empty a card's candidates — inconsistency would mean a server
      // bug; keeping the wider set just makes the bot less certain.
      if (kept.length === 0 || kept.length === cs.length) return cs;
      changed = true;
      return kept;
    });
    if (!changed) break;
  }
  return combos;
}

// Candidate identities for every card in `seat`'s hand, as that player can
// deduce them. Deducing for a teammate under-approximates: the viewer can't
// see their own hand, so its cards can't be counted even though the teammate
// sees them — anything proved this way is still sound.
export function handCombos(view, seat) {
  const hidden = seat === view.viewerIndex ? [seat] : [seat, view.viewerIndex];
  return combosFor(view, view.players[seat].hand, hidden);
}

export function knownPlayable(view, combos) {
  return combos.length > 0 && combos.every(([c, n]) => isPlayable(view, c, n));
}

export function knownUseless(view, combos) {
  return combos.length > 0 && combos.every(([c, n]) => isUseless(view, c, n));
}

function possiblyPlayable(view, combos) {
  return combos.some(([c, n]) => isPlayable(view, c, n));
}

// Combos provable from SHARED knowledge only: hint constraints narrowed by
// the public piles and discard — no hand-based elimination. The forced-play
// convention needs the sender's and receiver's computations to be identical,
// and neither player can reproduce the eliminations the other makes from
// hands only they can see.
function sharedCombos(view, seat) {
  const totals = deckCounts(view);
  const visible = visibleCounts(view, view.players.map((_, i) => i));
  return view.players[seat].hand.map((card) => deduceCombos(card, visible, totals));
}

// --- Convention bookkeeping. ---

// Oldest (leftmost) card never touched by any hint and not guarded — a
// guarded card is "taken care of" by the alarm convention and skipped.
// (Other players' guard flags are only visible when the room shares them;
// without that the fallback is the plain clue-based chop.)
export function chopIndex(hand) {
  for (let i = 0; i < hand.length; i++) {
    if (!hand[i].colorClued && !hand[i].numberClued && !hand[i].annotations?.guarded) return i;
  }
  return -1;
}

// Zero-card-hint convention (only when the room allows empty hints): a hint
// touching none of the receiver's cards means "play your chop".
// Receiver side — is such a signal live for us right now? The most recent hint
// aimed at us was empty, and we haven't taken a turn since (our own play,
// discard, or hint consumes it; a later non-empty hint to us overrides it).
// Other players' actions between the signal and our turn are transparent.
function emptyHintChopSignal(view) {
  const me = view.viewerIndex;
  for (let i = view.log.length - 1; i >= 0; i--) {
    const e = view.log[i];
    if (e.undone) continue;
    if ((e.type === 'play' || e.type === 'discard') && e.playerIndex === me) return false;
    if (e.type === 'hint' && e.fromIndex === me) return false;
    if (e.type === 'hint' && e.toIndex === me) return e.touchedIndexes.length === 0;
  }
  return false;
}

// Sender side — a colour or number that touches none of `seat`'s cards, to use
// as the "play your chop" signal. Colours first (a colour they wholly lack),
// then an absent number. Null when every colour and number touches something.
function findEmptyHint(view, seat) {
  const hand = view.players[seat].hand;
  for (const color of view.hintableColors) {
    if (colorHintTouches(view, hand, color).length === 0) return { hintType: 'color', value: color };
  }
  for (const n of [1, 2, 3, 4, 5]) {
    if (!hand.some((c) => c.number === n)) return { hintType: 'number', value: n };
  }
  return null;
}

// Every colour hint still marked on the hand contributes one pending play
// target: the newest touched card the receiver cannot already prove unplayable.
// The server consumes a hint's markers when any card of that hint leaves the
// hand, so a marked hint is one that hasn't been acted on yet — all of them
// stay live, oldest hint first (its card was playable first).
//
// The target *slides*: a touched card whose own constraints prove it can't be
// playable was never what the hint asked for, so the promise passes to the
// next-newest touched candidate. E.g. with empty piles and a hand of
// [green 5, green 1, red 2, green 2, black 5] where the two 2s are already
// number-clued, a "green" hint touches slots 0, 1 and 3 — slot 3 is a known
// green 2 and provably unplayable, so the target is slot 1 (the green 1),
// not the newest touched card. `possible(slot)` is the caller's
// possibly-playable test; omitted (tests, rollouts) it degrades to the plain
// newest-touched reading.
//
// A hint that fully pins another touched card needs no special case here: a
// pinned *playable* card is played first via known-playable (which consumes
// the hint's markers and retires the target), and a pinned unplayable card is
// simply skipped by the slide. (An earlier version cancelled the target
// whenever any touched card was pinned; in rainbow variants that made every
// colour hint cancel itself, because colour hints unavoidably touch the known
// rainbow cards in hand.)
export function colorPlayTargets(hand, possible = null) {
  const byHint = new Map();
  hand.forEach((card, slot) => {
    for (const h of card.lastHints) {
      if (h.hintType !== 'color') continue;
      if (!byHint.has(h.hintIndex)) byHint.set(h.hintIndex, []);
      byHint.get(h.hintIndex).push(slot);
    }
  });
  const targets = [];
  for (const hintIndex of [...byHint.keys()].sort((a, b) => a - b)) {
    const slots = byHint.get(hintIndex).slice().sort((a, b) => a - b);
    let pick = -1;
    for (let k = slots.length - 1; k >= 0; k--) {
      if (!possible || possible(slots[k])) { pick = slots[k]; break; }
    }
    if (pick >= 0 && !targets.includes(pick)) targets.push(pick);
  }
  return targets;
}

// The type of our own most recent card-out-of-hand action (play/discard) — the
// only kind that consumes markers on our own hand. Used to tell why a target's
// marker vanished (a colour hint given TO us adds markers; only our own plays
// and discards remove them).
export function myLastHandExit(view, seat) {
  for (let i = view.log.length - 1; i >= 0; i--) {
    const e = view.log[i];
    if (!e.undone && e.playerIndex === seat && (e.type === 'play' || e.type === 'discard')) {
      return e.type;
    }
  }
  return null;
}

// The display markers (`lastHints`) are consumed whenever ANY card of a hint's
// touched set leaves the hand — a play OR a discard — which clears the whole
// hint, the newest-touched play target included. Two different intents hide
// behind that one mechanism, and they must be treated oppositely:
//   - a colour-sibling was PLAYED: the convention deliberately retired this
//     target (a pinned-playable sibling stood in for the play, common in
//     rainbow variants) — the obligation is finished, drop it;
//   - a colour-sibling was DISCARDED (forced, or an alarm signal): the target
//     is still ours to play, but the bare marker has forgotten it.
// We record the target's card id in the driver memory the first turn its marker
// is live (decideCore does this every turn before any branch can consume
// markers) and keep it across a discard, but not across a play. `lastExit` is
// our own last play/discard (see myLastHandExit) — the only action that could
// have removed the marker since our previous turn.
export function rememberColorTargets(hand, memory, lastExit = null, possible = null) {
  if (!memory) return;
  if (!memory.colorPlays) memory.colorPlays = [];
  const present = new Set(hand.map((c) => c.id));
  const live = new Set(colorPlayTargets(hand, possible).map((slot) => hand[slot].id));
  const retired = lastExit === 'play';
  memory.colorPlays = memory.colorPlays.filter((id) => {
    if (!present.has(id)) return false; // the target itself left the hand
    if (live.has(id)) return true;      // still marked — nothing to decide
    return !retired;                    // marker gone: keep only if not a play-retirement
  });
  // Add this turn's live targets last, so a just-retired id (no longer live)
  // isn't immediately re-recorded.
  for (const slot of colorPlayTargets(hand, possible)) {
    const { id } = hand[slot];
    if (!memory.colorPlays.includes(id)) memory.colorPlays.push(id);
  }
}

// The slots to treat as pending colour-hint plays: every live marker target
// (in hint order, oldest hint first — unchanged), plus any remembered
// obligation whose marker has since been wiped by an unrelated departure
// (appended, oldest slot first). Without memory this is exactly
// colorPlayTargets, so rollouts and the CLI bot behave as before.
export function mergedColorTargets(hand, memory, possible = null) {
  const live = colorPlayTargets(hand, possible);
  if (!memory?.colorPlays?.length) return live;
  const seen = new Set(live);
  const rescued = [];
  hand.forEach((card, slot) => {
    if (!seen.has(slot) && memory.colorPlays.includes(card.id)) rescued.push(slot);
  });
  return [...live, ...rescued];
}

// Cards obligated by the play-all-1s convention: touched by a "1" hint at
// some point (numberClued with possibleNumbers narrowed to exactly [1]).
// Constraint-based rather than marker-based on purpose — playing the first 1
// consumes the hint's markers on the others, but the obligation persists.
function onesObligations(hand) {
  const out = [];
  hand.forEach((card, i) => {
    if (card.numberClued && card.possibleNumbers.length === 1 && card.possibleNumbers[0] === 1) {
      out.push(i);
    }
  });
  return out;
}

// Suits played 5→1 turn the "1" convention upside down: there, 1 is the LAST
// card of the pile and — with the reversed distribution — its only copy, so it
// is a critical card, the exact opposite of a play cue. A number hint means
// *keep* by default, so in a variant carrying such a suit a "1" hint keeps
// unless the receiver can prove the card is not that suit's 1. (Being touched
// by any colour hint proves it: a 'none'-matching suit like black is never in a
// colour hint's touched set, so a colour-clued card cannot be black.)
function reversedOneColors(view) {
  const out = new Set();
  for (const suit of getVariant(view.variantId).suits) {
    if (suit.direction === 'down' && suit.distribution.includes(1)) out.add(suit.color);
  }
  return out;
}

// What a play candidate must BE if the convention that marked it is to make
// sense: among everything it could still be, exactly one identity is playable.
// A blue target on an empty blue pile can only be the blue 1. Null when the
// convention doesn't pin it — with blue 1 and rainbow 1 both open a blue hint
// leaves two playable candidates, so nothing can be concluded.
function impliedPlayIdentity(view, combos) {
  const playable = combos.filter(([c, n]) => isPlayable(view, c, n));
  return playable.length === 1 ? playable[0] : null;
}

// Slots holding a card a teammate is ALREADY obliged to play, where they can't
// tell and we can. Two obligations on one identity guarantee that one of the
// two plays misfires; we can see their hand, so the duplicate is ours to shed.
//
// The blindness test is what keeps this from deadlocking. If they could pin the
// card themselves they would yield to us instead, and both copies would be
// discarded; so we yield only to a teammate whose own convention leaves the
// identity ambiguous (a "1" hint tells them the number, never the colour).
// `candidates` are the slots some convention has actually marked for play —
// only there does "the one playable identity it could be" say what the card IS.
// Applied to any card it would be nonsense: an unrelated red card whose pile is
// empty would "imply" red 1 merely because that is the only playable red.
function yieldSlots(view, myCombos, conventions, candidates) {
  const out = new Set();
  if (!conventions.yieldDuplicatePlays) return out;
  const mine = myCombos.map((cs, i) => (candidates.has(i) ? impliedPlayIdentity(view, cs) : null));
  if (!mine.some(Boolean)) return out;
  for (let seat = 0; seat < view.players.length; seat++) {
    if (seat === view.viewerIndex) continue;
    const hand = view.players[seat].hand;
    const combos = handCombos(view, seat);
    const obliged = new Set();
    if (conventions.playAllOnes) {
      for (const i of onesPlayObligations(view, hand, combos)) obliged.add(i);
    }
    if (conventions.colorHintPlaysNewest) {
      for (const t of colorPlayTargets(hand, (s) => possiblyPlayable(view, combos[s]))) obliged.add(t);
    }
    for (const i of obliged) {
      if (impliedPlayIdentity(view, combos[i])) continue; // they can see it too
      mine.forEach((id, slot) => {
        if (id && id[0] === hand[i].color && id[1] === hand[i].number) out.add(slot);
      });
    }
  }
  return out;
}

// Is the "1" order `seat` is holding still fresh — no 1 played by anyone since?
// When the hinter gave the order they had checked that every 1 the receiver
// would play really was playable, so at that instant the oldest was safe. Any
// 1 played since can have taken its colour, and the receiver cannot tell (their
// card is just "a 1" to them), so the guarantee lapses.
//
// Deliberately counts the receiver's OWN 1-plays too. Only the order's own 1s
// are guaranteed to be different colours; a 1 the receiver played off a colour
// hint can collide with the rest. Counting every play also means we only ever
// extend this trust to the FIRST 1 of an order — exactly "at least the oldest".
//
// Scans back to the most recent "1" hint aimed at `seat`. Not finding one (it
// has aged out of the 50-entry log window) reads as stale, which is the safe
// direction — the caller then falls back to demanding proof.
function onesOrderIsFresh(view, seat) {
  for (let i = view.log.length - 1; i >= 0; i--) {
    const e = view.log[i];
    if (e.undone) continue;
    if (e.type === 'hint' && e.toIndex === seat && e.hintType === 'number' && e.value === 1) return true;
    if (e.type === 'play' && e.card?.number === 1) return false;
  }
  return false;
}

// Will `seat` actually act on the "1" obligation in slot i? Shared by the
// receiver (decideCore), the giver's model (hasPendingPlay) and the dead-1
// warning so that no two sides disagree about what the order means.
//
// Below the last fuse the order is simply followed. On the last fuse a misfire
// ends the game, so proof is normally required — but a *fresh* order is still
// trusted for its OLDEST 1, the one the hinter most directly vouched for.
// Trusting the whole set unconditionally was measured and is much worse.
function onesPlayGate(view, seat, ones, combos) {
  if (view.fuseTokens !== 1) return (i) => possiblyPlayable(view, combos[i]);
  const fresh = onesOrderIsFresh(view, seat);
  return (i) => (fresh && i === ones[0]
    ? possiblyPlayable(view, combos[i])
    : knownPlayable(view, combos[i]));
}

// The slots a "1" hint actually obligates for play (see reversedOneColors).
function onesPlayObligations(view, hand, combos) {
  const ones = onesObligations(hand);
  const reversed = reversedOneColors(view);
  if (reversed.size === 0) return ones;
  return ones.filter((i) => !combos[i].some(([c, n]) => n === 1 && reversed.has(c)));
}

// An identity that must not be lost: still needed, and every other copy has
// been discarded (played copies would make it useless, handled above).
function identityCritical(view, color, number) {
  if (isUseless(view, color, number)) return false;
  const suit = getVariant(view.variantId).suits.find((s) => s.color === color);
  const total = suit.distribution.filter((n) => n === number).length;
  const discarded = view.discard.filter((c) => c.color === color && c.number === number).length;
  return total - discarded === 1;
}

function isCritical(view, card) {
  return identityCritical(view, card.color, card.number);
}

// Every candidate identity of this card is critical — discarding it is a
// guaranteed loss whatever it turns out to be.
function provablyCritical(view, combos) {
  return combos.length > 0 && combos.every(([c, n]) => identityCritical(view, c, n));
}

// Points the team loses if this identity is discarded: losing a last
// remaining copy makes everything past it in its pile unreachable, so early
// criticals are far more expensive than late ones (losing rainbow 2 costs 4
// points; losing rainbow 5 costs 1). Non-critical identities cost nothing —
// another copy is still out there.
function discardCost(view, color, number) {
  if (!identityCritical(view, color, number)) return 0;
  const cap = view.playedPiles[color].cap;
  const reachableWithout = suitOf(view, color).direction === 'up' ? number - 1 : 5 - number;
  return cap - Math.min(cap, reachableWithout);
}

// Pile points we risk by discarding one of OUR OWN cards, given its candidate
// identities: each candidate weighted by how many copies of it are still
// unseen (our hand + the deck), which is exactly how likely the card is to be
// that identity. A card with no critical candidate scores 0 — losing it cannot
// cost the team a point. Unlike provablyCritical (all-or-nothing) this ranks
// partial danger, so "least dangerous" can mean the least dangerous card
// rather than merely the oldest one that isn't a proven last copy.
function discardRisk(view, combos) {
  if (combos.length === 0) return 0;
  const totals = deckCounts(view);
  const visible = visibleCounts(view, [view.viewerIndex]);
  let copiesTotal = 0;
  let sum = 0;
  for (const [c, n] of combos) {
    const k = `${c}_${n}`;
    const copies = Math.max(0, (totals.get(k) || 0) - (visible.get(k) || 0));
    copiesTotal += copies;
    sum += copies * discardCost(view, c, n);
  }
  return copiesTotal > 0 ? sum / copiesTotal : 0;
}

// --- Free gamble. ---
// A card every one of whose candidate identities is either already played
// (dead) or playable RIGHT NOW. Such a card is worth nothing in hand: the
// candidates that aren't playable are dead, so it will never become playable
// later. Playing it therefore risks no pile points at all — it either scores or
// burns a fuse — while discarding it forfeits the point. `chance` is the
// probability it scores, by unseen copy counts.
function gambleChance(view, combos) {
  if (combos.length === 0) return 0;
  if (!combos.every(([c, n]) => isUseless(view, c, n) || isPlayable(view, c, n))) return 0;
  const totals = deckCounts(view);
  const visible = visibleCounts(view, [view.viewerIndex]);
  let all = 0;
  let good = 0;
  for (const [c, n] of combos) {
    const k = `${c}_${n}`;
    const copies = Math.max(0, (totals.get(k) || 0) - (visible.get(k) || 0));
    all += copies;
    if (isPlayable(view, c, n)) good += copies;
  }
  return all > 0 ? good / all : 0;
}

function bestGamble(view, myCombos, yielded) {
  let best = null;
  for (let i = 0; i < myCombos.length; i++) {
    if (yielded.has(i)) continue;
    const chance = gambleChance(view, myCombos[i]);
    if (chance > 0 && (!best || chance > best.chance)) best = { index: i, chance };
  }
  return best;
}

// --- Hint simulation against a teammate's visible hand. ---

// The suit colours a colour hint touches (rainbow-style suits match any).
function touchedColorSet(view, hintColor) {
  return new Set(
    view.suits
      .filter((s) => s.hintMatches === 'all' || (s.hintMatches === 'self' && s.color === hintColor))
      .map((s) => s.color),
  );
}

function colorHintTouches(view, hand, hintColor) {
  const tset = touchedColorSet(view, hintColor);
  return hand.map((card, i) => ({ card, i })).filter(({ card }) => tset.has(card.color));
}

// The receiver's constraints after a colour hint (mirrors hintAction): touched
// cards intersect their possible colours with the touched set, untouched
// cards subtract it.
function afterColorHint(view, hand, hintColor) {
  const tset = touchedColorSet(view, hintColor);
  return hand.map((card) => ({
    ...card,
    possibleColors: card.possibleColors.filter((c) => (tset.has(card.color) ? tset.has(c) : !tset.has(c))),
  }));
}

// The receiver's constraints after a number hint.
function afterNumberHint(hand, value) {
  return hand.map((card) => ({
    ...card,
    possibleNumbers: card.number === value ? [value] : card.possibleNumbers.filter((n) => n !== value),
  }));
}

// Would this player, following the conventions, already play something on
// their own? (Known-playable card, a live colour-hint target, or a 1s
// obligation that can still be playable.)
// `reader` asks the question from another seat's chair: deduce `seat`'s hand
// WITHOUT counting the reader's own cards, which they cannot see. Used when a
// pending play has to be one both ends can prove — a signal read off knowledge
// only the sender holds is no signal at all (see findAlarmMove).
function hasPendingPlay(view, seat, conventions = STANDARD_CONVENTIONS, reader = null) {
  const hand = view.players[seat].hand;
  const combos = reader == null || reader === seat
    ? handCombos(view, seat)
    : combosFor(view, hand, [seat, reader]);
  if (combos.some((cs) => knownPlayable(view, cs))) return true;
  if (conventions.playAllOnes) {
    const ones = onesPlayObligations(view, hand, combos);
    const willPlay = onesPlayGate(view, seat, ones, combos);
    if (!ones.some((i) => combos[i].length === 1) && ones.some(willPlay)) return true;
  }
  // Same reading the receiver uses (target slides past provably-unplayable
  // touched cards), so we never count a "pending play" they won't actually
  // make — that mismatch used to leave a colour-clued card nobody would touch
  // while we withheld further help, deadlocking both sides into stalls.
  return colorPlayTargets(hand, (slot) => possiblyPlayable(view, combos[slot])).length > 0;
}

// Score a valid play hint so competing options can be compared. Immediate
// correct plays dominate; then touching cards that are still needed (they'll
// be kept and eventually played), then raw information (candidate identities
// eliminated across the hand); touching a useless card costs — it gets a
// keep-clue it doesn't deserve and clogs the hand.
function scoreHint(view, seat, hand, touched, before, after, playIdxs, hint) {
  const plays = playIdxs.length;
  let info = 0;
  for (let i = 0; i < hand.length; i++) info += before[i].length - after[i].length;
  // Identities already clued somewhere visible: touching another copy of one
  // wastes the touch and risks two players "keeping" the same card.
  const cluedElsewhere = new Set();
  view.players.forEach((p, other) => {
    if (other === view.viewerIndex) return;
    p.hand.forEach((c, i) => {
      if ((c.colorClued || c.numberClued) && !(other === seat && touched.some((t) => t.i === i))) {
        cluedElsewhere.add(`${c.color}_${c.number}`);
      }
    });
  });
  // How soon a touched card can matter: playable now > next in line for its
  // pile > distant future. Newly cluing a distant card is a liability — it
  // sits in the hand soaking up "keep" status and muddying later hints.
  const soon = (card) => {
    const need = neededNumber(view, card.color);
    if (need === null) return 0;
    const dist = suitOf(view, card.color).direction === 'up' ? card.number - need : need - card.number;
    return dist === 0 ? 2 : dist === 1 ? 1 : 0;
  };
  let value = 0;
  let bad = 0;
  const seen = new Set();
  for (const { card } of touched) {
    const k = `${card.color}_${card.number}`;
    if (isUseless(view, card.color, card.number) || cluedElsewhere.has(k) || seen.has(k)) bad++;
    else if (soon(card) > 0) value += soon(card) * 25;
    else if (!card.colorClued && !card.numberClued) value -= 30; // distant card newly clued
    seen.add(k);
  }
  // Colour hints get a small edge: beyond the immediate play they leave a
  // pending-target obligation and colour identity that keeps paying off.
  const colorBonus = hint.hintType === 'color' ? 50 : 0;
  return { hint, playIdxs, score: plays * 1000 + value + info + colorBonus - bad * 200 };
}

// Every hint to `seat` that the receiver, reading it by the conventions,
// would correctly act on — each scored. Colour hints work as play hints when
// they prove some touched card playable outright (a reveal), or when the
// newest touched card is playable right now and the hint doesn't read as a
// reveal (which would cancel the newest-touched promise). Number hints work
// when they make a touched card provably playable — or, for a "1" hint under
// play-all-1s, when every 1 the receiver would go on to play really is
// playable, all different colours, and not already obligated elsewhere.
function playHintCandidates(view, seat, conventions) {
  const out = [];
  const hand = view.players[seat].hand;
  const before = handCombos(view, seat);
  const pending = colorPlayTargets(hand, (slot) => possiblyPlayable(view, before[slot]));
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length === 0) continue;
    const after = combosFor(view, afterColorHint(view, hand, color), [seat, view.viewerIndex]);
    let playIdxs = touched.filter(({ i }) => knownPlayable(view, after[i])).map(({ i }) => i);
    if (playIdxs.length === 0) {
      // The card the receiver will actually pick: newest touched that their
      // post-hint constraints don't already rule out (see colorPlayTargets).
      let target = null;
      for (let k = touched.length - 1; k >= 0; k--) {
        if (possiblyPlayable(view, after[touched[k].i])) { target = touched[k]; break; }
      }
      if (!target) continue;
      if (!isPlayable(view, target.card.color, target.card.number)) continue;
      if (pending.includes(target.i)) continue; // already their live target
      playIdxs = [target.i];
    }
    out.push(scoreHint(view, seat, hand, touched, before, after, playIdxs, { hintType: 'color', value: color }));
  }
  for (const n of [...new Set(hand.map((c) => c.number))]) {
    const after = combosFor(view, afterNumberHint(hand, n), [seat, view.viewerIndex]);
    const touched = hand.map((c, i) => ({ card: c, i })).filter(({ card }) => card.number === n);
    if (n === 1 && conventions.playAllOnes) {
      // A 1 the receiver can't yet rule out as the reversed suit's own 1 reads
      // as a keep, not a play, so this hint can't be credited with playing it.
      const reversed = reversedOneColors(view);
      const wouldPlay = touched.filter(({ i }) => possiblyPlayable(view, after[i])
        && !after[i].some(([c, num]) => num === 1 && reversed.has(c)));
      // 1s already obligated in other visible hands — a second obligation on
      // the same colour's 1 guarantees that one of the two plays misfires.
      const obligatedElsewhere = new Set();
      view.players.forEach((p, other) => {
        if (other === seat || other === view.viewerIndex) return;
        for (const i of onesObligations(p.hand)) obligatedElsewhere.add(p.hand[i].color);
      });
      const colors = new Set(wouldPlay.map(({ card }) => card.color));
      const newlyObligated = touched.some(({ card }) => !(card.numberClued && card.possibleNumbers.length === 1));
      if (
        wouldPlay.length > 0
        && newlyObligated
        && colors.size === wouldPlay.length
        && wouldPlay.every(({ card }) => isPlayable(view, card.color, card.number))
        && wouldPlay.every(({ card }) => !obligatedElsewhere.has(card.color))
        && !touched.some(({ i }) => after[i].length === 1) // would read as a reveal
      ) {
        out.push(scoreHint(view, seat, hand, touched, before, after, wouldPlay.map(({ i }) => i), { hintType: 'number', value: 1 }));
      }
      continue; // an unsafe "1" hint would trigger the convention anyway
    }
    const playIdxs = touched.filter(({ i }) => knownPlayable(view, after[i])).map(({ i }) => i);
    if (playIdxs.length > 0) {
      out.push(scoreHint(view, seat, hand, touched, before, after, playIdxs, { hintType: 'number', value: n }));
    }
  }
  return out;
}

// The best valid play hint for `seat`, or null. Colour hints outrank number
// hints as a class (they leave a lasting pending-target obligation); the
// score picks the best option *within* the class. Ties keep the first
// candidate in enumeration order, so the choice is deterministic. The one
// exception to the class preference: a number hint that starts strictly MORE
// cards playing than the best colour hint wins — a single "1" hint that sends
// two 1s at once (play-all-1s) is worth more tempo than a colour hint that
// reveals just one, and card economy trumps the colour bonus there.
function findPlayHint(view, seat, conventions) {
  let bestColor = null;
  let bestNumber = null;
  for (const cand of playHintCandidates(view, seat, conventions)) {
    if (cand.hint.hintType === 'color') {
      if (!bestColor || cand.score > bestColor.score) bestColor = cand;
    } else if (!bestNumber || cand.score > bestNumber.score) {
      bestNumber = cand;
    }
  }
  let best = bestColor || bestNumber;
  if (bestColor && bestNumber && bestNumber.playIdxs.length > bestColor.playIdxs.length) {
    best = bestNumber;
  }
  return best && best.hint;
}

// A chop card we shouldn't let go: critical (last remaining copy), or a
// still-needed 2 whose twin isn't anywhere we can see — losing an early 2
// caps its pile for a long time, so it gets the benefit of the doubt.
function saveWorthy(view, card) {
  if (isCritical(view, card)) return true;
  // A 2 isn't a guaranteed loss, so only spend a token on it when tokens
  // aren't scarce.
  if (view.hintTokens < 2) return false;
  if (card.number !== 2 || isUseless(view, card.color, card.number)) return false;
  const visible = visibleCounts(view, [view.viewerIndex]);
  return (visible.get(`${card.color}_2`) || 0) - 1 === 0; // only this copy in sight
}

// The best way to protect `chop` in `seat`'s hand. A play hint that gets the
// card played beats parking it: the card scores AND leaves the hand. Next
// best, a colour hint that pins it as provably unplayable (informative, and
// safe: the receiver's target check skips unplayable targets). Fallback is
// the plain number keep-hint — except a "1" save that play-all-1s would
// misread as a play order; then no safe save exists.
function findSaveHint(view, seat, chop, conventions) {
  const hand = view.players[seat].hand;
  const card = hand[chop];
  if (isPlayable(view, card.color, card.number)) {
    let best = null;
    for (const cand of playHintCandidates(view, seat, conventions)) {
      if (!cand.playIdxs.includes(chop)) continue;
      if (!best || cand.score > best.score) best = cand;
    }
    if (best) return { hint: best.hint, how: 'play' };
  }
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length === 0 || touched[touched.length - 1].i !== chop) continue;
    const after = combosFor(view, afterColorHint(view, hand, color), [seat, view.viewerIndex]);
    if (!possiblyPlayable(view, after[chop])) {
      return { hint: { hintType: 'color', value: color }, how: 'pin' };
    }
  }
  if (card.number === 1 && conventions.playAllOnes && !isPlayable(view, card.color, card.number)) {
    const after = combosFor(view, afterNumberHint(hand, 1), [seat, view.viewerIndex]);
    if (possiblyPlayable(view, after[chop])) return null; // would trigger a misplay
  }
  return { hint: { hintType: 'number', value: card.number }, how: 'keep' };
}

// The most recent play/discard/hint in the log that wasn't undone.
function lastRealAction(view) {
  for (let i = view.log.length - 1; i >= 0; i--) {
    const t = view.log[i].type;
    if ((t === 'play' || t === 'discard' || t === 'hint') && !view.log[i].undone) {
      return view.log[i];
    }
  }
  return null;
}

// --- Forced-play signals (2-player deadlock; needs driver memory). ---
// The deadlock: one player's cards are all touched/guarded (nothing
// conventionally discardable) and they lack the info to play any, so they
// stall with hints while the other player discards to feed them tokens. If
// the free player holds a play fully determined by shared knowledge but
// discards anyway, each such discard advances a pointer over the locked
// player's possibly-playable cards (oldest first); when the free player
// finally plays — at a moment a discard was legal — the locked player plays
// the pointed card. While armed, the free player's plays are ONLY made as
// signals. Everything is computed from shared knowledge so both sides agree,
// and the pointer count lives in driver-provided memory (without memory the
// convention is off).

// Is `n` of `color` playable once `played` ([color, number] or null) lands
// on its pile? Signal plays change the pile the pointed card must land on,
// so both sides evaluate playability in the post-signal state.
function playableAfter(view, color, number, played) {
  if (played && played[0] === color) {
    const suit = suitOf(view, color);
    return (suit.direction === 'up' ? played[1] + 1 : played[1] - 1) === number;
  }
  return isPlayable(view, color, number);
}

// --- Which play to make when the conventions oblige several. ---
// Every candidate is going to be played sooner or later, so the choice is one
// of ORDER, and what orders it is the teammate: a play that lands the card
// their hand is waiting on buys a whole turn, and one that lands anything else
// buys nothing. Counted as cards that become playable *by their own knowledge*
// — a card they cannot tell is playable is not yet a play to them.
//
// Their deduction is not re-run against the new pile (our card landing there
// can pin one of their cards by copy-counting), so this under-counts rather
// than over-promises, which is the safe direction for a tie-break.
function unlockedByPlay(view, partners, played) {
  let count = 0;
  for (const { combos } of partners) {
    for (const cs of combos) {
      if (cs.length === 0 || knownPlayable(view, cs)) continue; // already theirs to play
      if (cs.every(([c, n]) => playableAfter(view, c, n, played))) count++;
    }
  }
  return count;
}

// The same, averaged over what our own card might be — we rarely know. Only its
// playable identities are weighed: a card the conventions mark for play is one
// we are asserting is playable, so the worlds where it isn't are not ours to
// plan around (they cost a fuse whenever we get to them).
function playUnlockScore(view, partners, combos) {
  const playable = combos.filter(([c, n]) => isPlayable(view, c, n));
  if (playable.length === 0) return 0;
  let sum = 0;
  for (const identity of playable) sum += unlockedByPlay(view, partners, identity);
  return sum / playable.length;
}

// The locked player's pointer set: hand indexes possibly playable by shared
// knowledge, oldest first, evaluated after the signal play `played`.
function pointerSet(view, seat, played) {
  const set = [];
  sharedCombos(view, seat).forEach((cs, i) => {
    if (cs.some(([c, n]) => playableAfter(view, c, n, played))) set.push(i);
  });
  return set;
}

// The deadlock is "armed" when: 2 players, a discard is legal, the locked
// seat has no chop, no play provable from shared knowledge, but at least one
// possibly-playable card — and the free seat holds a play FULLY determined
// by shared knowledge (only then can both sides compute the post-play
// pointer set identically).
// The deadlock itself, without asking what the free seat holds: the locked seat
// cannot conventionally act, and the free seat CAN discard — so a play by the
// free seat is a choice, and therefore an order.
function deadlocked(view, lockedSeat, freeSeat, conventions = STANDARD_CONVENTIONS) {
  if (view.players.length !== 2 || view.hintTokens >= 8) return false;
  const hand = view.players[lockedSeat].hand;
  if (hand.length === 0 || chopIndex(hand) >= 0) return false;
  // A play only *means* anything if its maker could have discarded instead.
  // With no chop of their own — every card clued or guarded — their turn was
  // play-or-throw-a-keeper, so playing was forced, not chosen, and carries no
  // order. The same test serves both sides: the free seat reads it as "my play
  // would be taken as a command", the locked seat as "their play was one".
  if (chopIndex(view.players[freeSeat].hand) < 0) return false;
  // No deadlock if they are already obliged to play something. "Obliged" is the
  // conventions' reading, not just a provable play: a live colour target is a
  // firm obligation even though it is only *possibly* playable, and a seat that
  // is going to play next turn anyway does not need a pointer walked over its
  // hand. Testing knownPlayable alone declared a deadlock over a hand holding a
  // colour-clued playable card, and the pointer then commanded a *different*
  // card played — in the game that turned this up, a guarded one, which
  // misfired and was lost.
  if (hasPendingPlay(view, lockedSeat, conventions)) return false;
  // Nothing to point at.
  return sharedCombos(view, lockedSeat).some((cs) => possiblyPlayable(view, cs));
}

function forcedPlayArmed(view, lockedSeat, freeSeat, conventions = STANDARD_CONVENTIONS) {
  if (!deadlocked(view, lockedSeat, freeSeat, conventions)) return null;
  const free = sharedCombos(view, freeSeat);
  const freePlay = free.findIndex(
    (cs) => cs.length === 1 && isPlayable(view, cs[0][0], cs[0][1]),
  );
  if (freePlay < 0) return null;
  return { freePlay, playedIdentity: free[freePlay][0] };
}

// What playing right now would cost the PARTNER. While they are deadlocked our
// play is an order (see deadlocked), which they answer by playing the card the
// pointer reaches — so a play we do not mean as an order is not ours to make,
// however good it is for us. Priced as the worst of the cards the pointer could
// resolve to: we cannot be certain which one they are counting to, so the risk
// is what to weigh, not the best case. A candidate that really is playable
// costs nothing — they score. Null when our play orders nothing.
function commandedPlayCost(view, conventions) {
  if (!conventions.forcedPlaySignals || view.hintTokens > 1) return null;
  const me = view.viewerIndex;
  const other = 1 - me;
  if (!deadlocked(view, other, me, conventions)) return null;
  const set = pointerSet(view, other, null);
  if (set.length === 0) return null; // nothing they would fire at
  let worst = 0;
  for (const i of set) {
    const card = view.players[other].hand[i];
    if (isPlayable(view, card.color, card.number)) continue;
    worst = Math.max(worst, discardCost(view, card.color, card.number));
  }
  // On the last fuse a commanded misfire ends the game, which costs every point
  // still on the table — no discard of ours is ever worse than that.
  if (worst > 0 && view.fuseTokens === 1) return Infinity;
  return worst;
}

// The pile points our own alternative costs: the discard we would make instead
// of playing. Provable trash is free; otherwise it is the chop's risk (we only
// ask this while deadlocked, which means we have one).
function ownDiscardCost(view, myCombos) {
  for (const combos of myCombos) if (knownUseless(view, combos)) return 0;
  const chop = chopIndex(view.players[view.viewerIndex].hand);
  return chop >= 0 ? discardRisk(view, myCombos[chop]) : Infinity;
}

function forcedPlayStep(view, conventions, memory) {
  if (!memory || !conventions.forcedPlaySignals || view.players.length !== 2) return null;
  // A rewound or restarted turn counter means a new game or an undo — forget.
  if (memory.fpTurn !== undefined && view.turn <= memory.fpTurn) {
    memory.fpRole = null;
    memory.fpCount = 0;
  }
  memory.fpTurn = view.turn;
  const me = view.viewerIndex;
  const other = 1 - me;
  const last = lastRealAction(view);

  // Receiver reaction first (the partner's signal play just broke the armed
  // predicate — their provable play left the hand — so this must not
  // re-check it): while we were armed, their play orders the pointed card.
  if (memory.fpRole === 'receiver' && last && last.type === 'play'
      && last.playerIndex === other && last.success !== false) {
    const pointer = memory.fpCount || 0;
    memory.fpRole = null;
    memory.fpCount = 0;
    const hand = view.players[me].hand;
    if (chopIndex(hand) < 0) {
      const set = pointerSet(view, me, null); // their play is already on the piles
      if (pointer < set.length) {
        return {
          action: { type: 'play', cardIndex: set[pointer] },
          reason: `forced-play signal received: playing pointer ${pointer}`,
        };
      }
    }
    return null;
  }

  // Sender: my discards advance the pointer, my play fires it — so I only
  // play when the pointed card really is playable. Engaged only at zero
  // tokens: with tokens in the bank a real hint beats pointer games, and the
  // deadlock this convention exists for is by definition token-starved
  // ("used sparingly").
  const armed = view.hintTokens === 0 ? forcedPlayArmed(view, other, me, conventions) : null;
  if (armed) {
    if (memory.fpRole !== 'sender') {
      memory.fpRole = 'sender';
      memory.fpCount = 0;
    }
    const count = memory.fpCount || 0;
    const set = pointerSet(view, other, armed.playedIdentity);
    let target = -1;
    for (let k = count; k < set.length; k++) {
      const card = view.players[other].hand[set[k]];
      if (playableAfter(view, card.color, card.number, armed.playedIdentity)) {
        target = k;
        break;
      }
    }
    if (target === count) {
      memory.fpRole = null;
      memory.fpCount = 0;
      return {
        action: { type: 'play', cardIndex: armed.freePlay },
        reason: `forced-play signal: play your pointer ${count}`,
      };
    }
    const chop = chopIndex(view.players[me].hand);
    if (chop >= 0) {
      memory.fpCount = count + 1;
      return {
        action: { type: 'discard', cardIndex: chop },
        reason: target > count
          ? `forced-play signal: advancing pointer to ${count + 1}`
          : 'forced-play: feeding tokens (no valid signal yet)',
      };
    }
    return null;
  }

  // Receiver bookkeeping: count the partner's able-to-play discards. The
  // receiver's turns run right after the partner's discard restored a token,
  // so its gate is one looser than the sender's zero.
  if (view.hintTokens <= 1 && forcedPlayArmed(view, me, other, conventions)) {
    if (memory.fpRole !== 'receiver') {
      // First turn we read the deadlock. Whatever the partner did last happened
      // BEFORE it existed, so it cannot have been a pointer advance — the
      // sender only advances over a hand with no chop, and ours still had one.
      // Counting it anyway stole a move's meaning: an alarm discard is answered
      // by guarding our chop, which is itself what locks the hand, so the very
      // discard that armed us was read as an advance and the partner's next
      // play commanded the wrong card.
      memory.fpRole = 'receiver';
      memory.fpCount = 0;
    } else if (last && last.type === 'discard' && last.playerIndex === other) {
      memory.fpCount = (memory.fpCount || 0) + 1;
    }
    return null; // armed but nothing commanded — act normally (stall)
  }

  // Not armed in either role — drop any stale state.
  memory.fpRole = null;
  memory.fpCount = 0;
  return null;
}

// Expected pile-point cost of discarding one of our own UNKNOWN cards. An
// unclued card is a uniform draw from what we cannot see (our own hand + the
// deck), so each candidate identity that is a last remaining copy contributes
// its discardCost weighted by 1/unseen (exactly one copy of a critical sits
// unseen). Non-critical candidates cost nothing — another copy is still out
// there. This is what the sacrifice really risks, on average.
function expectedDiscardCost(view, combos) {
  const unseen = view.players[view.viewerIndex].hand.length + view.deckSize;
  if (unseen <= 0) return 0;
  let sum = 0;
  for (const [c, n] of combos) sum += discardCost(view, c, n);
  return sum / unseen;
}

// Sender side of the alarm convention: an out-of-the-ordinary discard that
// tells the next player something is amiss, used when hints can't cover the
// danger (no tokens at all, or one hint can't protect two endangered cards).
// Ordered safest first:
//   0. discard provable trash while holding an obvious play — costs nothing at
//      all, so it is taken whenever both halves are in hand;
//   1. discard a touched card that is provably not critical but still useful;
//   2. discard the chop while holding an obvious play — the forgone play is
//      the anomaly;
//   3. discard PAST the chop;
//   4. sacrifice a touched provable critical that costs fewer pile points
//      than what it saves (e.g. throw a 5 to keep a critical 2).
function findAlarmMove(view, myHand, myCombos, savedCost, conventions = STANDARD_CONVENTIONS) {
  if (view.hintTokens >= 8) return null; // discarding is illegal right now
  const touched = (c) => c.colorClued || c.numberClued;
  // Exactly the condition alarmGuards uses to *read* every alarm below, so
  // emission and detection can never disagree about what counts as a forgone
  // play. A colour hint is an obligation to play, so declining one speaks just
  // as loudly as declining a known-playable card. hasPendingPlay reads live
  // markers only — never our private memory — which is precisely what the
  // partner can reconstruct.
  //
  // And it is asked from THEIR chair, not ours: our own deduction counts the
  // cards we can see in their hand, so a pair of "4"s that only we can narrow
  // to green-or-black reads to us as a certain play and to them as nothing at
  // all. Declining a play they cannot prove we had is not a signal, it is a
  // discard — and they would answer it with a blank look, which is exactly what
  // happened in the game this came from.
  const audience = (view.viewerIndex + 1) % view.players.length;
  const declinedPlay = hasPendingPlay(view, view.viewerIndex, conventions, audience);
  // An alarm has to be a CHOICE the partner can see we made: either we declined
  // a play they know we had, or we had an ordinary chop to throw instead. With
  // neither, every option was a bad discard and throwing the cheapest is damage
  // control, not a message — which is exactly how the other end reads it
  // (alarmGuards' senderFree screen), so raising one here is the two sides
  // drifting: we would ask for guards nobody hears us ask for.
  if (!declinedPlay && chopIndex(myHand) < 0) return null;
  // 0. The free alarm: a card we can PROVE is worthless costs no pile points
  //    and no fuse to throw, so the forgone play is the entire price — and the
  //    entire signal. It needs that play: without one, throwing trash is the
  //    most ordinary move in the game and says nothing at all. Prefer an
  //    untouched one, which no partner can misread as a yield (that reading is
  //    only ever applied to a touched discard, see alarmGuards).
  if (declinedPlay) {
    const trash = [];
    for (let i = 0; i < myHand.length; i++) if (knownUseless(view, myCombos[i])) trash.push(i);
    const pick = trash.find((i) => !touched(myHand[i])) ?? trash[0];
    if (pick != null) {
      return { action: { type: 'discard', cardIndex: pick }, reason: 'ALARM: discarding trash instead of an obvious play' };
    }
  }
  // A touched card is only a signal if it is worth something WHATEVER it turns
  // out to be. `!knownUseless` says merely "it might be useful" — and when it
  // lands in the discard pile dead, the partner sees trash disposal, which is
  // exactly what their screen calls it. Requiring every candidate to still be
  // wanted makes the card they actually see match the message we meant.
  const provablyUseful = (i) => myCombos[i].length > 0
    && myCombos[i].every(([c, n]) => !isUseless(view, c, n));
  // A preference, not a requirement: a card that only *might* be useful still
  // carries the message most of the time, and the alternative to a shaky signal
  // here is no signal at all — the danger we are pointing at is certain.
  for (const sure of [true, false]) {
    for (let i = 0; i < myHand.length; i++) {
      if (!touched(myHand[i]) || knownUseless(view, myCombos[i]) || knownPlayable(view, myCombos[i])) continue;
      if (sure !== provablyUseful(i)) continue;
      if (myCombos[i].some(([c, n]) => identityCritical(view, c, n))) continue;
      return { action: { type: 'discard', cardIndex: i }, reason: 'ALARM: discarding a useful touched card' };
    }
  }
  // The riskier alarm types throw away an UNKNOWN own card (the chop, or a
  // card past it). Two ways to clear the bar:
  //   - mid-game: the endangered value must clearly beat the price of burning
  //     an own card AND the downstream cost of the alarm itself (it forces the
  //     partner to guard two cards, clogging their hand for the rest of the
  //     game) — a fixed static threshold of 2 prices that in;
  //   - late game (deck nearly empty): little game is left for the guard-clog
  //     to hurt and any lost critical is permanent, so the downstream cost
  //     nearly vanishes and the plain EV test applies — sacrifice when the sure
  //     save (savedCost) beats the EXPECTED pile cost of the specific card we
  //     throw (an unclued card near the end is mostly spent copies, ~0.5).
  const chop = chopIndex(myHand);
  const late = view.deckSize <= 10;
  const worthIt = (i) => savedCost >= 2 || (late && savedCost > expectedDiscardCost(view, myCombos[i]));
  // Reached only when we hold no trash to throw instead (alarm 0). It costs no
  // more than that one: the chop is untouched, so throwing it consumes no hint
  // markers and the play target stays in hand (memory keeps it across a
  // discard) to be played next turn — but the chop is an UNKNOWN card, so what
  // it might have been has to be priced in.
  if (chop >= 0 && declinedPlay && worthIt(chop)) {
    return { action: { type: 'discard', cardIndex: chop }, reason: 'ALARM: discarding instead of an obvious play' };
  }
  if (chop >= 0) {
    let best = -1;
    let bestExp = Infinity;
    for (let i = chop + 1; i < myHand.length; i++) {
      if (touched(myHand[i]) || myHand[i].annotations?.guarded) continue;
      const exp = expectedDiscardCost(view, myCombos[i]);
      if (exp < bestExp) { best = i; bestExp = exp; }
    }
    if (best >= 0 && (savedCost >= 2 || (late && savedCost > bestExp))) {
      return { action: { type: 'discard', cardIndex: best }, reason: 'ALARM: discarding past the chop' };
    }
  }
  let best = -1;
  let bestCost = Infinity;
  for (let i = 0; i < myHand.length; i++) {
    // Same preference: a "critical" card whose pile can no longer reach it is
    // trash on the table and reads as trash, however dearly we paid for it — so
    // a certainly-useful one is worth a tie-break's worth of cost.
    if (!touched(myHand[i]) || !provablyCritical(view, myCombos[i])) continue;
    const cost = Math.max(...myCombos[i].map(([c, n]) => discardCost(view, c, n)))
      + (provablyUseful(i) ? 0 : 0.5);
    if (cost < savedCost && cost < bestCost) {
      best = i;
      bestCost = cost;
    }
  }
  if (best >= 0) {
    return { action: { type: 'discard', cardIndex: best }, reason: 'ALARM: sacrificing a cheaper critical' };
  }
  return null;
}

// --- Off-guard inference (only when guards aren't shared). ---
// With shareGuarded off we cannot see the guard marks our own alarms prompt, so
// on later turns we'd think the same criticals are still on the chop and alarm
// again and again. Instead we remember which cards each alarm made the receiver
// guard (their oldest unclued cards, per the alarmGuards convention) and re-mark
// them ourselves, so our chop/exposed model matches what the receiver actually
// did. Kept in driver memory as a Set of card ids; inert when guards are shared.

// After choosing an alarm against `idx`, record the cards it will guard: the
// receiver marks their oldest `count` still-unclued, still-unguarded cards.
function recordInferredGuards(view, memory, idx, count) {
  if (!memory) return;
  if (!memory.inferredGuards) memory.inferredGuards = new Set();
  for (const id of alarmGuardTargets(view, idx, count)) memory.inferredGuards.add(id);
}

// Re-apply remembered guards to this turn's view, and forget ids for cards that
// have since left every hand (played/discarded).
function applyInferredGuards(view, memory) {
  const ids = memory?.inferredGuards;
  if (!ids || ids.size === 0) return;
  const present = new Set();
  for (const p of view.players) {
    for (const c of p.hand) {
      if (ids.has(c.id)) {
        c.annotations = { ...(c.annotations || {}), guarded: true };
        present.add(c.id);
      }
    }
  }
  for (const id of ids) if (!present.has(id)) ids.delete(id);
}

// Was this identity already dead before the discard that put it in the pile?
// Only the last copy of an identity can move its pile's cap, so anything else
// is judged as it stands; for a last copy, a pile capped exactly at its own
// number was capped BY it, and it was alive a moment ago.
function deadWhenThrown(view, color, number, viewerSeat) {
  if (!isUseless(view, color, number)) return false;
  const pile = view.playedPiles[color];
  const suit = suitOf(view, color);
  const played = pile.count > 0
    && (suit.direction === 'up' ? number <= pile.top : number >= pile.top);
  if (played) return true;
  const k = `${color}_${number}`;
  const totals = deckCounts(view);
  const visible = visibleCounts(view, [viewerSeat]);
  if ((visible.get(k) || 0) < (totals.get(k) || 0)) return true; // copies left: not our doing
  return suit.direction === 'up' ? number > pile.cap + 1 : number < 6 - pile.cap - 1;
}

// Receiver side of the alarm convention: when my predecessor's last action
// was an out-of-the-ordinary discard, guard my oldest unclued card(s) with
// the annotate interface (turn-free), which moves my chop. Guard 2 cards
// when the alarmer still had hint tokens (they chose the alarm because one
// hint couldn't cover everything endangered), 1 when they had none (the
// alarm was their only way to speak). The unguarded rest of the hand isn't
// thereby safe — the alarmer can follow up with hints or another alarm.
// Returns ids of own cards to mark guarded.
export function alarmGuards(view, conventions = STANDARD_CONVENTIONS) {
  if (!conventions.alarmDiscards) return [];
  if (view.status !== 'playing' || view.deckSize === 0) return []; // endgame search moves are deliberate
  const me = view.viewerIndex;
  if (me < 0) return [];
  const n = view.players.length;
  const e = lastRealAction(view);
  if (!e || e.type !== 'discard') return [];
  if (e.playerIndex !== (me + n - 1) % n) return [];
  // A yield reads exactly like a touched-discard alarm from the outside: both
  // shed a useful clued card. What separates them is us — a yield only happens
  // for a card WE are obliged to play, so if the discarded identity is one our
  // own outstanding obligation could be, read it as them stepping aside rather
  // than as a warning. Nothing to guard; we just play ours (see yieldSlots).
  if (conventions.yieldDuplicatePlays && e.wasTouched) {
    const myHand = view.players[me].hand;
    const myCombos = handCombos(view, me);
    const obliged = new Set();
    if (conventions.playAllOnes) {
      for (const i of onesPlayObligations(view, myHand, myCombos)) obliged.add(i);
    }
    if (conventions.colorHintPlaysNewest) {
      for (const t of colorPlayTargets(myHand, (s) => possiblyPlayable(view, myCombos[s]))) obliged.add(t);
    }
    for (const i of obliged) {
      if (myCombos[i].some(([c, n]) => c === e.card.color && n === e.card.number)) return [];
    }
  }
  // Discarding at all while holding a play the conventions oblige is deliberate,
  // whatever was thrown: the tempo was given up on purpose. This is the
  // receiver's own reading, not just a provable play — a live colour-hint target
  // is a firm obligation even though it is only *possibly* playable — and it is
  // the same hasPendingPlay call the sender makes, so the two ends can't drift.
  // It comes FIRST because the touched-discard screens below read "the card was
  // dead" and "they had no chop left" as routine or forced, and neither is
  // routine when a play was there to be made: throwing known trash costs the
  // discarder nothing but the forgone play, which makes it the cheapest alarm
  // there is, not the quietest move there is.
  const declinedPlay = hasPendingPlay(view, e.playerIndex, conventions);
  let anomaly = declinedPlay;
  if (!declinedPlay && e.wasTouched) {
    // A deliberate touched-discard alarm burns a USEFUL card — if the card
    // was actually dead, this was routine trash disposal (the discarder's
    // elimination can outrun what we can reconstruct). The question is whether
    // it was dead when they THREW it, not now: the pile cap we are reading
    // already counts this discard, and sacrificing the last copy of a needed
    // card is exactly what caps its pile just short of it. Asking "is it
    // useless?" of the state it produced answers yes for every deliberate
    // sacrifice — the loudest alarm there is, dismissed as taking out the
    // rubbish. So when it was the last copy, we give it back before judging.
    if (deadWhenThrown(view, e.card.color, e.card.number, me)) return [];
    // And if the discarder had no chop — every other card clued or guarded
    // (their newest card is the post-discard draw) — the touched discard was
    // forced normality, not a signal.
    const senderFree = view.players[e.playerIndex].hand
      .filter((c) => !c.colorClued && !c.numberClued && !c.annotations?.guarded).length;
    if (senderFree <= 1) return [];
    // Otherwise it's an alarm unless it was provable trash from the
    // discarder's knowledge at the time (their recorded constraints, plus
    // the copies visible to both of us — never my own hidden hand).
    const totals = deckCounts(view);
    const visible = visibleCounts(view, [me, e.playerIndex]);
    const dk = `${e.card.color}_${e.card.number}`;
    const combos = [];
    for (const c of e.knownColors ?? []) {
      for (const num of e.knownNumbers ?? []) {
        const k = `${c}_${num}`;
        // The discarded card itself now sits in the pile — don't count it
        // against its own identity.
        if ((visible.get(k) || 0) - (k === dk ? 1 : 0) < (totals.get(k) || 0)) combos.push([c, num]);
      }
    }
    anomaly = !(combos.length > 0 && combos.every(([c, num]) => isUseless(view, c, num)));
  } else if (!declinedPlay && e.chopIndex != null && e.chopIndex >= 0 && e.cardIndex !== e.chopIndex) {
    anomaly = true; // discarded past the chop
  }
  if (!anomaly) return [];
  // The discard restored a token, so the alarmer decided with one fewer.
  return alarmGuardTargets(view, me, view.hintTokens - 1 > 0 ? 2 : 1);
}

// The cards an alarm asks a seat to guard: their oldest `count` still-unclued,
// still-unguarded cards. One definition, read from three sides — the receiver
// deciding what to mark (alarmGuards), the sender remembering what its alarm
// will have marked when guards aren't shared (recordInferredGuards), and the
// driver checking whether a human receiver answered at all (bots.js).
export function alarmGuardTargets(view, seat, count) {
  const hand = view.players[seat]?.hand ?? [];
  const ids = [];
  for (let i = 0; i < hand.length && ids.length < count; i++) {
    const c = hand[i];
    if (!c.colorClued && !c.numberClued && !c.annotations?.guarded) ids.push(c.id);
  }
  return ids;
}

// A "1" hint obligates every touched 1, but the receiver knows only that they
// ARE 1s — not their colours — so it cannot tell a live 1 from one whose colour
// has since been played (by us, or by anyone). Its own "don't play a provably
// dead card" gate can't fire, because from its side the card could still be one
// of the colours that remain open. Only a player who can SEE the card can tell,
// so warning is the sender's responsibility.
//
// The warning is a colour hint on the dead 1's own colour: it pins the card
// (colour + the 1 they already know), which both makes it provably unplayable —
// so the receiver's existing gate now fires — and, per the reveal exception,
// turns the whole "1" order back into information ("that's the dead duplicate").
// A hint that would leave a harmful colour play target behind is rejected.
//
// Returns null when nothing is endangered or no hint proves it.
function findDeadOneWarning(view, seat, conventions) {
  if (!conventions.playAllOnes || view.hintTokens <= 0) return null;
  const hand = view.players[seat].hand;
  const combos = handCombos(view, seat);
  const ones = onesPlayObligations(view, hand, combos);
  if (ones.length === 0) return null;
  // Already reads as information: a pinned 1 disables the play order entirely.
  if (ones.some((i) => combos[i].length === 1)) return null;
  // The 1 they would actually play next, under the same gate decideCore uses.
  const next = ones.find(onesPlayGate(view, seat, ones, combos));
  if (next === undefined) return null;
  const victim = hand[next];
  if (!isUseless(view, victim.color, victim.number)) return null; // genuinely playable
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length === 0) continue;
    const after = combosFor(view, afterColorHint(view, hand, color), [seat, view.viewerIndex]);
    // It must actually prove the dead 1 unplayable from their side.
    if (possiblyPlayable(view, after[next])) continue;
    // And must not hand them a colour target that would misfire (the slide in
    // colorPlayTargets picks the newest touched card they can't rule out).
    const afterHand = afterColorHint(view, hand, color);
    const [target] = colorPlayTargets(
      afterHand.map((c, i) => (touched.some((t) => t.i === i)
        ? { ...c, lastHints: [...c.lastHints, { hintIndex: Infinity, hintType: 'color', value: color }] }
        : c)),
      (slot) => possiblyPlayable(view, after[slot]),
    ).slice(-1);
    if (target !== undefined && !isPlayable(view, hand[target].color, hand[target].number)) continue;
    return { hintType: 'color', value: color };
  }
  return null;
}

// One-move look-ahead on saves. A keep-style save parks the chop behind a
// clue — which slides the receiver's next discard onto their next unclued
// card. If that card is save-worthy too, one hint can't protect both: save
// whichever loss would cost the team more points and accept exposing the
// cheaper one (a chop rainbow 5 with rainbow 2 right behind it gets the "2"
// hint — losing the 5 costs 1 point, losing the 2 costs 4).
function pickSave(view, seat, chop, conventions) {
  const hand = view.players[seat].hand;
  const primary = findSaveHint(view, seat, chop, conventions);
  if (!primary) return null;
  // A play-save gets the card played: the receiver discards nothing.
  if (primary.how === 'play') return { index: chop, ...primary };
  // Where the receiver's discard lands after a hint's clue marks are down: the
  // oldest card that is neither clued, guarded, nor touched by this hint. A
  // guarded card is off the chop (the receiver won't discard it), so the slide
  // skips it — without this the bot sees a guarded critical as still-endangered
  // and re-alarms to "save" a card the receiver already protected.
  const exposedIndex = (hint) => {
    const touches = (card) => (hint.hintType === 'number'
      ? card.number === hint.value
      : touchedColorSet(view, hint.value).has(card.color));
    return hand.findIndex((card) => !card.colorClued && !card.numberClued
      && !card.annotations?.guarded && !touches(card));
  };
  // Pile points lost if the card at index i is discarded. A lone-2 whose twin
  // is still in the deck is save-worthy but NOT identityCritical, so its
  // discardCost is 0 — losing it costs no pile points (the twin will come). It
  // must therefore weigh less than a certain last-copy (a 5, or a 2 whose twin
  // is already gone) when we choose which exposure to accept and whether to
  // alarm; flooring it to 1 made a recoverable 2 look as expensive as a
  // guaranteed critical, which triggered self-sacrificing alarms to protect a
  // 2 while a genuine critical sat exposed.
  const cost = (i) => (i >= 0 ? discardCost(view, hand[i].color, hand[i].number) : 0);
  const primaryExposed = exposedIndex(primary.hint);
  let best = { index: chop, ...primary, exposed: cost(primaryExposed) };
  if (best.exposed > 0) {
    const alt = findSaveHint(view, seat, primaryExposed, conventions);
    if (alt && (alt.how === 'play' || cost(exposedIndex(alt.hint)) < best.exposed)) {
      best = {
        index: primaryExposed,
        ...alt,
        exposed: alt.how === 'play' ? 0 : cost(exposedIndex(alt.hint)),
      };
    }
  }
  return best;
}

// A colour "sweep" save: in rainbow-bearing variants one colour hint touches
// every rainbow card at once, so it can clue TWO endangered criticals the same
// turn — something no single number hint can do when they differ (a rainbow 5
// on the chop with a rainbow 4 right behind it). The price is that the hint's
// newest touched card becomes a play target; we only sweep when that newest
// card is provably useless (dead), so the induced play is a harmless misfire —
// or the receiver, seeing it is dead, simply keeps everything. Either way both
// criticals end up clued and off the chop. This is the hint-form of the alarm:
// a deliberate throwaway (here a wasted play, not a discard) that buys the
// protection a normal save can't. Used only when a normal save can't shield
// every endangered card and a fuse can be spared. `endangered` is the set of
// save-worthy untouched card indices in the receiver's hand.
function findSweepSave(view, seat, endangered) {
  if (endangered.length < 2) return null;
  const hand = view.players[seat].hand;
  for (const color of view.hintableColors) {
    const touched = colorHintTouches(view, hand, color);
    if (touched.length < 2) continue;
    const newest = touched[touched.length - 1];
    // The play target the hint creates must be a dead card (harmless misfire),
    // and none of the criticals may be the newest (they'd become the target).
    if (endangered.includes(newest.i)) continue;
    if (!isUseless(view, newest.card.color, newest.card.number)) continue;
    // Every endangered critical must be swept off the chop (clued).
    if (!endangered.every((i) => touched.some((t) => t.i === i))) continue;
    // The dead newest must be the ONLY play the hint reads as — no other
    // touched card should come out provably playable and misfire.
    const after = combosFor(view, afterColorHint(view, hand, color), [seat, view.viewerIndex]);
    if (touched.some((t) => t.i !== newest.i && knownPlayable(view, after[t.i]))) continue;
    return { hint: { hintType: 'color', value: color }, newest: newest.i };
  }
  return null;
}

// Any legal hint that changes as little as possible: prefer re-hinting a
// number the player already has clued (pure "keep" reinforcement).
function findStallHint(view, hand, conventions = STANDARD_CONVENTIONS) {
  // A "1" is never a harmless value to stall with while play-all-1s is on: it
  // is a play ORDER, and a receiver who trusts it can misfire — fatally so on
  // the last fuse. Skip the value rather than accidentally command a play.
  const harmless = (c) => !(conventions.playAllOnes && c.number === 1);
  const pick = (cards) => (cards.length ? { hintType: 'number', value: cards[cards.length - 1].number } : null);
  return pick(hand.filter((c) => c.numberClued && harmless(c))) || pick(hand.filter(harmless));
}

// A harmless stall hint to whoever accepts one (closest player first).
function stallAction(view, conventions = STANDARD_CONVENTIONS) {
  const me = view.viewerIndex;
  for (let step = 1; step < view.players.length; step++) {
    const idx = (me + step) % view.players.length;
    const stall = findStallHint(view, view.players[idx].hand, conventions);
    if (stall) return { type: 'hint', toPlayerIndex: idx, ...stall };
  }
  return null;
}

// A stall we're forced into (no play, nothing safe to discard) spends a hint
// token on a do-nothing keep-hint. If a partner's chop is save-worthy, spend
// that same token protecting it instead — even when the partner has a pending
// play, so the section-0 save was skipped on the assumption they'll play and
// not discard. The save is free here (we were going to burn the token anyway)
// and it guards the critical card if the partner discards after all — the exact
// failure where a known-playable partner still dumps their critical chop.
// Returns { action, reason } (protective save preferred, harmless stall else).
export function protectiveStall(view, conventions = STANDARD_CONVENTIONS) {
  const me = view.viewerIndex;
  for (let step = 1; step < view.players.length; step++) {
    const idx = (me + step) % view.players.length;
    const hand = view.players[idx].hand;
    const chop = chopIndex(hand);
    if (chop >= 0 && saveWorthy(view, hand[chop])) {
      const save = findSaveHint(view, idx, chop, conventions);
      if (save) {
        return {
          action: { type: 'hint', toPlayerIndex: idx, ...save.hint },
          reason: `stall-save ${hand[chop].color} ${hand[chop].number} on ${view.players[idx].name}'s chop (${save.how})`,
        };
      }
    }
  }
  const stall = stallAction(view, conventions);
  return stall ? { action: stall } : null;
}

// --- The decision. ---
// view: an in-room playing view where view.currentPlayer === view.viewerIndex.
// Returns { action, reason }.
// `memory` is an optional driver-owned plain object: the brain keeps the
// forced-play convention's pointer count (and whatever future conventions
// need) in it across turns. Pass the same object every turn for the same
// seat; without it the memory-based conventions stay off.
export function decide(view, conventions = STANDARD_CONVENTIONS, memory = null) {
  // With the deck empty the endgame is exactly computable (see below); use
  // the search over the last few cards, where the uncertainty is small
  // enough to enumerate and the rollouts are short enough to afford.
  const cardsLeft = view.players.reduce((sum, p) => sum + p.hand.length, 0);
  if (view.deckSize === 0 && cardsLeft <= 6 && view.players[view.viewerIndex].hand.length > 0) {
    const searched = endgameSearch(view, conventions);
    if (searched) return searched;
  }
  return decideCore(view, conventions, memory);
}

// The convention-following policy: used directly during the main game, and as
// the rollout policy (for ourselves and for teammates) inside the search —
// rollouts pass no memory, so the memory-based conventions don't fire there.
function decideCore(view, conventions = STANDARD_CONVENTIONS, memory = null) {
  const me = view.viewerIndex;
  const myHand = view.players[me].hand;
  const myCombos = handCombos(view, me);
  const nextIndex = (me + 1) % view.players.length;
  // Our reading of which touched cards a colour hint could still be pointing at.
  const canStillPlay = (slot) => possiblyPlayable(view, myCombos[slot]);

  // Capture our live colour-hint play targets by card id before any branch
  // below can return an action that consumes their markers — so the obligation
  // survives an unrelated touched card being discarded (see rememberColorTargets).
  rememberColorTargets(myHand, memory, myLastHandExit(view, me), canStillPlay);

  // When guards aren't shared, re-apply the ones our past alarms prompted so the
  // danger model below sees the receiver's real (hidden) chop, not a stale one.
  if (memory && !view.shareGuarded) applyInferredGuards(view, memory);

  // Every slot a convention currently marks for play, and of those, the ones a
  // teammate is already obliged to play and can't identify — ours to shed
  // rather than race for (see yieldSlots).
  const playCandidates = new Set();
  myHand.forEach((_, i) => { if (knownPlayable(view, myCombos[i])) playCandidates.add(i); });
  if (conventions.colorHintPlaysNewest) {
    for (const t of mergedColorTargets(myHand, memory, canStillPlay)) playCandidates.add(t);
  }
  if (conventions.playAllOnes) {
    for (const i of onesPlayObligations(view, myHand, myCombos)) playCandidates.add(i);
  }
  const yielded = yieldSlots(view, myCombos, conventions, playCandidates);

  // The danger we can see coming: a player who, with nothing to play, will
  // discard a chop we can't afford to lose. The next player is ours to save;
  // players further along only when everyone between us and them has a
  // pending play (they'll spend their turn playing, not saving). The first
  // player free to act can handle anyone beyond them, so the scan stops.
  // When hints can't cover the danger — no tokens at all, or the best save
  // still exposes a second endangered card — an alarm discard (see
  // findAlarmMove) makes the next player guard instead.
  let urgentSave = null;
  if (conventions.numberHintSaves) {
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      if (hasPendingPlay(view, idx, conventions)) continue;
      const hand = view.players[idx].hand;
      const chop = chopIndex(hand);
      if (chop >= 0 && saveWorthy(view, hand[chop])) {
        const save = view.hintTokens > 0 ? pickSave(view, idx, chop, conventions) : null;
        const exposed = save ? save.exposed ?? 0 : 0;
        // Prefer handing this player a play over parking their chop behind a
        // keep/pin clue. A hinted player plays rather than discards, so the
        // endangered chop survives this turn untouched — and because we strictly
        // alternate with them, we come back around to save it for real before
        // they could ever discard it. Deferring buys tempo (they don't burn a
        // turn discarding a useful card just to sit behind the clue, which is
        // what parking the chop makes them do) and can save a token later — a
        // card drawn onto the same colour may let one hint then cover both.
        // Skip when the chop is playable now (a play-save both scores AND
        // protects, strictly better) or in the final round (no next turn to
        // defer the save into). Restricted to 2-player: only there does the
        // strict alternation guarantee we re-save in time, and only there does
        // tempo dominate enough to beat spending a second token on the deferred
        // save (benchmarks regress slightly at 3-4 players).
        if (view.players.length === 2 && save && save.how !== 'play' && view.finalTurn === null) {
          const playHint = findPlayHint(view, idx, conventions);
          if (playHint) {
            urgentSave = {
              action: { type: 'hint', toPlayerIndex: idx, ...playHint },
              reason: `play hint for ${view.players[idx].name} (defers ${hand[chop].color} ${hand[chop].number} chop save)`,
            };
          }
        }
        // Sweep save (preferred over a discard alarm): one colour hint clues
        // two rainbow criticals at once, forcing a harmless misfire on a
        // provably-dead newest card. It risks ZERO points — the thrown card is
        // certainly useless — at the cost of a single fuse, which is nearly free
        // with a couple to spare. A discard alarm instead sacrifices an UNKNOWN
        // own card that might turn out critical, so the sweep is the safer of
        // the two whenever it exists and a fuse can be spared.
        if (!urgentSave && conventions.alarmDiscards && idx === nextIndex && exposed > 0
          && view.hintTokens > 0 && view.fuseTokens >= 2) {
          const endangered = hand
            .map((c, i) => i)
            .filter((i) => !hand[i].colorClued && !hand[i].numberClued
              && !hand[i].annotations?.guarded && saveWorthy(view, hand[i]));
          const sweep = findSweepSave(view, idx, endangered);
          if (sweep) {
            urgentSave = {
              action: { type: 'hint', toPlayerIndex: idx, ...sweep.hint },
              reason: `sweep-save ${endangered.map((i) => `${hand[i].color} ${hand[i].number}`).join(' + ')} (dead ${hand[sweep.newest].color} ${hand[sweep.newest].number} misfires)`,
            };
          }
        }
        // Discard alarm (fallback when no sweep exists): the next player guards
        // their endangered cards after an out-of-the-ordinary discard.
        if (!urgentSave && conventions.alarmDiscards && idx === nextIndex && (!save || exposed > 0)) {
          const chopCost = Math.max(1, discardCost(view, hand[chop].color, hand[chop].number));
          const alarm = findAlarmMove(view, myHand, myCombos, Math.max(chopCost, exposed), conventions);
          if (alarm) {
            urgentSave = alarm;
            // Guards aren't shared: remember what this alarm makes the receiver
            // guard (oldest 2 cards if we still hold a token after the discard
            // restores one, else 1) so we don't re-alarm the same cards.
            if (memory && !view.shareGuarded) {
              recordInferredGuards(view, memory, idx, view.hintTokens > 0 ? 2 : 1);
            }
          }
        }
        if (!urgentSave && save) {
          urgentSave = {
            action: { type: 'hint', toPlayerIndex: idx, ...save.hint },
            reason: `save ${hand[save.index].color} ${hand[save.index].number} on chop (${save.how})`,
          };
        }
      }
      break;
    }
  }

  // 0a. Zero-card-hint convention: an empty hint aimed at us is an explicit
  //     "play your chop" command from a teammate who can see our hand. Honour
  //     it above everything — including a save — because our own next action
  //     consumes the signal, so deferring it loses the command entirely. Skip
  //     only if the chop is provably unplayable (a careless empty hint); an
  //     unclued chop is almost always possiblyPlayable, so this rarely bites.
  if (conventions.zeroHintPlaysChop && view.allowEmptyHints && emptyHintChopSignal(view)) {
    const chop = chopIndex(myHand);
    if (chop >= 0 && possiblyPlayable(view, myCombos[chop])) {
      return { action: { type: 'play', cardIndex: chop }, reason: 'empty hint: play chop' };
    }
  }

  // Dead-1 warning: a teammate is obligated to play a 1 whose colour is already
  // on the pile, and only we can see it (see findDeadOneWarning). Its worth
  // scales with the fuses, so it is offered at three different priorities below:
  // at 1 fuse the misplay ends the game, so it outranks even a save; at 2 it
  // beats ordinary play hints; at 3 a burnt fuse is affordable and it only fills
  // in after we have found nothing better to say.
  let deadOneWarning = null;
  if (view.hintTokens > 0) {
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      const warn = findDeadOneWarning(view, idx, conventions);
      if (warn) {
        deadOneWarning = {
          action: { type: 'hint', toPlayerIndex: idx, ...warn },
          reason: `warn ${view.players[idx].name}: that 1 is already played`,
        };
        break;
      }
    }
  }
  if (deadOneWarning && view.fuseTokens === 1) return deadOneWarning;

  // 0. The save outranks even our own play: the play keeps for next turn,
  //    the endangered card doesn't. Exception: in the final round a deferred
  //    play may never happen, so plays come first there.
  if (urgentSave && view.finalTurn === null) return urgentSave;

  // 0b. Forced-play signals (2-player deadlock; needs driver memory) — both
  //     the sender's pointer moves and the receiver's commanded play.
  const forced = forcedPlayStep(view, conventions, memory);
  if (forced) return forced;

  // 1-2b. The play our own conventions call for, if any. Held back rather than
  //       returned outright: while the partner is deadlocked, playing is an
  //       ORDER (see commandedPlayCost), and an order we do not mean is worth
  //       less than the turn it costs us to stay quiet.
  const ownPlay = (() => {
    // Every play the conventions call for, in the order they have always been
    // taken — provable first, then colour targets oldest-hint-first, then 1s.
    // That order still decides ties; what can move a candidate up it is landing
    // the card a teammate's hand is waiting on (see playUnlockScore).
    const candidates = [];
    const offer = (i, rank, reason) => {
      if (!candidates.some((c) => c.index === i)) candidates.push({ index: i, rank, reason });
    };
    // 1. Play a card we can prove is playable (hint constraints narrowed by
    //    copy-counting over everything we can see).
    for (let i = 0; i < myHand.length; i++) {
      if (knownPlayable(view, myCombos[i]) && !yielded.has(i)) {
        offer(i, 0, 'known playable');
      }
    }

    // 2. Play a pending colour-hint target, oldest hint first — skipping any
    //    target deduction says can't be playable.
    // We trust the sender and the convention: the target is theirs to choose, and
    // they can see the card. Requiring it to be *provably* playable (as the last
    // fuse used to) breaks that trust — the card sits unplayed while the sender,
    // who counts it as a pending play, withholds further help, and both sides
    // stall the game out. A target we can prove unplayable is already skipped by
    // the slide in colorPlayTargets, so what reaches here is what they asked for.
    if (conventions.colorHintPlaysNewest) {
      for (const t of mergedColorTargets(myHand, memory, canStillPlay)) {
        if (possiblyPlayable(view, myCombos[t]) && !yielded.has(t)) {
          offer(t, 1, 'colour hint marks touched card');
        }
      }
    }

    // 2b. Play-all-1s: every card touched by a "1" hint is to be played,
    //     oldest first, while it can still be a playable 1. Reveal exception,
    //     as with colour hints: once any obligated 1 is pinned to a single
    //     identity, the 1s read as information (e.g. "that's the dead
    //     duplicate"), not as a play order.
    if (conventions.playAllOnes) {
      // In a reverse-suit variant a "1" that could still be the reversed suit's
      // own 1 is a keep, not a play — see onesPlayObligations.
      const ones = onesPlayObligations(view, myHand, myCombos);
      if (!ones.some((i) => myCombos[i].length === 1)) {
        const willPlay = onesPlayGate(view, me, ones, myCombos);
        for (const i of ones) {
          if (yielded.has(i)) continue;
          if (willPlay(i)) offer(i, 2, 'play all 1s');
        }
      }
    }
    if (candidates.length === 0) return null;
    // Only ever a choice WITHIN a certainty class. A provable play jumped by a
    // merely-trusted one is a trade of information for tempo, and a losing one:
    // the certain card lands first, and what it puts on the pile can prove the
    // trusted card dead before we ever risk it. Measured — reordering across
    // classes moved fuse-outs 20 -> 27 per 3000 games for no score.
    const rank = Math.min(...candidates.map((c) => c.rank));
    const tied = candidates.filter((c) => c.rank === rank);
    let best = tied[0];
    let bestScore = -1;
    if (tied.length > 1) {
      // One deduction per teammate, reused across candidates: what changes
      // between them is only which card of ours lands, never their knowledge.
      const partners = view.players
        .map((_, seat) => seat)
        .filter((seat) => seat !== me)
        .map((seat) => ({ seat, combos: handCombos(view, seat) }));
      for (const c of tied) {
        const score = playUnlockScore(view, partners, myCombos[c.index]);
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
    }
    return {
      action: { type: 'play', cardIndex: best.index },
      reason: bestScore > 0 ? `${best.reason} (opens a play for the table)` : best.reason,
    };
  })();
  // The partner reads a play as "play yours too", so it is only ours to make
  // when we mean it (the signal above) or when what they would throw at it
  // costs no more than the discard we would otherwise make. Staying quiet still
  // leaves us the better half of the turn: with a token we can hint them out of
  // the deadlock, and without one our discard hands them one.
  const commanded = ownPlay ? commandedPlayCost(view, conventions) : null;
  const silenced = commanded !== null && commanded > ownDiscardCost(view, myCombos);
  if (ownPlay && !silenced) return ownPlay;

  // 3. Final-round case: nothing of our own to play after all, so the save
  //    (deferred at step 0) is back on the table.
  if (urgentSave) return urgentSave;

  if (view.hintTokens > 0) {
    // 3b. With one fuse already gone, sparing the next costs less than the tempo
    //     an ordinary play hint would buy.
    if (deadOneWarning && view.fuseTokens <= 2) return deadOneWarning;

    // 4. Give a play hint (closest player first; colour hints preferred).
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      if (hasPendingPlay(view, idx, conventions)) continue; // they already have a play
      const hint = findPlayHint(view, idx, conventions);
      if (hint) {
        return {
          action: { type: 'hint', toPlayerIndex: idx, ...hint },
          reason: `play hint for ${view.players[idx].name}`,
        };
      }
    }
    // 4a. All three fuses intact: the warning is worth a token only now that we
    //     have found nothing more productive to say.
    if (deadOneWarning) return deadOneWarning;
    // 4b. Zero-card-hint fallback: no ordinary play hint exists, but a player's
    //     chop is playable — signal it with an empty hint (touches nothing) so
    //     they play their chop. Closest player first, like the normal loop.
    if (conventions.zeroHintPlaysChop && view.allowEmptyHints) {
      for (let step = 1; step < view.players.length; step++) {
        const idx = (me + step) % view.players.length;
        if (hasPendingPlay(view, idx, conventions)) continue;
        const chop = chopIndex(view.players[idx].hand);
        if (chop < 0) continue;
        const card = view.players[idx].hand[chop];
        if (!isPlayable(view, card.color, card.number)) continue;
        const empty = findEmptyHint(view, idx);
        if (empty) {
          return {
            action: { type: 'hint', toPlayerIndex: idx, ...empty },
            reason: `empty hint → play chop for ${view.players[idx].name}`,
          };
        }
      }
    }
  }

  // 5. Discard: a provably useless card beats the chop; the chop beats
  //    guessing; guessing takes the oldest card.
  if (view.hintTokens < 8) {
    // The best free gamble we hold, used only by the forced branch below.
    // Taking it ahead of an ordinary discard was measured and is clearly worse
    // (fuse-outs roughly quintuple for no score): while a safe discard exists,
    // the card can wait — the odds only improve as the piles grow.
    const gamble = bestGamble(view, myCombos, yielded);
    const gambleOk = gamble && gamble.chance >= GAMBLE_MIN_CHANCE
      && view.fuseTokens >= GAMBLE_MIN_FUSES;
    for (let i = 0; i < myHand.length; i++) {
      if (knownUseless(view, myCombos[i])) {
        return { action: { type: 'discard', cardIndex: i }, reason: 'provably useless' };
      }
    }
    // A copy a teammate is already obliged to play is dead weight to us: shed it
    // rather than the chop, so the redundant card leaves and they play theirs.
    for (const i of yielded) {
      return { action: { type: 'discard', cardIndex: i }, reason: 'yield: partner is obliged to play this card' };
    }
    if (conventions.discardOldestUntouched) {
      const chop = chopIndex(myHand);
      if (chop >= 0) {
        return { action: { type: 'discard', cardIndex: chop }, reason: 'chop (oldest untouched)' };
      }
    }
    // Every card is clued: teammates spent hints marking them all as worth
    // keeping. Pick the genuinely least dangerous card — the one risking the
    // fewest pile points (ties go to the oldest). Screening only for
    // *provably* critical and then taking the oldest survivor was much too
    // coarse: a card that is critical on ONE of three candidate identities
    // passed that screen, so the bot would throw a possible red 5 while
    // holding a card it knew to be a spare yellow 3. If even the safest card
    // could be critical, and tokens remain, a harmless stall hint is cheaper
    // than gambling a card the team paid hints to protect; a provably safe
    // card is simply discarded (the draw keeps the game moving).
    // A card we guarded is exempt while anything else is available: guarding it
    // was our own answer to an alarm — the strongest statement the conventions
    // have that a card must not be thrown — and discardRisk cannot see that,
    // reading a wholly unclued guarded card as the safest thing in the hand
    // precisely because nothing is known about it.
    const guarded = (i) => !!myHand[i].annotations?.guarded;
    const throwable = myHand.map((_, i) => i).filter((i) => !guarded(i));
    let forced = 0;
    let forcedRisk = Infinity;
    for (const i of (throwable.length > 0 ? throwable : myHand.map((_, j) => j))) {
      const risk = discardRisk(view, myCombos[i]);
      if (risk < forcedRisk) {
        forced = i;
        forcedRisk = risk;
      }
    }
    // Nothing here is safe to throw. A free gamble is the better bet: the card
    // it plays can only be dead or playable, so the bet costs at most a fuse,
    // whereas the discard below can cost pile points outright. It also outranks
    // the stall — a stall only defers this same choice to a turn when the piles
    // have not moved, so the odds will be no better and a token will be gone.
    if (gambleOk && forcedRisk > 0) {
      return {
        action: { type: 'play', cardIndex: gamble.index },
        reason: `gamble: dead-or-playable at ${Math.round(gamble.chance * 100)}% (nothing safe to discard)`,
      };
    }
    const mightBeCritical = forcedRisk > 0;
    if (mightBeCritical && view.hintTokens > 0) {
      const stall = protectiveStall(view, conventions);
      if (stall) {
        return { reason: 'stall (nothing safe to discard)', ...stall };
      }
    }
    return { action: { type: 'discard', cardIndex: forced }, reason: 'forced: least dangerous' };
  }

  // 6. Tokens are full — discarding is illegal, so stall with a harmless hint
  //    (or a protective save on a partner's critical chop, same cost).
  const stall = protectiveStall(view, conventions);
  if (stall) {
    return { reason: 'stall (tokens full)', ...stall };
  }

  // 7. Tokens full AND nobody left to hint (lax endgame with empty hands):
  //    playing is the only legal move. Take the best odds available —
  //    a possibly-playable card, else the newest (least likely saved).
  for (let i = myHand.length - 1; i >= 0; i--) {
    if (possiblyPlayable(view, myCombos[i])) {
      return { action: { type: 'play', cardIndex: i }, reason: 'forced play (best odds)' };
    }
  }
  return { action: { type: 'play', cardIndex: myHand.length - 1 }, reason: 'forced play' };
}

// --- Endgame search. ---
// Once the deck is empty the game is fully determined up to the identity of
// our own hand: everyone else's cards are visible, and the unseen multiset
// (the full deck minus piles, discard, and visible hands) is exactly our
// hand. When the consistent assignments ("worlds") are few enough, simulate
// every legal action to the end of the game — teammates modelled as this
// same bot — and take the action with the best average final score.

// The one cost knob: every candidate action is simulated in every world, so a
// decision costs at most SEARCH_MAX_WORLDS × (hand size × 2 + hints) rollouts,
// each only a few moves long with the deck empty. Sized to cover a hand of 4-5
// wholly unclued cards (a human partner clues far less than the bot does, so
// those hands are exactly where the search is most needed), which is 24-120
// worlds — well past the 16 that fit when the enumeration double-counted.
const SEARCH_MAX_WORLDS = Number(process.env.HANABI_SEARCH_MAX_WORLDS ?? 120);

// All assignments of the unseen multiset to our hand slots that respect each
// slot's deduced candidates; null when there are too many to search.
function enumerateWorlds(view, myCombos) {
  const me = view.viewerIndex;
  const totals = deckCounts(view);
  const visible = visibleCounts(view, [me]);
  const remaining = new Map();
  for (const [k, total] of totals) {
    if (total - (visible.get(k) || 0) > 0) remaining.set(k, total - (visible.get(k) || 0));
  }
  const slots = view.players[me].hand.length;
  const worlds = [];
  const acc = [];
  const dfs = (slot) => {
    if (worlds.length > SEARCH_MAX_WORLDS) return;
    if (slot === slots) {
      worlds.push(acc.slice());
      return;
    }
    for (const [color, number] of myCombos[slot]) {
      const k = `${color}_${number}`;
      const left = remaining.get(k) || 0;
      if (left === 0) continue;
      remaining.set(k, left - 1);
      acc.push([color, number]);
      dfs(slot + 1);
      acc.pop();
      remaining.set(k, left); // restore the count we borrowed — NOT left + 1
    }
  };
  dfs(0);
  return worlds.length > SEARCH_MAX_WORLDS ? null : worlds;
}

// A full rules-engine state built from the view plus one hypothesis for our
// own hand. Everything in it is either public or hypothesised — the actual
// hidden state is never consulted.
function reconstructState(view, world) {
  const me = view.viewerIndex;
  let nextHintIndex = 0;
  for (const p of view.players) {
    for (const c of p.hand) {
      for (const h of c.lastHints) nextHintIndex = Math.max(nextHintIndex, h.hintIndex + 1);
    }
  }
  let nextId = 100000;
  return {
    status: 'playing',
    variantId: view.variantId,
    endRule: view.endRule,
    shareGuarded: false,
    allowEmptyHints: view.allowEmptyHints,
    seed: 0,
    players: view.players.map((p, seat) => ({
      id: `sim${seat}`,
      name: p.name,
      hand: p.hand.map((c, i) => ({
        id: c.id ?? nextId++,
        color: seat === me ? world[i][0] : c.color,
        number: seat === me ? world[i][1] : c.number,
        possibleColors: c.possibleColors.slice(),
        possibleNumbers: c.possibleNumbers.slice(),
        colorClued: c.colorClued,
        numberClued: c.numberClued,
        lastHints: c.lastHints.map((h) => ({ ...h })),
        annotations: { note: '', guarded: false },
      })),
    })),
    deck: [],
    discard: view.discard.map((c) => ({ ...c })),
    playedPiles: Object.fromEntries(view.suits.map((s) => {
      const pile = view.playedPiles[s.color];
      const cards = [];
      for (let i = 0; i < pile.count; i++) {
        cards.push({ id: nextId++, color: s.color, number: s.direction === 'up' ? i + 1 : 5 - i });
      }
      return [s.color, cards];
    })),
    hintTokens: view.hintTokens,
    fuseTokens: view.fuseTokens,
    currentPlayer: view.currentPlayer,
    turn: view.turn,
    finalTurn: view.finalTurn,
    log: [],
    endReason: null,
    nextHintIndex,
    nextLogSeq: 0,
    startedAt: 0,
    endedAt: null,
    initialDeckCards: [],
  };
}

// Every action we could legally take right now, most promising classes
// first (plays, then discards, then hints) so budget truncation keeps the
// essential options.
function candidateActions(view) {
  const me = view.viewerIndex;
  const out = [];
  for (let i = 0; i < view.players[me].hand.length; i++) out.push({ type: 'play', cardIndex: i });
  if (view.hintTokens < 8) {
    for (let i = 0; i < view.players[me].hand.length; i++) out.push({ type: 'discard', cardIndex: i });
  }
  if (view.hintTokens > 0) {
    for (let step = 1; step < view.players.length; step++) {
      const idx = (me + step) % view.players.length;
      const hand = view.players[idx].hand;
      for (const color of view.hintableColors) {
        if (colorHintTouches(view, hand, color).length > 0) {
          out.push({ type: 'hint', toPlayerIndex: idx, hintType: 'color', value: color });
        }
      }
      for (const n of [...new Set(hand.map((c) => c.number))]) {
        out.push({ type: 'hint', toPlayerIndex: idx, hintType: 'number', value: n });
      }
    }
  }
  return out;
}

function applySim(state, idx, action) {
  if (action.type === 'play') playAction(state, idx, action.cardIndex);
  else if (action.type === 'discard') discardAction(state, idx, action.cardIndex);
  else hintAction(state, idx, action.toPlayerIndex, action.hintType, action.value);
}

// Play a reconstructed state out to its end with the convention policy.
// The evaluation is the final score minus a point per fuse burned along the
// way: a lost fuse is "free" in raw score until the third one, so without
// the penalty the search treats fuses as gambling chips — and three turns of
// "free" gambles compound into fuse-outs the per-turn model never sees.
function rolloutValue(state, conventions) {
  const fusesBefore = state.fuseTokens;
  let guard = 0;
  while (state.status === 'playing' && guard++ < 60) {
    const idx = state.currentPlayer;
    applySim(state, idx, decideCore(viewState(state, idx), conventions).action);
  }
  const score = Object.values(state.playedPiles).reduce((sum, pile) => sum + pile.length, 0);
  return score - (fusesBefore - state.fuseTokens);
}

// Tie-break among endgame moves that reach the same worst/avg score. The
// search models the partner as this same bot, so once a win is guaranteed
// every move looks equal — including reckless-looking ones. When a real human
// sits across the table this matters. Preference order:
//   +1  a hint that hands the partner an actionable play (they win with it now)
//    0  a discard, or a play that could still score in some world (a real gamble)
//   -1  a hint touching only dead cards — inert to a bot, but a human may read
//       it as a play cue and misfire
//   -2  "playing" a provably dead card — a guaranteed wasteful misfire, strictly
//       worse than discarding the same card; only taken when nothing ties it
// The maximin worst/avg still decides first; this only orders genuine ties.
export function endgameHelpfulness(view, action, myCombos) {
  if (action.type === 'play') {
    return knownUseless(view, myCombos[action.cardIndex]) ? -2 : 0;
  }
  if (action.type !== 'hint') return 0;
  const seat = action.toPlayerIndex;
  const hand = view.players[seat].hand;
  const after = action.hintType === 'color'
    ? combosFor(view, afterColorHint(view, hand, action.value), [seat, view.viewerIndex])
    : combosFor(view, afterNumberHint(hand, action.value), [seat, view.viewerIndex]);
  const touched = hand
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (action.hintType === 'color'
      ? touchedColorSet(view, action.value).has(c.color)
      : c.number === action.value));
  const enablesPlay = touched.some(({ i }) => knownPlayable(view, after[i]))
    || (action.hintType === 'color' && touched.length > 0
      && possiblyPlayable(view, after[touched[touched.length - 1].i]));
  if (enablesPlay) return 1;
  if (touched.length > 0 && touched.every(({ c }) => isUseless(view, c.color, c.number))) return -1;
  return 0;
}

// Maximin over worlds: a candidate is judged by its worst-case final score,
// then the average, then helpfulness to a human partner (see above) as the
// final tie-break. Average-maximizing turned out to gamble itself into
// fuse-outs — the model assumes future turns follow the safe convention
// policy, but a real future turn would gamble again, compounding risk the
// simulation never sees. Worst-case-first only accepts risks that cost nothing
// in any consistent world.
function endgameSearch(view, conventions) {
  const myCombos = handCombos(view, view.viewerIndex);
  const worlds = enumerateWorlds(view, myCombos);
  if (!worlds || worlds.length === 0) return null;
  // Every candidate is judged, never a prefix of them: a per-decision sim budget
  // that trimmed the list dropped whole action classes (the hints sit last), so
  // in a wide position the "search" could end up ranking play-slot-0 against
  // nothing. The world cap alone bounds the work.
  const candidates = candidateActions(view);
  let best = null;
  for (const action of candidates) {
    let total = 0;
    let worst = Infinity;
    let ok = true;
    for (const world of worlds) {
      const state = reconstructState(view, world);
      try {
        applySim(state, view.viewerIndex, action);
        const value = rolloutValue(state, conventions);
        total += value;
        worst = Math.min(worst, value);
      } catch {
        ok = false; // illegal in some world — not worth reasoning around
        break;
      }
    }
    if (!ok) continue;
    const avg = total / worlds.length;
    const help = endgameHelpfulness(view, action, myCombos);
    if (!best
      || worst > best.worst
      || (worst === best.worst && avg > best.avg)
      || (worst === best.worst && avg === best.avg && help > best.help)) {
      best = { action, worst, avg, help };
    }
  }
  if (!best) return null;
  return {
    action: best.action,
    reason: `endgame search (${worlds.length} worlds, worst ${best.worst}, avg ${best.avg.toFixed(1)})`,
  };
}
