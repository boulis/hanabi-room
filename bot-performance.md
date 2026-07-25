# Bot performance history

One entry per bot version (`BOT_VERSION` in `server/botBrain.js`): what the
version does, and the full output of `npm run benchmark` at that version
(50 seeds × all variants × 2/3/4 players, lax end rule, deterministic — the
same code always reproduces the same numbers). Newest version last.

Each table row is one variant × player-count combination; the columns are:

| column | meaning |
| ------ | ------- |
| `variant` | variant id and its **maximum possible score** (`suits × 5`), e.g. `simple/25` |
| `players` | number of players (2/3/4) |
| `avg` | **average** score over the seeds in that run |
| `min` | lowest score across those seeds |
| `max` | highest score across those seeds |
| `perfect` | **count** of games that ended with a perfect score |
| `fused` | **count** of games lost to the third fuse |
| `misplays/game` | **average** misplays per game (`3 − remaining fuse tokens`) |

Note the mixed units: `perfect` and `fused` are counts out of the seed total,
while `misplays/game` is a per-game average — they sit side by side but don't
share a scale. The header line printed atop each table is the literal
`npm run benchmark` output.

## 1.0 — newest-touched conventions (original)

The initial rule-based brain. Conventions: a colour hint marks the newest
touched card of the *latest* colour hint for play; a number hint means keep
unless a card is provably playable from its hint constraints alone; discard
priority is provably-useless → chop (oldest untouched) → forced; saves the
next player's critical chop with a number hint; stalls with a harmless number
hint at full tokens.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 20.06    13   25        4      3           0.32
simple/25                             3 22.36    14   25       12      0           0.22
simple/25                             4 22.42    12   25        8      1           0.38
rainbow/30                            2 22.86    15   30        1      4           0.52
rainbow/30                            3 24.72     5   30        2      0           0.28
rainbow/30                            4 25.54     4   30        6      1           0.66
rainbowCritical/30                    2 20.64    14   28        0      2           0.36
rainbowCritical/30                    3 24.58    15   30        2      0           0.22
rainbowCritical/30                    4 24.26     9   28        0      0           0.60
rainbowCriticalBlack/35               2 21.46    14   29        0      1           0.50
rainbowCriticalBlack/35               3 24.74    17   32        0      0           0.16
rainbowCriticalBlack/35               4 24.50     4   31        0      2           0.70
rainbowCriticalBlackReverse/35        2 20.56    10   26        0      6           0.64
rainbowCriticalBlackReverse/35        3 24.22    10   30        0      0           0.30
rainbowCriticalBlackReverse/35        4 23.98     5   30        0      1           0.68
```

## 1.1 — copy-counting, pending-hint memory, reveal hints

Three changes. (1) *Every* colour hint still marked on the hand stays a
pending play target (oldest hint first), instead of only the latest. (2)
Own-card deduction narrows hint constraints by counting visible copies: an
identity fully accounted for by the piles, the discard, and hands the deducer
can see is ruled out. (3) A colour hint that fully identifies another touched
card is a *reveal* — the identified card is played via known-playable and the
newest touched card carries no play promise. The hint-giving side mirrors all
three readings.

Clear gains at 3–4 players and misplays drop sharply (no fuse-outs on most
rows), but 2-player scores *regress* vs 1.0 — the extra caution costs tempo
when only one teammate can act on hints.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 18.88    11   25        3      0           0.00
simple/25                             3 23.56    19   25       23      0           0.18
simple/25                             4 23.06    15   25       17      0           0.24
rainbow/30                            2 21.12    13   28        0      0           0.10
rainbow/30                            3 26.36    12   30        3      0           0.22
rainbow/30                            4 26.80    10   30       10      0           0.40
rainbowCritical/30                    2 19.20     9   28        0      0           0.04
rainbowCritical/30                    3 25.84    21   30        5      0           0.18
rainbowCritical/30                    4 25.24    15   30        2      1           0.40
rainbowCriticalBlack/35               2 20.64    10   30        0      0           0.24
rainbowCriticalBlack/35               3 27.24    15   35        1      0           0.14
rainbowCriticalBlack/35               4 27.28    18   33        0      1           0.50
rainbowCriticalBlackReverse/35        2 19.40    10   29        0      0           0.10
rainbowCriticalBlackReverse/35        3 26.22    16   32        0      0           0.12
rainbowCriticalBlackReverse/35        4 27.98    12   34        0      0           0.38
```

## 1.2 — cross-card elimination in the own hand

A card whose candidates narrow to a single identity claims one copy of it;
when the claimed copies plus the visible ones account for every copy in the
deck, that identity is ruled out for the other cards in the hand. Iterated to
a fixpoint, so one pin can cascade into another. Applies to the giver-side
receiver simulation too.

Small but broad gains over 1.1 on almost every row.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 19.16    13   25        3      0           0.00
simple/25                             3 23.58    18   25       25      0           0.18
simple/25                             4 23.20    19   25       15      0           0.24
rainbow/30                            2 21.54    13   30        1      0           0.10
rainbow/30                            3 26.58    12   30        4      0           0.22
rainbow/30                            4 26.96    10   30        9      1           0.46
rainbowCritical/30                    2 19.66     9   29        0      0           0.02
rainbowCritical/30                    3 26.14    21   30        5      0           0.18
rainbowCritical/30                    4 25.34    16   30        3      0           0.38
rainbowCriticalBlack/35               2 20.80    10   30        0      0           0.24
rainbowCriticalBlack/35               3 27.40    17   35        2      0           0.14
rainbowCriticalBlack/35               4 27.62    18   33        0      0           0.46
rainbowCriticalBlackReverse/35        2 19.26     9   31        0      0           0.14
rainbowCriticalBlackReverse/35        3 26.32    16   32        0      0           0.14
rainbowCriticalBlackReverse/35        4 28.06    12   34        0      0           0.36
```

## 1.3 — play-all-1s convention

A "1" hint asks the receiver to play *every* touched card, oldest first, as
long as each can still be a playable 1 (tracked by constraints, so the
obligation survives the marker consumption that playing the first 1 causes).
Reveal exception as with colour hints: if any obligated 1 is pinned to a
single identity, the 1s read as information (e.g. "that's the dead
duplicate"), not a play order. The giver only gives a "1" hint when every 1
the receiver would play really is playable, all different colours, and no
other visible hand already has the same colour's 1 obligated.

Big 2-player gains (rainbow +1.6, rainbowCriticalBlack +2.2 vs 1.2) and a
jump at rainbowCriticalBlack 3p (+2.1). The reverse-black variant regresses
slightly with more misplays — 1s are end-of-pile cards there, so the
convention gambles more.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 19.62     7   25        4      1           0.16
simple/25                             3 23.12    13   25       20      0           0.26
simple/25                             4 23.38    18   25       17      0           0.36
rainbow/30                            2 23.14    16   30        1      0           0.12
rainbow/30                            3 26.66    12   30       10      0           0.34
rainbow/30                            4 26.98     8   30        6      0           0.44
rainbowCritical/30                    2 21.34    11   30        1      0           0.08
rainbowCritical/30                    3 26.24    10   30        5      0           0.24
rainbowCritical/30                    4 25.28    11   30        3      0           0.38
rainbowCriticalBlack/35               2 22.96     7   31        0      0           0.24
rainbowCriticalBlack/35               3 29.46    23   34        0      0           0.24
rainbowCriticalBlack/35               4 28.08     8   34        0      1           0.52
rainbowCriticalBlackReverse/35        2 20.50     5   31        0      6           0.94
rainbowCriticalBlackReverse/35        3 26.28    10   34        0      1           0.78
rainbowCriticalBlackReverse/35        4 26.58     9   33        0      1           0.92
```

## 1.4 — scored hint selection

Hint-giving now enumerates *every* valid play hint for a receiver and scores
the options instead of taking the first that works. The score counts the
plays the hint causes, how soon each touched card can matter (playable now >
next in line > distant — newly cluing a distant card scores negative), raw
information (candidate identities eliminated), and penalises touching
useless or already-clued-elsewhere duplicates. Colour hints still outrank
number hints as a class — experiments showed that ordering is load-bearing —
so the score picks the best option within the class.

