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
