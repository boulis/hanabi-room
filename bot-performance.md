# Bot performance history

One entry per bot version (`BOT_VERSION` in `server/botBrain.js`): what the
version does, and the full output of `npm run benchmark` at that version
(50 seeds × all variants × 2/3/4 players, lax end rule, deterministic — the
same code always reproduces the same numbers). Newest version last.

## 1.0 — newest-touched conventions (original)

The initial rule-based brain. Conventions: a colour hint marks the newest
touched card of the *latest* colour hint for play; a number hint means keep
unless a card is provably playable from its hint constraints alone; discard
priority is provably-useless → chop (oldest untouched) → forced; saves the
next player's critical chop with a number hint; stalls with a harmless number
hint at full tokens.

```
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