Modest net gain, verified at 150 seeds/row against 1.3 to get above the
noise: +0.12 avg per row, positive on 11 of 15 rows (best: reverse-black 3p
+0.49, rainbowCritical 4p +0.38).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 19.90     7   25        5      0           0.14
simple/25                             3 22.68    13   25       10      0           0.20
simple/25                             4 23.54    18   25       18      0           0.38
rainbow/30                            2 22.14     9   28        0      0           0.12
rainbow/30                            3 25.98    12   30        9      0           0.38
rainbow/30                            4 27.36    22   30        8      0           0.38
rainbowCritical/30                    2 21.22     9   29        0      0           0.10
rainbowCritical/30                    3 26.18     7   30        3      0           0.28
rainbowCritical/30                    4 25.58    11   30        2      0           0.40
rainbowCriticalBlack/35               2 22.88     7   32        0      0           0.36
rainbowCriticalBlack/35               3 29.00    14   35        3      1           0.30
rainbowCriticalBlack/35               4 27.80    10   34        0      2           0.54
rainbowCriticalBlackReverse/35        2 20.30     5   30        0      5           0.92
rainbowCriticalBlackReverse/35        3 26.82    10   34        0      2           0.76
rainbowCriticalBlackReverse/35        4 26.42    12   34        0      1           0.96
```

## 1.5 — better saves

Four changes to the save logic. (1) *Save-by-play*: a critical chop that is
playable right now is saved with a play hint on it — the card scores and
leaves the hand instead of sitting parked behind a keep-clue. (2) *Pin-save*:
when a colour hint would pin the chop as provably unplayable, prefer it over
the bare number save (same protection, far more information). (3) *2-saves*:
a still-needed 2 whose twin is nowhere visible is save-worthy too, but only
with ≥2 hint tokens (a 2 isn't a guaranteed loss, so don't spend the last
token on it). (4) *Look beyond the next player*: when everyone between us
and an endangered player has a pending play (they'll play, not save), their
chop is ours to save. Also refuses a "1" save that play-all-1s would misread
as a play order.

Biggest single-version gain so far, verified at 150 seeds/row: +0.57 avg per
row over 1.4, with 2-player up +1.2 to +1.7 on every variant and the
reverse-black variant up ~+1 at every seat count. Misplays drop sharply
(reverse-black 2p from ~1.0 to ~0.3 per game).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 21.40    16   25        6      0           0.06
simple/25                             3 22.76    14   25       13      0           0.26
simple/25                             4 23.18    20   25       12      0           0.36
rainbow/30                            2 23.28    17   28        0      1           0.10
rainbow/30                            3 27.20    22   30       10      0           0.22
rainbow/30                            4 26.94    16   30        7      0           0.40
rainbowCritical/30                    2 22.40    15   30        2      1           0.14
rainbowCritical/30                    3 25.20    16   30        2      0           0.38
rainbowCritical/30                    4 25.16    11   29        0      0           0.52
rainbowCriticalBlack/35               2 23.64    14   31        0      1           0.34
rainbowCriticalBlack/35               3 28.90    13   33        0      0           0.36
rainbowCriticalBlack/35               4 29.00    10   34        0      0           0.30
rainbowCriticalBlackReverse/35        2 22.84     3   30        0      1           0.34
rainbowCriticalBlackReverse/35        3 28.36     9   34        0      1           0.40
rainbowCriticalBlackReverse/35        4 28.30    10   33        0      0           0.40
```

## 1.6 — endgame search

Once the deck is empty, the unseen multiset is exactly the bot's own hand —
so over the last few cards (≤6 across all hands) the bot enumerates every
consistent assignment ("world", capped at 16), simulates each legal action to
the end of the game with the real rules engine (teammates modelled as this
same bot), and takes the action with the best worst-case outcome, average as
tie-break. Evaluation is final score minus a point per fuse burned — plain
average-maximizing turned the bot into a gambler (misplays tripled, fuse-outs
everywhere) because a lost fuse is free in raw score until the third one.
Everything is computed from the view plus the public rules; hidden state is
never consulted.

A visible quirk: the search sometimes *deliberately* misplays a known-dead
card when tokens are full — in lax mode that's a discard substitute that
buys tempo — so the misplays/game stat rises while scores improve. Verified
at 150 seeds/row against 1.5: +0.10 avg per row, positive or neutral on 12
of 15 rows, strongest exactly where endgames are tightest (the two black
variants, +0.12 to +0.34). Benchmark runtime roughly doubles (still ~13s).

Note: this table's misplay/fused columns read worse than 1.5's; the score
columns are the ones that matter (see above for why).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 21.44    16   25        6      1           0.48
simple/25                             3 22.76    14   25       13      0           0.42
simple/25                             4 23.18    20   25       12      0           0.52
rainbow/30                            2 23.48    17   28        0      0           0.60
rainbow/30                            3 27.28    22   30       10      1           0.72
rainbow/30                            4 26.90    16   30        7      1           0.52
rainbowCritical/30                    2 22.48    15   30        1      1           0.52
rainbowCritical/30                    3 25.22    14   30        2      1           0.94
rainbowCritical/30                    4 25.16    11   29        0      0           0.76
rainbowCriticalBlack/35               2 23.72    14   31        0      4           1.12
rainbowCriticalBlack/35               3 29.14    13   34        0      0           0.90
rainbowCriticalBlack/35               4 29.12    10   34        0      2           0.96
rainbowCriticalBlackReverse/35        2 22.84     3   30        0      1           0.84
rainbowCriticalBlackReverse/35        3 28.52    10   34        0      5           1.28
rainbowCriticalBlackReverse/35        4 28.34    10   33        0      2           0.92
```

## 1.7 — corrected reveal rule, safer forced discards

Found via a real human-vs-bot game (seed 4034317110, rainbowCritical): after
the bot fully knew a rainbow card, it ignored every subsequent colour play
hint and eventually discarded the known critical rainbow 5.

Two fixes. (1) The reveal rule was wrong since 1.1: a colour hint that fully
pinned another touched card cancelled the newest-touched play order
*unconditionally* — but every colour hint unavoidably touches rainbow cards,
so one known rainbow card made all colour hints self-cancel. The correct
rule: if the pinned card is *playable*, play it first (its play consumes the
hint's markers, retiring the newest-touched target); if it isn't playable,
the hint means exactly what it always means — play the newest touched card.
No special case needed; the guard was simply deleted on both receiver and
giver sides. (2) The forced-discard fallback (every card clued, no chop)
discarded the oldest card blindly; it now skips provably-critical cards.

The biggest single-version gain: +1.30 avg per row over 1.6 at 150
seeds/row, positive on all 15 rows — up to +3.5 on reverse-black 2p and
+2.3 to +2.8 on the other rainbow-variant 2p rows.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 22.34    16   25       15      0           0.30
simple/25                             3 22.96    13   25       17      1           0.36
simple/25                             4 23.30    20   25       15      1           0.48
rainbow/30                            2 26.08    21   30        7      1           0.22
rainbow/30                            3 28.22    23   30       16      0           0.20
rainbow/30                            4 27.24    19   30       10      1           0.58
rainbowCritical/30                    2 24.82    15   30        4      1           0.60
rainbowCritical/30                    3 26.40    14   30        4      4           0.68
rainbowCritical/30                    4 25.82    15   30        3      0           0.80
rainbowCriticalBlack/35               2 27.02    15   34        0      1           0.88
rainbowCriticalBlack/35               3 30.24    12   34        0      0           0.54
rainbowCriticalBlack/35               4 30.10    13   35        3      2           0.98
rainbowCriticalBlackReverse/35        2 25.80     3   32        0      4           0.76
rainbowCriticalBlackReverse/35        3 30.30    12   35        1      0           0.80
rainbowCriticalBlackReverse/35        4 29.54    15   35        1      2           0.94
```

## 1.8 — save look-ahead (cost-weighted saves)

Found via a live human-vs-bot game (seed 1581845067, rainbowCritical, move
29): the human's chop was rainbow 5 with rainbow 2 right behind it — both
critical. The bot saved the 5, which slid the human's discard onto the 2: a
4-point loss (the rainbow pile capped at 1) traded for a 1-point card.

The save logic now looks one move ahead. A keep-style save parks the chop
behind a clue, so the receiver's next discard lands on their next unclued
card; if that card is save-worthy too, one hint can't protect both — the bot
computes the pile points lost by each discard (`discardCost`: everything
past a last copy becomes unreachable) and saves whichever card costs more,
accepting the cheaper exposure. A play-save (the receiver plays instead of
discarding) is still preferred outright since nothing gets discarded.

