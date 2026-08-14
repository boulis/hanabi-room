# Future work

The central list of open items and the decisions taken on them. Anything
deferred, declined, or still undecided belongs here — including the "no"s, since
a closed question saves as much time as an open one.

Long-form design annexes live beside this file: [BOT_ROADMAP.md](./BOT_ROADMAP.md)
for the alternative-brain options (LLM, RL). What each bot version actually
changed, with benchmarks, is in [bot-performance.md](./bot-performance.md); how
the system works today is [CLAUDE.md](./CLAUDE.md). This file is only for what
hasn't been done.

**Status vocabulary**: `OPEN` (nobody has decided), `DECIDED` (settled, not yet
built), `DECLINED` (settled as a no), `DONE` (built — kept only where the
decision behind it is still worth reading).

---

## Deferred plays

**Status: OPEN.** Blocked on one table-convention decision (below), then a
measurement, then possibly a staged build.

Raised 2026-08-13 after a live 3-player game: the bot gave Thanassis a yellow
hint meaning "keep this", he read it as "this will be playable once Yannis plays
the rainbow 1, so it must be the rainbow 2", played it, and the only rainbow 4
in the deck misfired — capping that pile at 3. Neither side was being careless.
They were running different conventions.

### What the brain does today

Every playability question is asked against the piles **as they stand right
now**. `isPlayable` compares to the current pile top; `possiblyPlayable` and
`knownPlayable` build on it; the colour-hint target *slides past* anything not
playable now; `playHintCandidates` refuses to hint a card that isn't playable
now.

There is exactly one piece of future-tense machinery: `playableAfter(view,
color, number, played)` — playability after **one** named card lands. It powers
`playUnlockScore` (which of several plays opens the most for a teammate) and the
2-player forced-play signal. Nothing projects past one card, and nothing models
a queue of pending plays.

### The three layers, in ascending risk

1. **Deferred play clue** — the marked card becomes playable once plays *already
   obliged* resolve. The red 1 is queued in someone's hand; you clue the red 2 now.
2. **Prompt** — the marked card waits on a card *already clued* in someone's
   hand; the clue tells that player to play it first.
3. **Finesse** — the marked card waits on an *unclued* card that an earlier
   player is expected to blind-play.

The rainbow-4 misread was layer 1.

### The conflict that has to be resolved first

A colour hint currently means two different things depending on now-playability:

| target | today's meaning |
| --- | --- |
| possibly playable now | **play order** (trusted — played even if only *possibly* playable) |
| not playable now | slid past; the hint becomes a **pin**, i.e. information, and the basis of the pin-save |

Layer 1 collapses those into one meaning, and that collapse is what killed the
rainbow 4. So "add deferred plays" is not additive — done naively it deletes the
pin-save.

There is a resolution that costs nothing:

> **A target that isn't playable now is _held_, and played when the receiver can
> _prove_ it playable** — not when it merely looks playable.

Under that rule the pin-save survives untouched as the degenerate case: a
deferred play whose moment never comes is held forever, which is exactly what
"keep this" means. Same signal, same behaviour, nothing to disambiguate at the
table. The rainbow 4 gets held — after the rainbow 1 lands its candidates are
`{rainbow 2, rainbow 4}`, never provable, so it is never played.

The trust rule for *now-playable* targets must not change. `bot-performance.md`
records that demanding `knownPlayable` there deadlocked both sides into stall
loops.

### Proposed staging

1. **The projection primitive.** `playQueue(view, reader)`: the obliged plays the
   reader can identify, in turn order, applied to the piles. Pure, no behaviour
   change, testable alone. Generalises `playableAfter` from one card to a queue,
   and must respect turn order — a card only counts as "soon" if its enabler
   plays *before* it.
2. **Deferred play hints, sender and receiver as one rule.** Receiver: a colour
   target not playable now is held rather than slid past, and played once
   provable. Sender: `playHintCandidates` may aim at a card playable after the
   queue **only if the receiver will be able to prove it playable when the queue
   resolves** — the check that rejects, from the giving end, exactly the hint
   that cost the rainbow 4. Scored below immediate plays. Cannot create a new
   misfire class by construction. The win is pre-loading: hint the red 2 while
   the red 1 is queued, and the table chains instead of spending a turn per link.
3. **Prompts — maybe.** Well-defined, and `lastHints` already tracks what is
   clued. Real risk with human partners, so only after stage 2 has paid.

### Not proposed: finesses

**Status: DECLINED for now** (2026-08-14, my recommendation; revisit only if the
table explicitly asks). They need a blind play on faith, and one mismatch
between two people's reading burns a fuse *and* usually a critical card. Wrong
bet for a group still discovering it has different conventions to the bot.

### Blast radius

Wider than anything shipped so far: `hasPendingPlay` (a held target still counts
as pending — the 2.26 deferral logic depends on it, as do the alarm convention's
"declined an obliged play" and `findAlarmMove`), `yieldSlots`' implied identity,
`findSaveHint`'s pin branch (becomes redundant), `protectiveStall`, and
`deadlocked`. The endgame search is unaffected — it already enumerates the
future exhaustively.

