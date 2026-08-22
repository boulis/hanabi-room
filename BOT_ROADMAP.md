# Bot roadmap — open work, in rough order of effort

Everything pending on the bot, nearest first: the small fixes at the top, the
conventions work in the middle, a different brain entirely at the bottom.
Decisions already taken — including the "no"s — are at the end, because a closed
question saves as much time as an open one.

Neighbouring documents: [bot-performance.md](./bot-performance.md) records what
each `BOT_VERSION` changed and its full benchmark table; [CLAUDE.md](./CLAUDE.md)
describes the conventions as they are actually implemented. This file is only
for what hasn't been done.

## Contents

1. [Where we are](#where-we-are)
2. [Small, known, localized](#small-known-localized) — the yield candidate set; the 2-player-only deferral
3. [A `patient` convention set](#a-patient-convention-set)
4. [Deferred plays](#deferred-plays) — the big conventions gap; opportunity measured, worth building at 3–4 players
5. [Option A — LLM brain](#option-a--llm-brain)
6. [Option B — reinforcement learning](#option-b--reinforcement-learning)
7. [Repo shape and the brain seam](#repo-shape-and-the-brain-seam)
8. [Decisions on record](#decisions-on-record)
9. [Keeping this document current](#keeping-this-document-current)

---

## Where we are

`bot.mjs` is a WebSocket client; `server/botBrain.js` is a pure function
`decide(view, conventions, memory) → { action, reason }` fed the same filtered
view a human client renders. The bot cannot cheat by construction — hidden
information never reaches it. Everything below is a different implementation of
that one seam; transport, seating, reconnects, and the retry-with-safe-fallback
path stay as they are. Bots also run in-process as ordinary room seats
(`server/bots.js`), which is how they are normally played with.

**`BOT_VERSION` 2.29** (August 2026). Benchmark, 50 seeds a row, lax:

| variant | 2p | 3p | 4p |
| --- | --- | --- | --- |
| `simple` /25 | 23.80 | 24.46 | 24.34 |
| `rainbow` /30 | 28.50 | 29.32 | 29.22 |
| `rainbowCritical` /30 | 27.28 | 29.18 | 28.56 |
| `rainbowCriticalBlack` /35 | 30.22 | 33.30 | 32.58 |
| `rainbowCriticalBlackReverse` /35 | 28.70 | 32.70 | 32.00 |

Over 3000 games (200 seeds × 15 rows): 28.900 mean per row, 1103 perfect games,
23 fuse-outs. Full tables per version in `bot-performance.md`.

These are the default benchmark, which runs with **empty hints off**; with
`--emptyhints` it is 29.133 mean per row, 1123 perfect, 25 fuse-outs. Anything
measured only under a room option belongs in that second table — 2.27's change
(the zero-card-hint signal reachable from a save) is gated on `allowEmptyHints`
and does not move the default table at all.

**Score is the wrong instrument for some changes.** 2.28 fixed two ways the
alarm convention disagreed with itself, and moved the table by +0.003. It is
worth roughly nothing between bots — a spurious guard mostly clogs a hand — and
a great deal with a human at the table, who cannot audit the signal and simply
believes it. The measure that showed it was sender/receiver agreement: over 4500
games, false alarm reads fell 112 -> 76 with missed alarms flat. When a change is
about the conventions *meaning the same thing at both ends*, measure that
directly and say so; do not let a flat benchmark row argue it away.

**What has changed since the first draft of this document (July 2026)**, which
listed three known limits:

- *"Spends hints at first opportunity (poor token economy)"* — much improved,
  not solved. Saves are now gated (a lone-2 precaution wants 3 tokens and is
  refused if it would lock the receiver's hand), stalls are spent protecting a
  partner's chop rather than wasted, and 2.26 declines to spend a token on a
  teammate whose turn is already committed to speech.
- *"Only recognizes danger on the next player's chop"* — fixed. The save scan
  walks the table, skipping seats whose turn is already accounted for, and 2.26's
  `turnOutlook` models what each seat's turn will be spent on (`play` / `hint` /
  `trash` / `discard`).
- *"No finesse/prompt-style inference"* — still true, and now the largest known
  gap. See [Deferred plays](#deferred-plays).

The brain has also grown machinery the July draft didn't anticipate: the alarm
convention and its guard reminder, copy-counting deduction with cross-card
elimination, the endgame search, forced-play signals, bot par scoring, and a
convention-drift discipline (sender and receiver must read a convention through
one function — the bug class behind 2.25 and 2.26 both).

---

## Small, known, localized

### The yield candidate set skips two of the "1"-order screens

**Status: OPEN**, known, deliberately out of scope when found (during 2.25).

`decideCore` builds `playCandidates` — the set `yieldSlots` reads — with bare
`onesPlayObligations`, not `onesPlayOrder`. So it lacks the reveal exception and
the last-fuse gate that every other reading of the "1" order now shares. A 1
pinned to a single identity is therefore treated as a play candidate for yield
purposes even though nobody would play it, which can shed a card we should keep.

Not known to have cost a game; left alone because changing it moves benchmarks
and 2.25 was a correctness fix that had to stay narrow. A few lines plus a
benchmark run.

### The play-hint deferral is 2-player only

**Status: OPEN**, worth re-measuring.

The save scan can defer a save by giving a play hint instead — a hinted player
plays rather than discards, so the endangered chop survives untouched — but the
rule is gated to 2 players, because 3–4p regressed slightly when it was measured.

That measurement predates 2.26's `turnOutlook`. The regression may well have been
the same effect 2.26 diagnosed: we hand a player a reason to act and then
discover their turn was already spoken for, or we take away a reason they had.
Re-measure with the outlook available; if it holds up, the gate is one condition.

---

## A `patient` convention set

**Status: OPEN.** Proposed in the July draft, still unbuilt, still the cheapest
guess at a point or two.

Urgency-gate the hints: only hint plays that are next-to-act or on the chop, or
when tokens are plentiful; prefer chop-playable hints, which are a play and a
save at once. Pure `botBrain.js` work, selectable via `CONVENTION_SETS` so it can
be benchmarked head-to-head against `standard` without disturbing it.

Note that 2.2x has already absorbed some of what "patient" was meant to buy (see
the token-economy note above), so the estimate of +1–2 points is now optimistic.
Measure before believing it.

---

## Deferred plays

**Status: OPEN.** The largest known gap. The opportunity has now been measured
(below): worth building at 3–4 players, not at 2. What remains blocking is one
table-convention decision.

Raised 2026-08-13 after a live 3-player game: the bot gave a yellow hint meaning
"keep this", the human read it as "this will be playable once Yannis plays the
rainbow 1, so it must be the rainbow 2", played it, and the only rainbow 4 in the
deck misfired — capping that pile at 3. Neither side was careless. They were
running different conventions.

### What the brain does today

Every playability question is asked against the piles **as they stand right
now**. `isPlayable` compares to the current pile top; `possiblyPlayable` and
`knownPlayable` build on it; the colour-hint target *slides past* anything not
playable now; `playHintCandidates` refuses to hint a card that isn't playable now.

There is exactly one piece of future-tense machinery: `playableAfter(view, color,
number, played)` — playability after **one** named card lands. It powers
`playUnlockScore` (which of several plays opens the most for a teammate) and the
2-player forced-play signal. Nothing projects past one card, and nothing models a
queue of pending plays.

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
| not playable now | slid past; the hint becomes a **pin**: information, and the basis of the pin-save |

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
   resolves** — the check that rejects, from the giving end, exactly the hint that
   cost the rainbow 4. Scored below immediate plays. Cannot create a new misfire
   class by construction. The win is pre-loading: hint the red 2 while the red 1
   is queued, and the table chains instead of spending a turn per link.
3. **Prompts — maybe.** Well-defined, and `lastHints` already tracks what is
   clued. Real risk with human partners, so only after stage 2 has paid.

### Blast radius

Wider than anything shipped so far: `hasPendingPlay` (a held target still counts
as pending — 2.26's deferral logic depends on it, as do the alarm convention's
"declined an obliged play" and `findAlarmMove`), `yieldSlots`' implied identity,
`findSaveHint`'s pin branch (becomes redundant), `protectiveStall`, and
`deadlocked`. The endgame search is unaffected — it already enumerates the future
exhaustively.

### The opportunity, measured (2026-08-14)

900 bot-vs-bot games — 5 variants × 60 seeds × 3 table sizes — counting, at
every decision with a token to spend, the hints whose focus card is not playable
now, *is* playable once the queue of already-obliged plays resolves, and which
the receiver could **prove** playable when that moment came. Colour hints only:
a number hint means keep, so it cannot carry a play order today. Re-run it with
`npm run deferred-opportunity` (`deferred-opportunity.mjs`; deterministic, and
the numbers below are `--seeds 60 --players 2,3,4`).

| players | turns/game offering one | distinct cards/game | …on a turn that was otherwise a discard or a stall |
| --- | --- | --- | --- |
| 2 | 0.23 | **0.17** | 0.10 |
| 3 | 1.72 | **1.51** | 0.80 |
| 4 | 3.44 | **2.42** | 1.17 |

Distinct *cards* is the value question — an opportunity standing for three turns
is one card pre-loaded, not three.

**The verdict is per table size, which the threshold above didn't anticipate.**
At 2 players there is essentially nothing to win: 0.17 cards a game, and the
queue of obliged plays is rarely long enough to make anything playable-later. At
3 and 4 it clears the bar — 1.5 and 2.4 cards a game could have their hint
before their moment rather than after it, roughly half of them on turns the bot
currently spends discarding or stalling. So this is a 3–4 player feature, which
is what our table plays.

Read it as an upper bound on *opportunity*, not on value: a card pre-loaded is
not a point gained, since most of those cards would get hinted a turn or two
later anyway. What the measurement settles is that the situation is common
enough to be worth the blast radius at 3+; only a benchmark of the built thing
settles what the tempo is worth.

The count is conservative in four places — one round of queue only, no draws
projected, the giver's model of a teammate's deduction cannot include our own
hand, and cards already carrying a live colour marker are excluded — so the true
rate is somewhat higher. It also measures positions *this* bot reaches; a bot
that pre-loads hints would reach different ones, probably with longer queues.

### Before building

- **The question for the table**: is "hold until provable" what we actually play?
  If our convention is the human one — trust the sender, play it when the pile
  arrives even with two candidates left — the bot will look sluggish, holding
  cards we expect it to play, and the honest fix is different: sender-side
  guarantees plus our agreement to only send provable deferred clues. That is a
  table decision, not a code one.

---

## Option A — LLM brain

**Status: OPEN**, nothing decided. An LLM brain is a drop-in async `decide`:

1. **Serialize the view to compact text** — piles, tokens, visible hands, own
   cards as constraint sets ("card 2: red|blue, 2|3, number-hinted t12"), discard,
   recent log. ~800–1,200 tokens per turn.
2. **Stable system prompt** carrying the rules and the conventions *verbatim*.
   Conventions become a text file rather than code — the cleanest realization of
   "select the conventions we play". Being stable, it prompt-caches; only the
   per-turn view is paid at full price.
3. **Structured output**: a JSON schema over `play/discard/hint` so replies
   always parse. Validate legality locally; on an illegal move, timeout, or
   refusal, fall through to the rule brain so the game never stalls.

**Honest expectation**: LLMs are mediocre at raw Hanabi deduction; with the
conventions spelled out an Opus-class model plays around the rule bot's level,
not above it — and that bar has risen since this was written (2.26 averages
24.4/25 on `simple` at 4 players). The value is flexibility and personality:
charitable interpretation of slightly-off human hints, table talk, explaining its
reasoning in chat. Note the protocol already carries a per-move `reasoning`
string that replay and finished games display — an LLM brain would fill it with
something worth reading.

**Recommended shape — hybrid**: the rule brain computes constraint facts and a
shortlist of sound moves; the LLM picks among them and does the talking. Caps
cost (smaller prompts) and caps the downside (it cannot misplay into a fuse the
rules forbid).

**Cost ballpark** (2-player game ≈ 35 bot moves; ~1K fresh input + ~2K cached +
~300 output per move; prices as of mid-2026):

| Model | $/MTok in/out | ≈ cost per game |
|---|---|---|
| Haiku 4.5 | 1 / 5 | ~$0.05 |
| Sonnet 5 (intro pricing) | 2 / 10 | ~$0.15–0.20 |
| Opus 4.8 | 5 / 25 | ~$0.40–0.50 |

Latency of 2–10 s per move reads as a thinking player — a feature, not a bug.
Implementation lives in this repo (`server/botBrainLLM.js`, `@anthropic-ai/sdk`
dependency, `ANTHROPIC_API_KEY` env var), selected via a `--brain` flag.

---

## Option B — reinforcement learning

**Status: OPEN**, nothing decided. Hanabi is *the* canonical multi-agent RL
benchmark: DeepMind's Hanabi Learning Environment (HLE, 2019) exists precisely
for this. Known 2-player self-play results: Rainbow-DQN ≈ 20/25, FAIR's SAD ≈ 24,
Off-Belief Learning (OBL) ≈ 24+. Scale is not the obstacle — HLE simulates
thousands of steps/second, and our own Node engine runs ~100 games/second/core,
so hundreds of thousands of games are hours of CPU, not a data problem.

Worth noting against those figures: the rule brain now averages 23.94 on 2-player
`simple` and 24.38 at 4 players, which is SAD territory for the 2-player game. A
trained agent would have to be aimed at the harder variants, or at partner
quality, to be worth the trouble.

**The trap: convention compatibility.** Self-play agents invent private codes
("red hint = play slot 3") that are gibberish to humans — they score 24 with
their clone and single digits with you. This is the open research problem the
benchmark was built around (ad-hoc teamplay). If the goal is a strong partner
*for our table, playing our conventions*, vanilla self-play is the wrong
objective. Mitigations, in increasing ambition: reward-shape around the stated
conventions; OBL-style training (more grounded, human-compatible play);
behaviour-clone from human games. Our `saved-games/*.jsonl` files are exactly the
right format for the latter, but dozens of games ≠ the tens of thousands
imitation learning wants — they serve as fine-tuning/eval data, not the main
course.

**Paths, ascending effort:**

| Path | Effort | Compute cost | Gets you |
| --- | --- | --- | --- |
| Bridge a published pretrained agent (SAD/OBL checkpoints) | Weekend: Python WS client mapping our view → HLE observation encoding | ~$0 (CPU inference) | ~24/25 self-play strength; 2-player `simple` only; alien conventions |
| Train our own on HLE | Days of engineering (PPO/R2D2 plumbing) | ~$20–100 (consumer GPU or ~$1/hr cloud GPU, days) | Rainbow-to-SAD level with our own objective |
| Port `rules.js` to Python, train on our variants | Above + ~a day porting (rules are small and pure) | Similar | Rainbow/black/reverse variants (HLE lacks them) + convention-aware rewards |

**Deployment**: export the policy net to ONNX (a few MB) and run inference inside
`bot.mjs` via `onnxruntime-node`. The playing bot stays self-contained — no
Python, no GPU, no service at game time.

---

## Repo shape and the brain seam

Keep training separate. It is a different animal (Python, PyTorch, experiment
tracking, gigabytes of checkpoints, run-based lifecycle); the contract between
the repos is the WS protocol and view schema already documented in CLAUDE.md.
This repo keeps the bots' runtime: `botBrain.js`, `bots.js`, `bot.mjs`,
eventually an ONNX loader plus the committed few-MB model, and the LLM brain. The
training repo keeps everything that produces models, plus a small Python WS
client for live evaluation games against the real server.

The brain seam becomes a CLI switch:

```
node bot.mjs --brain rules            # today's convention automaton
node bot.mjs --brain llm              # Anthropic API hybrid
node bot.mjs --brain onnx:model.onnx  # trained policy
```

---

## Decisions on record

- **2026-08-22 — driver memory is a cache; an undo invalidates it.** The
  colour-target rescue (`rememberColorTargets`) classifies a vanished play
  marker two ways — sibling played, sibling discarded — and an undone hint is a
  third. The remembered target outlived the hint, and a colour target outranks
  every hint `decide` can give, so the bot played a card nobody had pointed at.
  Fixed in the driver (`bots.js` `forgetRolledBack`), not the brain: the brain
  is pure and correct given its inputs, and the stale input was the memory the
  driver owns. The general rule: any memory the driver carries across turns
  must be reconciled against state after a rollback, because every convention
  that remembers something has the same shape of bug waiting in it.

- **2026-08-22 — a save is a hint that TOUCHES the card, not one that targets it
  (2.29).** `findSaveHint` had four tiers and every one of them pointed the hint
  *at* the endangered card. But the keep-hint achieves nothing except taking the
  card off the chop, and any touch does that — so a play hint that brushes the
  chop on its way to a different playable card is a strictly better keep-hint.
  Found by a real game where a critical yellow 4 on the chop sat one slot ahead
  of a playable yellow 1 in the same hand; the bot spent its token on "4". The
  new `combo` tier is worth +0.04 a row and 34 perfect games per 3000. Generalise
  the lesson before looking for more: ask what a tier actually *accomplishes*,
  then find every move that accomplishes it, rather than enumerating moves of the
  expected shape.

- **2026-08-14 — no finesses.** Layer 3 of deferred plays is declined for now.
  It needs a blind play on faith, and one mismatch between two people's reading
  burns a fuse *and* usually a critical card. The wrong bet for a group still
  discovering it has different conventions to the bot. Revisit only if the table
  explicitly asks for it.
- **2026-08-13 — no human-seat special-casing of the colour pin.** Proposed:
  since views carry `isBot`, use the colour pin only when the pinned card is
  provably *dead* for a human receiver, else fall back to the unambiguous number
  keep-hint. Declined — the preference is to fix the underlying gap (deferred
  plays) rather than have the bot play two conventions. Recorded because the
  failure is real and cost a rainbow 4: if deferred plays don't get built, this
  is the cheap mitigation.
- **2026-08-14 — deferral shape (2.26).** "Will not discard" comes in two grades
  and they are not interchangeable: a locked hand is a *fact* and cancels the
  save outright; an owed hint is a *forecast* and may only let our own play go
  first. Treating them alike cost −0.69 a row and threw 0.8 extra last copies a
  game. Never defer over a last copy.
- **2026-08-13 — one convention, one reading.** Sender and receiver must read a
  convention through the same function (`onesPlayOrder`, `hasPendingPlay`,
  `colorPlayTargets`). Drift between two readings of the same rule is the bug
  class behind 2.25, 2.26, and several before them.
- **Standing, from the original build**: the bot never sees hidden information —
  every brain must consume the same filtered view a human client gets, and any
  design that needs more than that is out of scope.

---

## Keeping this document current

Update this file as part of any significant bot change — the same commit, not a
follow-up. `bot-performance.md` records *what a version did*; this file records
*what is left*, and it goes stale silently. In particular:

- move an item to [Decisions on record](#decisions-on-record) when it is built or
  declined, with the date and the reason;
- refresh [Where we are](#where-we-are) when `BOT_VERSION` moves — the benchmark
  table and any "known limit" that has stopped being true;
- add an entry when a game turns up a gap, while the example is still fresh. The
  deferred-plays section is worth more for the rainbow 4 than for the theory.