+0.45 avg per row over 1.7 at 150 seeds/row, positive on all 15 rows —
biggest on the critical-heavy variants (reverse-black 2p +1.18,
rainbowCriticalBlack 2p +1.04, rainbowCritical 2p +0.75).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 22.82    17   25       16      0           0.38
simple/25                             3 22.92    13   25       13      1           0.40
simple/25                             4 23.40    21   25       15      1           0.52
rainbow/30                            2 26.80    21   30        9      0           0.18
rainbow/30                            3 28.38    25   30       14      0           0.18
rainbow/30                            4 27.56    21   30       12      1           0.64
rainbowCritical/30                    2 25.30    18   30        5      0           0.46
rainbowCritical/30                    3 26.90    17   30        7      2           0.70
rainbowCritical/30                    4 26.32    21   30        3      1           0.92
rainbowCriticalBlack/35               2 27.74    15   35        1      2           1.00
rainbowCriticalBlack/35               3 30.46    12   35        2      1           0.74
rainbowCriticalBlack/35               4 30.70    13   35        3      3           0.96
rainbowCriticalBlackReverse/35        2 27.26     3   33        0      1           0.70
rainbowCriticalBlackReverse/35        3 30.86    12   35        1      0           0.84
rainbowCriticalBlackReverse/35        4 29.74     8   34        0      2           1.02
```

## 1.9 — stall instead of discarding protected cards

Found via the same live game as 1.8 (move 41): every card in the bot's hand
was clued, hint tokens were plentiful, no play hint existed — and the bot
discarded a card the human had deliberately protected.

When every card is clued and no chop exists, the bot picks the least
dangerous card (oldest not provably a last copy) as before — but if even
that card *could* be critical and hint tokens remain, it now spends a token
on a harmless stall hint instead of gambling with a card the team paid hints
to protect. A provably safe card is still discarded (the draw keeps the deck
moving) — an unconditional stall was tried first and cost points at 2
players by burning tokens and stalling the deck.

+0.15 avg per row over 1.8 at 150 seeds/row (rainbow 2p +0.69,
rainbowCriticalBlack 3p +0.66).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.34    11   25       21      0           0.54
simple/25                             3 22.92    15   25       14      1           0.42
simple/25                             4 23.36    19   25       16      1           0.54
rainbow/30                            2 27.30    13   30       12      1           0.38
rainbow/30                            3 28.58    26   30       15      0           0.22
rainbow/30                            4 27.58    19   30       12      1           0.68
rainbowCritical/30                    2 26.20    18   30        7      0           0.80
rainbowCritical/30                    3 26.52    13   30        7      2           0.78
rainbowCritical/30                    4 26.60    19   30        4      0           0.96
rainbowCriticalBlack/35               2 27.10     8   34        0      2           1.16
rainbowCriticalBlack/35               3 31.12    14   35        9      1           1.02
rainbowCriticalBlack/35               4 30.82    13   35        5      1           1.00
rainbowCriticalBlackReverse/35        2 27.52    13   35        1      0           0.78
rainbowCriticalBlackReverse/35        3 30.80    11   35        2      0           0.98
rainbowCriticalBlackReverse/35        4 29.62     9   35        3      1           1.10
```

## 2.0 — alarm convention (attention-drawing discards, guard reactions)

The first convention that changes what a *move itself* means — opening the
advanced-conventions era. When hints can't cover the danger (no tokens at
all, or one hint can't protect two endangered cards whose loss is
expensive), the bot makes an out-of-the-ordinary discard, safest option
first: a useful touched card; the chop despite holding an obvious play; a
card past the chop; a cheaper touched critical. The next player detects the
anomaly from the log and reacts by guarding their oldest unclued card(s)
through the turn-free annotate interface — 2 cards when the alarmer still
had hint tokens, 1 when they had none — which moves their chop. Guarded
cards are skipped by the chop everywhere, and guard flags feed back into
the sender's model when the room shares them (`shareGuarded`; the benchmark
and bot-vs-bot tests now turn it on).

Two rounds of tuning were needed: receiver-side checks suppress false
alarms (routine forced discards and elimination-based trash discards were
being misread — 49 of 79 guard events in the first cut), and the risky
alarm types (which burn an unknown own card) are price-gated to saves worth
≥2 points. Final: +0.11 avg per row over 1.9 at 150 seeds/row — gains at
3-4 players (+0.2 to +0.6), a small residual cost at 2-player rainbow
variants where guards clog 5-card hands.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.32    11   25       21      1           0.52
simple/25                             3 23.38    15   25       20      1           0.46
simple/25                             4 23.84    19   25       21      1           0.54
rainbow/30                            2 26.78    13   30       13      2           0.64
rainbow/30                            3 29.02    26   30       26      0           0.22
rainbow/30                            4 28.24    19   30       21      2           0.48
rainbowCritical/30                    2 26.16    16   30        7      1           0.80
rainbowCritical/30                    3 26.84     9   30        9      3           0.88
rainbowCritical/30                    4 26.74    14   30        5      1           0.96
rainbowCriticalBlack/35               2 26.78     8   34        0      5           1.32
rainbowCriticalBlack/35               3 31.48    14   35       15      2           1.12
rainbowCriticalBlack/35               4 30.72    13   35        4      1           1.22
rainbowCriticalBlackReverse/35        2 26.86    11   35        1      0           1.24
rainbowCriticalBlackReverse/35        3 31.12    11   35        3      2           1.04
rainbowCriticalBlackReverse/35        4 30.52     9   35        4      0           1.38
```

## 2.1 — forced-play signals (the 2-player deadlock)

The first memory-based convention: `decide` now accepts a driver-owned
memory object that persists across turns (all four drivers — in-process
bots, the CLI bot, the benchmark, and the test harness — provide one).

The deadlock it addresses: one player's hand is fully touched/guarded
(nothing conventionally discardable) and they lack the info to play, so
they stall with hints while the partner discards to feed them tokens. When
the free partner holds a play *fully determined by shared knowledge* but is
in this loop, their moves become a pointer: each discard made while able to
play advances a pointer over the locked player's possibly-playable cards
(oldest first), and their eventual play — at a moment a discard was legal —
commands the locked player to play the pointed card. While armed, the free
player's plays are ONLY made as signals, and everything both sides compute
(the pointer set, the partner's ability to play) uses shared knowledge
only (constraints + piles + discard), evaluated in the post-signal pile
state, so sender and receiver always agree.

Deliberately gated to genuine token starvation (sender engages at 0 tokens,
receiver counts at ≤1) — ungated it hijacked useful plays and cost ~0.4 per
2-player row. Gated: cost-neutral in self-play (−0.01 avg/row vs 2.0;
3-4-player rows bit-identical since it's 2-player only), firing sparingly
and almost exclusively in the difficult variants (54 signals across 750
2-player games, three quarters of them in the rainbow/black variants), which
is exactly the situation it was designed for in human-bot play.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.32    11   25       21      1           0.52
simple/25                             3 23.38    15   25       20      1           0.46
simple/25                             4 23.84    19   25       21      1           0.54
rainbow/30                            2 26.54    13   30       12      3           0.68
rainbow/30                            3 29.02    26   30       26      0           0.22
rainbow/30                            4 28.24    19   30       21      2           0.48
rainbowCritical/30                    2 26.08    16   30        7      1           0.80
rainbowCritical/30                    3 26.84     9   30        9      3           0.88
rainbowCritical/30                    4 26.74    14   30        5      1           0.96
rainbowCriticalBlack/35               2 26.82     8   34        0      5           1.32
rainbowCriticalBlack/35               3 31.48    14   35       15      2           1.12
rainbowCriticalBlack/35               4 30.72    13   35        4      1           1.22
rainbowCriticalBlackReverse/35        2 26.68    11   35        1      0           1.24
rainbowCriticalBlackReverse/35        3 31.12    11   35        3      2           1.04
rainbowCriticalBlackReverse/35        4 30.52     9   35        4      0           1.38
```

## 2.2 — colour-hint play targets survive a sibling discard

The play obligation from a colour hint was tracked only through the display
markers (`lastHints`), which the server consumes whenever *any* card of the
hint's touched set leaves the hand. So if the receiver discarded an older card
that merely shared the hint — a forced discard, or an alarm-convention signal
— before playing the newest-touched target, the marker for the target itself
was wiped too and the bot forgot it was meant to play it (a bare colour clue is
otherwise indistinguishable from a save/info clue).