### Before building

- **Measure the opportunity**: over a few thousand bot games, how often would a
  deferred play hint be both legal *and* provable-on-arrival? Under ~1/game,
  stage 2 is not worth its blast radius. Several per game, build it.
- **The question for the table**: is "hold until provable" what we actually
  play? If our convention is the human one — trust the sender, play it when the
  pile arrives even with two candidates left — the bot will look sluggish,
  holding cards we expect it to play, and the honest fix is different: sender-side
  guarantees plus our agreement to only send provable deferred clues. That is a
  table decision, not a code one.

---

## Bot brain

### `patient` convention set
**Status: OPEN.** Proposed in [BOT_ROADMAP.md](./BOT_ROADMAP.md) (July 2026):
urgency-gate hints (only hint plays that are next-to-act or on the chop, or when
tokens are plentiful), prefer chop-playable hints since they are a play and a
save at once. Estimated +1–2 points there. Note the roadmap's "where we are"
section is now stale — it predates 2.x and describes limits since fixed (danger
recognised only on the next player's chop; ~20–22/25 on `simple`, now 23.9).

### Alternative brains — LLM, RL
**Status: OPEN**, unchanged. Full analysis, costs and sequencing in
[BOT_ROADMAP.md](./BOT_ROADMAP.md). Nothing has been decided.

### The play-hint deferral is 2-player only
**Status: OPEN.** `decideCore`'s save scan defers a save by giving a play hint
instead, but only at 2 players — the comment records that 3–4p regressed
slightly when measured. That measurement predates 2.26's `turnOutlook`, which
now models what the next player's turn is committed to. Worth re-measuring: the
regression may have been the same "we took away their reason to speak" effect
that 2.26 diagnosed.

### The yield candidate set skips two of the "1"-order screens
**Status: OPEN**, known and deliberately out of scope in 2.25. `decideCore`
builds `playCandidates` (what `yieldSlots` reads) with bare
`onesPlayObligations`, not `onesPlayOrder` — so it lacks the reveal exception
and the last-fuse gate that every other reading of the order now shares. A 1
pinned to a single identity is therefore treated as a play candidate for yield
purposes though nobody would play it, which could shed a card we should keep.
Not known to have cost a game; left alone because changing it moves benchmarks
and 2.25 was a correctness fix.

### Colour-pin saves are ambiguous to a human partner
**Status: DECLINED 2026-08-13.** Proposed: when the receiver is a human seat
(views carry `isBot`), use the colour pin only if the pinned card is provably
*dead*, else fall back to the unambiguous number keep-hint. Declined by Thanassis
— the preference is to fix the underlying gap (deferred plays, above) rather
than special-case human seats. Recorded because the failure it addresses is
real and cost a rainbow 4; if deferred plays don't get built, this is the
cheap mitigation.

---

## Game rules

### Fuse-loss scoring is not configurable
**Status: OPEN since 2026-06-23**, never confirmed. On the third fuse the game
ends with the score **as it stands**. Standard Hanabi zeroes it; the friendlier
rule is more typical for casual play and was chosen unilaterally during the
original build. It has never been raised with the table, and there is no lobby
option for it. Decide whether to keep, switch, or expose it.

---

## Client

### No UI for a human's move reasoning
**Status: OPEN.** The protocol already accepts an optional `reasoning` string
(≤200 chars) on an `action` from any client, records it in the save, and shows it
in replay and finished games — bots write theirs on every move. Humans have no
way to enter one. A one-line input next to the action buttons would make the
replay of a human game as legible as a bot's.

---

## Decisions taken, for the record

- **2026-08-14 — deferral shape (2.26).** "Will not discard" comes in two grades
  and they are not interchangeable: a locked hand is a *fact* and cancels the
  save outright; an owed hint is a *forecast* and may only let our own play go
  first. Treating them alike cost −0.69/row and threw 0.8 extra last copies a
  game. Never defer over a last copy. Full numbers in `bot-performance.md`.
- **2026-08-14 — one action, one timestamp.** `rules.js` reads the clock once
  per action; the save event's `t` comes from the move, not from the write.
  Before this, 20 of 1500 resume round-trips rebuilt a log the live game never
  had, which is what made the test suite flaky.
- **2026-08-13 — the "1" order is read in one place** (`onesPlayOrder`), by every
  side of the convention. Sender/receiver drift is the bug class behind both 2.25
  and 2.26.
- **From the original build (2026-06-23), still standing**: no reset action (two
  independent abandon votes instead, so a mis-click is harmless); hints stay
  legal after the deck empties under the lax end rule; the seed is hidden until
  a game is finished.

## Corrected while writing this

`README.md` and `CLAUDE.md` both claimed there was no step-through replay
viewer. There has been one for some time — the library's **Review** button on
`replaySave`. Both sentences are fixed. The same stale trio (spectators, replay
viewer, multi-room "not implemented") was still sitting in the assistant's
project memory and has been corrected there too.