The driver memory now records each live colour target's card id (before any
branch can consume markers) and keeps it across an unrelated *discard*. The
distinction matters: the same consumption also fires when a pinned-playable
sibling is *played* first, which deliberately retires the newest-touched target
(the documented reveal/pin convention, common in rainbow variants). A first
naive version revived those too and regressed every row (rainbow 2p 26.54→24.62,
misplays up across the board); keying the rescue to "my last hand-exit was a
discard, not a play" (`myLastHandExit`) fixes only the intended case.

Score-neutral in self-play (±0.02/row vs 2.1 — the rescue fires only on the
rare alarm/forced discard of a colour sibling while an unplayable colour target
is held); the value is correctness in human-bot play, where a partner expects a
colour-hinted card to eventually be played even after the bot has to shed a
touched card.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.32    11   25       21      1           0.52
simple/25                             3 23.38    15   25       20      1           0.46
simple/25                             4 23.84    19   25       21      1           0.54
rainbow/30                            2 26.54    13   30       12      3           0.68
rainbow/30                            3 29.00    25   30       26      0           0.24
rainbow/30                            4 28.26    19   30       21      2           0.48
rainbowCritical/30                    2 26.08    16   30        7      1           0.80
rainbowCritical/30                    3 26.84     9   30        9      3           0.88
rainbowCritical/30                    4 26.72    14   30        4      1           0.96
rainbowCriticalBlack/35               2 26.82     8   34        0      5           1.32
rainbowCriticalBlack/35               3 31.50    14   35       15      2           1.10
rainbowCriticalBlack/35               4 30.72    13   35        4      1           1.20
rainbowCriticalBlackReverse/35        2 26.66    11   35        1      0           1.24
rainbowCriticalBlackReverse/35        3 31.12    11   35        3      2           1.04
rainbowCriticalBlackReverse/35        4 30.54     9   35        5      0           1.42
```

## 2.3 — a forced stall protects a partner's critical chop

When the bot has no play and nothing safe to discard, it stalls with a harmless
keep-hint. Previously that token did nothing. Now, if a partner's chop is
save-worthy (a critical or lone 2), the stall spends the same token protecting
it instead (`protectiveStall`).

This closes a real hole seen in play: the section-0 save is skipped when the
partner has a *pending play* (the bot assumes they'll play, not discard). But a
partner can still dump their critical chop — a human misread, or their own view
differing — and the bot, having concluded it must stall anyway, would emit a
useless hint while a last-copy critical sat one discard from death. Since the
stall token is otherwise wasted, protecting the chop is free insurance: it costs
nothing when the partner does play, and saves the pile when they don't.

Net gain in self-play, concentrated at 3-4 players and in the critical variants
where losing a last copy caps a whole pile (rainbow 2p 26.54→27.02, rainbowCritical
3p 26.84→27.34 and 4p 26.72→27.18, rainbowCriticalBlack 3p 31.50→31.84); two rows
dip within noise (rainbowCritical 2p −0.16, reverse 3p −0.10).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.34    11   25       22      2           0.54
simple/25                             3 23.78    17   25       20      1           0.46
simple/25                             4 23.88    20   25       21      1           0.52
rainbow/30                            2 27.02    17   30       14      2           0.66
rainbow/30                            3 29.10    25   30       26      0           0.26
rainbow/30                            4 28.34    22   30       22      1           0.46
rainbowCritical/30                    2 25.92    19   30        6      2           0.86
rainbowCritical/30                    3 27.34    18   30        9      3           0.84
rainbowCritical/30                    4 27.18    21   30        2      0           0.88
rainbowCriticalBlack/35               2 27.02     8   34        0      3           1.18
rainbowCriticalBlack/35               3 31.84    15   35       15      2           1.16
rainbowCriticalBlack/35               4 31.12    18   35        3      0           1.28
rainbowCriticalBlackReverse/35        2 26.80    12   35        1      0           1.20
rainbowCriticalBlackReverse/35        3 31.02    13   35        1      2           1.10
rainbowCriticalBlackReverse/35        4 31.38    17   35        5      1           1.46
```

## 2.4 — endgame moves that read well to a human partner

The endgame search proves a worst-case outcome by modelling the partner as this
same bot. Once a win is guaranteed, every candidate scores the same 30, so the
search — taking the first such move in candidate order (plays first) — would do
reckless-looking things that a bot partner shrugs off but a human does not:
"play" a provably dead card (a misfire that reaches the same score because
there was fuse slack), or give a hint touching only dead cards (inert to the
model, but a human reads it as a play cue and misfires). Meanwhile it would
never just tell the partner which card is their last playable one, because
discarding/misfiring reached 30 all the same in the model.

`endgameHelpfulness` breaks genuine (worst, avg) ties by legibility: enable the
partner's play (+1) > discard or real gamble (0) > inert dead-only hint (−1) >
play a provably dead card (−2). It only reorders equally-winning moves, so the
worst-case score is untouched — but the bot now hands the partner the hint that
lets them play their winning card, instead of misfiring or misleading them.

Scores flat vs 2.3 (as expected — ties only), but **misplays/game roughly
halve on every row** (simple 2p 0.54→0.18, rainbowCriticalBlack 2p 1.18→0.48,
reverse 4p 1.46→0.58): the gratuitous endgame misfires are gone. Fuse-outs also
edge down.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.38    11   25       24      1           0.18
simple/25                             3 23.84    20   25       20      0           0.36
simple/25                             4 23.88    20   25       21      1           0.40
rainbow/30                            2 27.04    17   30       14      1           0.24
rainbow/30                            3 29.10    25   30       26      0           0.26
rainbow/30                            4 28.34    22   30       22      1           0.42
rainbowCritical/30                    2 25.92    19   30        4      0           0.22
rainbowCritical/30                    3 27.40    18   30       12      1           0.46
rainbowCritical/30                    4 27.18    21   30        2      0           0.52
rainbowCriticalBlack/35               2 27.00     8   34        0      3           0.48
rainbowCriticalBlack/35               3 31.88    15   35       15      0           0.36
rainbowCriticalBlack/35               4 31.06    18   35        3      1           0.48
rainbowCriticalBlackReverse/35        2 26.84    12   35        1      0           0.44
rainbowCriticalBlackReverse/35        3 31.10    13   35        1      0           0.46
rainbowCriticalBlackReverse/35        4 31.42    17   35        5      1           0.58
```

## 2.5 — zero-card-hint convention ("play your chop")

When a room enables empty hints, a hint that touches none of the receiver's
cards now means "play your chop". Receiver: honour it above everything (even a
save — our own next action consumes the signal, so deferring loses the command)
unless the chop is provably unplayable. Sender: a fallback, after ordinary play
hints, for when a player's chop is playable but no clean play hint reaches it (a
colour points elsewhere, a number is ambiguous) — signalled with a colour or
number the receiver wholly lacks. Gated on `view.allowEmptyHints` and the
`zeroHintPlaysChop` flag.

Standard benchmark (empty hints off) is **bit-identical to 2.4** — bots never
emit empty hints unless this convention tells them to, so the feature is inert
in ordinary play. With `--emptyhints` (added to benchmark.mjs), convention on
vs off:

- 2-player is a clear win, concentrated in the hard variants
  (rainbowCriticalBlackReverse 2p 26.84→28.86, rainbowCriticalBlack 2p
  27.00→27.84), with fewer fuse-outs and misplays;
- 3-4 player is modestly mixed (rainbow 3p 29.10→28.70, rainbowCriticalBlack 3p
  31.88→31.56) — the receiver honouring a chop command over a downstream save
  occasionally costs a critical when more than one teammate is exposed.

Net positive overall, strongly so at 2 players (the natural home for a
play-your-chop signal). Per-bot toggleable, so a table that dislikes it at 3-4
players can leave it off.

`--emptyhints`, convention ON:
```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.52    20   25       22      0           0.12
simple/25                             3 23.88    20   25       21      0           0.30
simple/25                             4 23.92    21   25       22      0           0.44
rainbow/30                            2 27.12    17   30       15      1           0.20
rainbow/30                            3 28.70    22   30       21      0           0.30
rainbow/30                            4 28.16    21   30       19      2           0.44
rainbowCritical/30                    2 25.84    18   30        4      0           0.26
rainbowCritical/30                    3 27.44    18   30       12      1           0.46
rainbowCritical/30                    4 27.14    23   30        2      0           0.52
rainbowCriticalBlack/35               2 27.84     8   34        0      3           0.46
rainbowCriticalBlack/35               3 31.56    15   35       12      0           0.40
rainbowCriticalBlack/35               4 31.16    18   35        4      0           0.48
rainbowCriticalBlackReverse/35        2 28.86    15   34        0      0           0.48
rainbowCriticalBlackReverse/35        3 31.00    13   35        2      0           0.50
rainbowCriticalBlackReverse/35        4 31.14    17   35        3      1           0.66
```

## 2.6 — read the receiver: defer premature saves, prefer multi-play hints, stop over-valuing recoverable 2s

Three fixes, all surfaced in one live human-vs-bot game (rainbowCritical), all
the same mistake: the bot mis-read what the human would actually do with a hint.

**(1) Hand a play instead of parking the critical chop (2-player).** At turn 2
the bot gave a bare "5" keep-save to protect the human's critical red-5 chop —
but the human had cards to play. A human prioritises playing, so the save was
premature: it parked the chop behind a clue and, next turn, the human discarded
a *useful* card instead of playing. The save logic now looks ahead: when the
next player's chop is save-worthy but *not* playable now (so the save would only
park it), and that player also holds a hintable play, the bot gives the **play
hint instead** and defers the save. The hinted player plays rather than
discards, so the chop survives untouched — and because 2-player turns strictly
alternate, the bot re-saves it before the receiver could ever discard it.
Deferring buys tempo and can save a token later (a same-colour draw may let one
hint cover both). A play-save (chop playable now) still wins outright; the final
round is excluded. Restricted to **2-player**, where the alternation guarantee
and tempo pressure both hold — 3-4 player rows are unaffected by this fix.

**(2) A multi-play number hint beats a single-play colour hint.** `findPlayHint`
preferred any colour hint over any number hint as a class (1.4 found that
ordering load-bearing). But a single "1" hint that sends *two* 1s at once
(play-all-1s) is worth more tempo than a colour hint revealing one — so when the
best number hint starts strictly more cards playing than the best colour hint,
it now wins (colour still breaks ties at equal play-count). "Tell me the 1s" now
does exactly that. Score-flat in self-play (a bot reads a single colour hint
just as well; the gain is for a human who would otherwise discard an un-hinted
playable 1), the same shape as 2.4.

**(3) A recoverable lone-2 no longer triggers a self-sacrificing alarm.**
`pickSave`'s exposure-cost floored every save-worthy card to ≥1 point, so a
lone-2 whose twin is still in the deck (save-worthy but not `identityCritical`,
so `discardCost` 0) looked as costly to lose as a certain last-copy. With a
chop-2 sitting in front of two critical 5s and 7 tokens in hand, the bot judged
"save the 2 → expose a 5" and "save the 5s → expose the 2" a tie, kept the
2-save, and — a save-worthy 5 still exposed — raised an alarm (which, via the
guard convention, would have cost the *certain* 5 to protect the recoverable 2).
Dropping the floor lets the true pile cost speak: the lone-2 weighs 0, so the
bot simply hints the 5s. The alarm still fires when two genuine criticals
collide.

Combined vs 2.5 at 150 seeds/row: **2-player +0.63/row** (driven by (1), biggest
on the critical variants — rainbowCriticalBlack 27.29→28.46, reverse
27.03→28.31), **3-player +0.12/row** (mostly (3)), **4-player −0.09/row** (a
small cost from (2) in the rainbow variants); net +0.22/row. The 50-seed table
below is the raw `npm run benchmark` output — simple 2p reads low there, but
that's noise (it's flat at 150 seeds).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 22.60    13   25       21      1           0.48
simple/25                             3 24.08    17   25       28      1           0.40
simple/25                             4 23.96    20   25       27      0           0.52
rainbow/30                            2 27.84    19   30       16      0           0.26
rainbow/30                            3 28.72    16   30       28      0           0.26
rainbow/30                            4 28.22    22   30       14      1           0.68
rainbowCritical/30                    2 26.74    13   30       12      0           0.34
rainbowCritical/30                    3 27.74    18   30       16      1           0.50
rainbowCritical/30                    4 27.22    19   30        9      0           0.64
rainbowCriticalBlack/35               2 28.78    14   35        2      0           0.56
rainbowCriticalBlack/35               3 32.48    19   35       14      0           0.46
rainbowCriticalBlack/35               4 30.94    17   35        4      1           0.66
rainbowCriticalBlackReverse/35        2 28.30    18   34        0      1           0.66
rainbowCriticalBlackReverse/35        3 31.58    19   35        6      0           0.70
rainbowCriticalBlackReverse/35        4 30.90    16   35        9      0           0.70
```

## 2.7 — save two criticals at once (the sweep + a late-game alarm gate), and stop re-alarming already-guarded cards

Found in live human-vs-bot games (rainbowCritical). First, at turn 65 the human
held two rainbow criticals — a 5 on the chop with a 4 right behind — that no
single *number* hint could both save, and the bot, unable to protect both, gave
up one of them. Then, in a later game, the bot fired the out-of-order discard
alarm over and over even though the human had already guarded the endangered
cards. Three fixes, all about spending something cheap to save a sure critical —
and not paying twice.

**(1) Sweep save** (`findSweepSave`). In a rainbow-bearing variant one colour
hint touches *every* rainbow card, so it clues both rainbow criticals at once —
and if its newest touched card (the play target the convention creates) is a
provably-dead card, the induced play is a harmless misfire (or the receiver,
seeing it's dead, just keeps everything). Either way both criticals end up clued
and off the chop. It risks **zero pile points** — the thrown card is certainly
useless — for the price of at most one fuse, so it's preferred over a discard
alarm whenever it exists and a fuse can be spared (`fuseTokens ≥ 2`). At turn 65
the bot now plays the blue hint (blue pile already complete, so the touched
blue 3 is the dead misfire) and keeps both rainbow 4 and 5.

**(2) Expected-value alarm gate.** The "burn an unknown own card" alarm types
(discard past the chop / discard the chop while holding a play) were gated to a
static ≥2 endangered points. That's right *mid-game* — the alarm also forces the
partner to guard two cards, clogging their hand for the rest of the game, a
downstream cost the static 2 implicitly prices in. But near the end that clog
barely matters and lost criticals are permanent, so the gate now relaxes in the
late game (deck ≤ 10) to a direct EV test: sacrifice when the certain save beats
the specific card's `expectedDiscardCost` (an unclued card near the end is mostly
spent copies, ~0.5 average). The sweep is preferred when available; this covers
the cases it can't reach.

A pure EV gate (no late-game scoping) was tried first and regressed ~0.09/row —
worst on the critical/reverse variants — by over-firing mid-game where the
guard-clog cost is real; scoping it to the endgame removes that.

**(3) Read (and infer) the receiver's guards.** The bot re-alarmed already-safe
cards because `pickSave`'s "where does the next discard land" step ignored guard
marks: after the human guarded their old criticals (moving their chop forward),
the bot still counted a guarded critical as the exposed second card, saw a
phantom double-save it couldn't cover, and alarmed again. That step now skips
guarded cards, so with `shareGuarded` on the bot just gives the plain keep-hint
for the one truly-endangered card. When guards are *not* shared the bot can't see
them at all, so it now remembers what its own alarms prompt — the receiver guards
their oldest 1–2 unclued cards (per the alarm convention) — in driver memory
(`inferredGuards`) and re-applies them each turn (`recordInferredGuards` /
`applyInferredGuards`), so it stops re-alarming the same cards. This is inert in
the benchmark (which shares guards); its value is correctness in real play.

Net **≈ flat vs 2.6** (−0.01/row at 150 seeds/row): all three fire only in narrow
spots (and (3)'s shared-guard fix mostly *removes* wasted alarm-sacrifices, a
small gain on the critical variants), so self-play barely moves — the value is
the human-facing saves and the stopped double-alarms. 50-seed `npm run benchmark`:

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 22.78    13   25       23      1           0.50
simple/25                             3 24.08    17   25       28      1           0.42
simple/25                             4 23.76    19   25       26      1           0.58
rainbow/30                            2 27.50    18   30       17      1           0.34
rainbow/30                            3 28.90    19   30       29      0           0.28
rainbow/30                            4 28.20    22   30       14      1           0.70
rainbowCritical/30                    2 26.80    13   30       14      0           0.40
rainbowCritical/30                    3 27.66    18   30       15      1           0.54
rainbowCritical/30                    4 27.36    19   30        9      0           0.70
rainbowCriticalBlack/35               2 28.72    14   35        3      1           0.50
rainbowCriticalBlack/35               3 32.52    19   35       15      0           0.44
rainbowCriticalBlack/35               4 31.10    17   35        7      1           0.66
rainbowCriticalBlackReverse/35        2 28.18    18   34        0      1           0.66
rainbowCriticalBlackReverse/35        3 31.40    19   35        5      0           0.68
rainbowCriticalBlackReverse/35        4 30.84    16   35        9      0           0.76
```

## 2.8 — trust the colour hint (sliding target, no last-fuse tightening)

Found by forensics on the worst 2-player `simple` games (seed 25 scored 13/25;
its save is in the library). Two halves of one bug, both about a colour hint's
play target.

**(1) The receiver stopped trusting the sender on the last fuse.** Step 2 read
`lastFuse ? knownPlayable : possiblyPlayable`, so at `fuseTokens === 1` the bot
refused any colour-hinted card it couldn't *prove* playable. Meanwhile the
sender's `hasPendingPlay` still counted that same card as a pending play
(`possiblyPlayable`, no fuse gate). The asymmetry created **zombie pending
plays**: the receiver would never play the card, and the sender — believing the
receiver was already busy — withheld every further play hint. Both sides then
stalled with harmless hints until the deck ran out. In seed 25 a hinted,
genuinely playable red 2 sat unplayed while a playable green 1 next door went
un-hinted for the rest of the game.

The fix is trust, not proof: the sender chose the target and can see the card,
so the receiver plays it. The last-fuse tightening is gone from the colour-hint
path, and `hasPendingPlay` now uses the receiver's exact reading, so sender and
receiver can no longer disagree about what will be played. (The play-all-1s
path keeps its last-fuse caution — a "1" hint obligates several cards whose
colours the receiver can't see, which is a genuinely weaker signal; blind dead-1
gambles are a separate defect.)

**(2) The target now slides past provably-dead touches.** It was strictly the
newest touched card; a touched card the receiver can already prove unplayable
was never what the hint asked for, so the promise now passes to the next-newest
candidate. With empty piles and a hand of `[green 5, green 1, red 2, green 2,
black 5]` whose two 2s are already number-clued, a "green" hint touches slots 0,
1 and 3 — slot 3 is a known green 2, so the target is slot 1 (the green 1).
`colorPlayTargets` takes a `possible(slot)` predicate; the giver's
`playHintCandidates` mirrors it exactly, so it only offers a colour hint when
the card the receiver will actually pick is the one that's playable.

**+0.40 avg per row over 2.7**, positive on 14 of 15 rows (only
rainbowCriticalBlack 4p dips, −0.22). Biggest at 2 players, where the deadlock
was worst: simple 22.78→23.60, rainbowCriticalBlack 28.72→29.42, reverse
28.18→28.84, rainbowCritical 26.80→27.30. `simple` 2p also loses its floor
entirely — min 13→17, fused 1→0, perfect 23→25 — and **seed 25 itself goes
13/25 → 25/25, a perfect game**.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.60    17   25       25      0           0.46
simple/25                             3 24.26    22   25       28      0           0.40
simple/25                             4 23.88    20   25       27      0           0.56
rainbow/30                            2 27.84    21   30       16      0           0.34
rainbow/30                            3 28.98     8   30       32      1           0.30
rainbow/30                            4 28.78    27   30       15      0           0.60
rainbowCritical/30                    2 27.30    22   30       12      0           0.46
rainbowCritical/30                    3 28.22    21   30       20      1           0.52
rainbowCritical/30                    4 27.52    14   30        8      1           0.68
rainbowCriticalBlack/35               2 29.42    21   35        3      1           0.60
rainbowCriticalBlack/35               3 32.82    25   35       13      1           0.46
rainbowCriticalBlack/35               4 30.88    10   35        6      3           0.74
rainbowCriticalBlackReverse/35        2 28.84    20   34        0      0           0.62
rainbowCriticalBlackReverse/35        3 32.14    25   35        6      0           0.60
rainbowCriticalBlackReverse/35        4 31.30     7   35        9      2           0.78
```

## 2.9 — a forgone colour target is an alarm too

The alarm convention's type-2 signal is "discard the chop while holding an
obvious play". The receiver-side detector defined *obvious* as `knownPlayable`
— provably playable from the discarder's own constraints. But the commonest
play obligation in this brain isn't provable at all: a colour-hint target is
only ever *possibly* playable (the receiver knows the colour, not the number).
So the one case the convention most wants to catch — the partner was handed a
play target, didn't play it, and discarded their chop instead — was invisible,
and no alarm was raised.

The detector now shares `hasPendingPlay` with the giver, so "did they have a
play?" has exactly one definition across the whole brain: known-playable, a live
colour target (sliding, possibly playable), or a play-all-1s obligation.
`hasPendingPlay` also picked up `decideCore`'s last-fuse gate on the "1" branch
in the process — at `fuseTokens === 1` a "1" obligation is only acted on when
provably playable, so before then it isn't a play anyone will actually make, and
neither the giver nor the alarm detector should assume it is.

Emission is deliberately left alone: `findAlarmMove` still only *sends* this
alarm while holding a known-playable card. Reading a signal more broadly than
you send it is the safe direction — it costs a guard when a partner deviates,
and never invents a signal of our own.

**+0.08 avg per row over 2.8**, positive on 10 of 15 rows, flat on 3, and two
−0.02 dips inside noise. Best at the seat counts where a forgone target used to
go unpunished: reverse 4p 31.30→31.54, rainbowCriticalBlack 4p 30.88→31.10,
rainbowCritical 4p 27.52→27.66, simple 2p 23.60→23.74 (min 17→18).

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.74    18   25       25      0           0.46
simple/25                             3 24.32    22   25       29      0           0.40
simple/25                             4 24.00    21   25       27      0           0.56
rainbow/30                            2 27.90    21   30       16      0           0.34
rainbow/30                            3 28.98     8   30       32      1           0.30
rainbow/30                            4 28.78    27   30       15      0           0.60
rainbowCritical/30                    2 27.36    22   30       12      0           0.46
rainbowCritical/30                    3 28.26    21   30       20      1           0.52
rainbowCritical/30                    4 27.66    21   30        8      0           0.64
rainbowCriticalBlack/35               2 29.40    21   35        3      1           0.60
rainbowCriticalBlack/35               3 32.80    27   35       13      1           0.44
rainbowCriticalBlack/35               4 31.10    10   35        7      4           0.74
rainbowCriticalBlackReverse/35        2 28.84    20   34        0      0           0.62
rainbowCriticalBlackReverse/35        3 32.22    25   35        6      0           0.62
rainbowCriticalBlackReverse/35        4 31.54     7   35       10      2           0.78
```

## 2.10 — emission and detection of the forgone-play alarm, perfectly synced

Supersedes 2.9's decision to leave emission narrow. That call was justified with
"relaxing emission makes the bot deliberately forgo a possibly-playable target,
which is a gamble" — and that reasoning was simply wrong on the mechanics. This
alarm discards the **chop**, which is by definition untouched: throwing it
consumes no hint markers, so the colour target stays in hand (and 2.2's memory
rescue explicitly keeps the obligation across a discard) to be played next turn.
The alarm costs a turn of tempo and the chop card, never the target.

With that corrected, the asymmetry had no defence left: a convention where the
bot *reads* a signal it would never *send* is half a convention, and the half
that pays — actually raising the alarm when a critical needs saving — was the
missing one. `findAlarmMove`'s type-2 condition is now literally the same
`hasPendingPlay` call that `alarmGuards` uses to read it, so a colour-hint
obligation counts identically on both ends and the two cannot drift. It reads
live `lastHints` markers only, never the bot's private memory, which is exactly
what the partner is able to reconstruct.

**+0.03 avg per row over 2.9's detection-only state**, positive on 9 of 15 rows;
the notable movement is in **perfect games** (simple 2p 25→26, 3p 29→30, 4p
27→29, rainbow 4p 15→17), since the alarm now fires in the many positions where
the bot's only play was a colour obligation. rainbowCriticalBlack 2p is the one
real dip (29.40→29.24). Against 2.8, the two halves together are **+0.10 avg per
row**, positive on 13 of 15 rows.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.70    18   25       26      0           0.46
simple/25                             3 24.34    22   25       30      0           0.40
simple/25                             4 23.98    21   25       29      0           0.56
rainbow/30                            2 27.92    21   30       16      0           0.34
rainbow/30                            3 28.98     8   30       32      1           0.30
rainbow/30                            4 28.94    27   30       17      0           0.58
rainbowCritical/30                    2 27.42    22   30       12      0           0.46
rainbowCritical/30                    3 28.28    21   30       19      1           0.52
rainbowCritical/30                    4 27.70    21   30        8      0           0.66
rainbowCriticalBlack/35               2 29.24    22   35        3      1           0.66
rainbowCriticalBlack/35               3 32.82    27   35       14      1           0.42
rainbowCriticalBlack/35               4 31.20    10   35        7      4           0.74
rainbowCriticalBlackReverse/35        2 28.98    20   34        0      0           0.64
rainbowCriticalBlackReverse/35        3 32.20    25   35        6      0           0.62
rainbowCriticalBlackReverse/35        4 31.62     7   35       10      2           0.76
```

## 2.11 — the sender warns a partner whose obligated 1 has died

Fixes the misplay engine behind the worst 2-player games (seed 25's opening
double-misfire; seed 39, still the category's worst, is the same bug).

**Nothing changed on the receiver side, because nothing needed to.** Every play
path is already gated by `knownPlayable`/`possiblyPlayable`, and
`possiblyPlayable` is false exactly when a card is provably dead — so the bot
never plays a card it can prove is dead. The trouble is that it *cannot* prove
it: a "1" hint tells the receiver the card is a 1, not its colour, so while any
colour's 1 remains open the card stays possibly playable. Only a player who can
SEE the card knows it died. Warning is therefore the sender's job, not a
receiver rule.

`findDeadOneWarning` gives that warning: when the next 1 a teammate would play
(computed under the same gate `decideCore` uses) is one we can see is already on
the pile, we hint its colour. That pins it to colour + the 1 they already know,
which makes it provably unplayable — so their existing gate now fires — and, per
the reveal exception, turns the whole "1" order back into information ("that's
the dead duplicate"). Candidate hints that would leave a colour play target
behind that misfires are rejected. Its value scales with the fuses, so it is
offered at three priorities: above even a save at 1 fuse, above ordinary play
hints at 2, and only after we have found nothing better to say at 3.

**Score-flat (+0.01 avg per row over 2.10) but misplays fall** — simple 2p
0.46→0.38, rainbowCritical 4p 0.66→0.62, rainbowCriticalBlack 3p 0.42→0.40 —
and rainbowCritical 3p loses its fuse-out (1→0). The score is flat because in
`lax` a burnt fuse costs nothing directly unless it is the third; the value is
fewer wasted turns and, above all, not misfiring in front of a human partner.

**A measured negative result worth recording.** The warning never fires at 1
fuse (0 of 12 firings across 750 games), because the last-fuse gate on the "1"
path already stops the receiver gambling there. Removing that gate — so the
receiver always trusts the "1" hint and the warning becomes its safety net, the
tidier-sounding convention — was tried and is **worse: −0.05 avg per row, with
fuse-outs rising and catastrophic outliers appearing** (rainbowCritical 4p min
21→4 and fused 0→1; reverse 4p fused 2→4). A warning hint often cannot be
constructed — no colour pins the card without creating a misfiring target — so
trusting unconditionally has no backstop. The gate stays; the warning covers
2 fuses, where it is affordable and effective.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.68    18   25       26      0           0.38
simple/25                             3 24.34    22   25       30      0           0.40
simple/25                             4 23.98    21   25       29      0           0.56
rainbow/30                            2 27.92    21   30       16      0           0.34
rainbow/30                            3 28.98     8   30       32      1           0.28
rainbow/30                            4 28.88    26   30       17      0           0.58
rainbowCritical/30                    2 27.42    22   30       12      0           0.46
rainbowCritical/30                    3 28.38    21   30       19      0           0.48
rainbowCritical/30                    4 27.72    21   30        8      0           0.62
rainbowCriticalBlack/35               2 29.24    22   35        3      1           0.64
rainbowCriticalBlack/35               3 32.82    27   35       14      1           0.40
rainbowCriticalBlack/35               4 31.20    10   35        7      4           0.74
rainbowCriticalBlackReverse/35        2 29.04    20   34        0      0           0.62
rainbowCriticalBlackReverse/35        3 32.20    25   35        6      0           0.62
rainbowCriticalBlackReverse/35        4 31.62     7   35       10      2           0.76
```

## 2.12 — a "1" hint means KEEP in a reverse-suit variant

A convention hole, not a tuning change. `rainbowCriticalBlackReverse` plays black
5→1 with the reversed distribution `[5,5,5,4,4,3,3,2,2,1]` — so **black 1 is the
pile's LAST card and its only copy**, a critical card and the exact opposite of a
play cue. Play-all-1s obligated it anyway: the receiver knows only that a card is
a 1, and while any up-suit's 1 is still open the card stays `possiblyPlayable`,
so the bot gambled. Reproduced directly — with an empty black pile the bot played
its `black_1` "play all 1s", which both misfires and caps black at 4 permanently.

Number hints mean *keep* by default, so the rule is simply that the "1" exception
does not apply to a card that could still be a reversed suit's 1
(`onesPlayObligations`). Being touched by any colour hint proves it isn't one —
a `hintMatches: 'none'` suit like black is never in a colour hint's touched set —
as does copy-counting the single black 1 elsewhere. Receiver (`decideCore`),
giver model (`hasPendingPlay`), the dead-1 warning, and hint scoring
(`playHintCandidates` no longer credits a "1" hint with plays the receiver won't
make) all share the one predicate, so no two sides disagree. Variants without a
down suit are untouched, and every non-reverse row below is **bit-identical to
2.11**.

The reverse rows trade a little average for markedly better safety, which is the
right side of that trade for a card whose loss is permanent:

| row | avg | misplays/game | min | fused |
| --- | --- | --- | --- | --- |
| reverse 2p | 29.04 → 28.58 | 0.62 → **0.36** | 20 → 22 | 0 → 0 |
| reverse 3p | 32.20 → 31.72 | 0.62 → **0.32** | 25 → 22 | 0 → 0 |
| reverse 4p | 31.62 → 31.56 | 0.76 → **0.60** | 7 → **25** | 2 → **0** |

Misplays fall by ~40% on every reverse row, 4-player fuse-outs disappear, and the
catastrophic 4p tail is gone (min 7 → 25). The average dips because the bot gives
up the multi-1 tempo play there; with the "1" hint no longer starting plays,
`playHintCandidates` naturally falls back to colour hints to get 1s moving, which
prove the card isn't black.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.68    18   25       26      0           0.38
simple/25                             3 24.34    22   25       30      0           0.40
simple/25                             4 23.98    21   25       29      0           0.56
rainbow/30                            2 27.92    21   30       16      0           0.34
rainbow/30                            3 28.98     8   30       32      1           0.28
rainbow/30                            4 28.88    26   30       17      0           0.58
rainbowCritical/30                    2 27.42    22   30       12      0           0.46
rainbowCritical/30                    3 28.38    21   30       19      0           0.48
rainbowCritical/30                    4 27.72    21   30        8      0           0.62
rainbowCriticalBlack/35               2 29.24    22   35        3      1           0.64
rainbowCriticalBlack/35               3 32.82    27   35       14      1           0.40
rainbowCriticalBlack/35               4 31.20    10   35        7      4           0.74
rainbowCriticalBlackReverse/35        2 28.58    22   34        0      0           0.36
rainbowCriticalBlackReverse/35        3 31.72    22   35        4      0           0.32
rainbowCriticalBlackReverse/35        4 31.56    25   35        3      0           0.60
```

## 2.13 — don't race a partner for the same card (the yield)

The last of the play-all-1s duplication damage, and the whole of seed 39. There,
the "1" hint obligates the partner's red 1 and blue 1; the partner then hints red
(and later blue) to get the bot's copies played, and both players play the same
card — two misfires, two fuses, in the first ten turns. The hint-giver is blind
by construction: it hinted blue *while holding an obligated blue 1*, because a
"1" hint tells it the number and never the colour. Only the receiver can see the
collision, so yielding has to be the receiver's job.

`yieldSlots`: when a convention has marked one of our cards for play and pins
what it must be — among everything it could still be, exactly one identity is
playable, so a blue target on an empty blue pile can only be the blue 1 — and a
teammate is already obliged to play that exact identity, the copy is ours to shed
rather than race for. We discard it instead of the chop, and they play theirs.

Two details carry the weight. The implied identity is only read off slots some
convention actually marked; applied to any card it is nonsense (an unrelated red
card on an empty pile would "imply" red 1 merely because that is the only
playable red — a first cut did exactly this and discarded a red 2 and a blue 5).
And we yield only to a teammate who *cannot* pin the identity themselves,
otherwise both sides yield and both copies get discarded; the blindness test is
what makes it deadlock-free.

**A yield is externally indistinguishable from a touched-discard alarm** — both
shed a useful clued card — so `alarmGuards` disambiguates from the one vantage
point that can: a yield only ever happens for a card the *reader* is obliged to
play, so when the discarded identity is one our own outstanding obligation could
satisfy, it reads as stepping aside, not as a warning. Worth +0.015/row on its
own (simple 2p perfect games 27→29); without it the misread is survivable but
costly, since the guards clog the hand.

**+0.06 avg per row over 2.12**, positive on 9 rows, flat on 4. Misplays fall
almost everywhere, total fuse-outs drop 7→5, and a catastrophic outlier
disappears (rainbow 3p min 8→27, fused 1→0). In `simple` 2p the three games this
whole investigation started from are now **all perfect**: seed 25 (13 originally),
seed 39 (15, the category's worst for four versions) and seed 31 (18 and fused)
all finish 25/25. The row's median reaches **25** with no fuse-outs.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.84    18   25       29      0           0.32
simple/25                             3 24.30    22   25       28      0           0.36
simple/25                             4 24.04    21   25       30      0           0.56
rainbow/30                            2 27.92    21   30       16      0           0.34
rainbow/30                            3 29.36    27   30       31      0           0.24
rainbow/30                            4 28.88    26   30       17      0           0.52
rainbowCritical/30                    2 27.48    22   30       12      0           0.44
rainbowCritical/30                    3 28.36    21   30       18      0           0.44
rainbowCritical/30                    4 27.72    21   30        8      0           0.60
rainbowCriticalBlack/35               2 29.24    22   35        3      1           0.64
rainbowCriticalBlack/35               3 32.86    27   35       14      1           0.38
rainbowCriticalBlack/35               4 31.24    10   35        8      3           0.68
rainbowCriticalBlackReverse/35        2 28.58    22   34        0      0           0.36
rainbowCriticalBlackReverse/35        3 31.70    22   35        4      0           0.30
rainbowCriticalBlackReverse/35        4 31.76    27   35        3      0           0.52
```

## 2.14 — trust a FRESH "1" order on the last fuse (and never stall with a "1")

The last-fuse gate on the "1" path demanded proof, which 2.11 recorded as
untouchable: removing it outright was −0.05/row with fuse-outs up. That
experiment was too blunt. The right condition is **staleness**, not the fuse.

When the hinter gives a "1" order they have already checked that every 1 the
receiver would play really is playable, all of them different colours — so at
that instant the oldest was safe. The only way it can have died since is if a 1
has been played in the meantime, taking its colour, which the receiver cannot
see. So on the last fuse the bot now trusts a *fresh* order — no 1 played by
anyone since the hint — for its **oldest** 1, and demands proof otherwise
(`onesOrderIsFresh` / `onesPlayGate`, shared by the receiver, the giver's model
and the dead-1 warning so no two sides disagree). Counting every 1-play,
including the receiver's own, is deliberate: only the order's 1s are guaranteed
distinct colours, and it also means the trust extends to the first 1 of an order
and no further — exactly "at least the oldest".

**And the bug this uncovered.** `findStallHint` picked the number of any clued
card, so it could stall with **"1"** — which under play-all-1s is not a stall at
all but a play ORDER. Harmless while the receiver demanded proof; lethal the
moment it trusts. rainbowCritical 4p seed 30 was exactly this: a
`stall (nothing safe to discard)` hint of `number=1`, the receiver plays, third
fuse, game over at **6/30**. Stall hints now skip the value 1 entirely while
play-all-1s is on. Seed 30 finishes **26/30**.

Measured separately, since the two are easy to conflate: the stall fix carries
most of it — **misplays fall on nearly every row** (simple 2p 0.32→0.18,
rainbowCriticalBlack 2p 0.64→0.46, 3p 0.38→0.28, reverse 3p 0.30→0.24). The
trust rule adds **+0.02/row** on top (rainbowCriticalBlack 4p 31.24→31.56 with
fuse-outs 3→2, simple 4p +0.04), and nothing else moves. Total fuse-outs 5→4.

Average is flat-to-slightly-down vs 2.13 (−0.02/row) while misplays drop ~30%
and the worst outlier is repaired; in `lax` a burnt fuse costs no score until it
is the third, so the misplay column is where this shows up. `simple` 2p keeps its
median of **25**.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.82    18   25       28      0           0.18
simple/25                             3 24.30    22   25       28      0           0.34
simple/25                             4 24.08    21   25       31      0           0.54
rainbow/30                            2 27.76    21   30       16      0           0.26
rainbow/30                            3 29.36    27   30       31      0           0.22
rainbow/30                            4 28.88    26   30       17      0           0.48
rainbowCritical/30                    2 27.24    19   30       12      0           0.38
rainbowCritical/30                    3 28.28    21   30       18      0           0.40
rainbowCritical/30                    4 27.76    21   30        8      0           0.58
rainbowCriticalBlack/35               2 29.12    22   35        2      1           0.46
rainbowCriticalBlack/35               3 32.78    26   35       14      1           0.28
rainbowCriticalBlack/35               4 31.56    10   35        8      2           0.62
rainbowCriticalBlackReverse/35        2 28.52    22   34        0      0           0.36
rainbowCriticalBlackReverse/35        3 31.68    22   35        4      0           0.24
rainbowCriticalBlackReverse/35        4 31.82    27   35        3      0           0.52
```

## 2.15 — a forced discard throws the *safest* card, not the oldest survivor

When every card in hand is clued, the bot has to throw one of them. The picker
walked the hand oldest-first and took the first card that was not *provably*
critical — an all-or-nothing screen. A card whose candidate identities are, say,
`{red 1, red 2, red 5}` with the red pile on 4 passes that screen (two of the
three candidates are already played, so they are not last copies), and the bot
would throw it while holding a card it knew to be a spare yellow 3. In an actual
game it discarded the last red 5 that way.

Replaced the screen with `discardRisk`: the pile-point cost of each candidate
identity, weighted by how many copies of it are still unseen — the conditional
expected loss from throwing this particular card. The forced branch now takes
the minimum-risk card (ties to the oldest), and the "could still be critical, so
stall instead" guard keys off that minimum rather than off the oldest survivor.
A provably safe card is thrown rather than stalled for, which is what the branch
always intended.

Up on 13 of 15 rows, flat on one, −0.02 on one; **+0.19/row** overall. Biggest
gains in the black variants (`rainbowCriticalBlack` 2p +0.50, 3p +0.42;
`rainbowCriticalBlackReverse` 3p +0.80) where criticals are dense. Total
fuse-outs 4→3, and `rainbowCritical` mins climb sharply (2p 19→22, 4p 21→24) —
the losses this fixes were exactly the games where a last copy went in the bin.

```
variant                         players   avg   min  max  perfect  fused  misplays/game
simple/25                             2 23.88    18   25       28      0           0.22
simple/25                             3 24.32    22   25       28      0           0.34
simple/25                             4 24.22    21   25       32      0           0.56
rainbow/30                            2 28.10    20   30       17      0           0.26
rainbow/30                            3 29.40    27   30       32      0           0.22
rainbow/30                            4 28.92    26   30       18      0           0.44
rainbowCritical/30                    2 27.44    22   30       11      0           0.42
rainbowCritical/30                    3 28.28    21   30       17      0           0.38
rainbowCritical/30                    4 27.94    24   30        8      0           0.58
rainbowCriticalBlack/35               2 29.62    23   35        2      0           0.34
rainbowCriticalBlack/35               3 33.20    23   35       15      1           0.34
rainbowCriticalBlack/35               4 31.54    10   35        8      2           0.64
rainbowCriticalBlackReverse/35        2 28.74    16   34        0      0           0.34
rainbowCriticalBlackReverse/35        3 32.48    25   35        3      0           0.28
rainbowCriticalBlackReverse/35        4 31.78    25   35        3      0           0.52
```
