# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted Hanabi card game for a small group of friends (2–5 players). One player runs the server on their laptop; the others connect over a Tailscale tailnet by opening `http://<host>:3000` in a browser. No hosted service, no third-party signaling, no accounts.

## Commands

- `npm install` — first-time setup
- `npm start` — run the host (serves the client and accepts WebSocket connections on port 3000, override with `PORT=…`)
- `npm test` — run the pure-logic test suite (uses Node's built-in `node:test`)
- `node --test server/game.test.js` — run a single test file
- `PORT=3999 node server/index.js & sleep 0.6 && PORT=3999 node smoke.mjs` — end-to-end smoke test against a live WS server (`smoke.mjs` is the script)

Requires Node ≥ 20 (uses ES modules and `node:test`).

## Architecture

- **Host-authoritative**: the server holds the true game state and sends each client only what that player is allowed to see (your own hand identity is hidden from you, others' is visible). This is the only sane model for a hidden-information game like Hanabi — do not introduce client-side game state that could leak information by inspection.
- **Single repo, single process**: `server/` is Node + `ws`; `client/` is static HTML/JS served by the same Node process. No build step, no bundler.
- **Layered server modules**:
  - `variants.js` — variant definitions (pure data)
  - `game.js` — deck building, initial state, pile/score helpers (pure)
  - `rules.js` — action handlers (play/discard/hint/annotate), turn rotation, end conditions (pure mutations on state)
  - `view.js` — filters state into a per-viewer view (hides own card identities; gates the guarded-card flag on the share option; the note is owner-only and never shared)
  - `savedGame.js` — append-only JSONL game log under `saved-games/`, plus reconstruction (`loadSave`) used by the resume flow
  - `room.js` — lobby + game-room model: who's host, who's joined, action dispatch
  - `index.js` — HTTP static server + WebSocket transport; thin shell over `room.js`
  Keep game logic in `game.js` / `rules.js` and view filtering in `view.js`. The transport doesn't know game rules.
- **Per-card hint state**: every card carries `possibleColors`, `possibleNumbers`, `colorClued`, `numberClued`, `lastHints` (recent hint markers touching this card, see below), and `annotations` (a `{ note, guarded }` pair). Formal hints update the constraints; annotations are owner-controlled metadata. Cards in your own hand are sent to you WITHOUT their `color`/`number` fields, but WITH the inferred constraints — that's how you see "this could be red or rainbow" without seeing what it actually is. The `note` field is always private to the owner. The `guarded` boolean is visible to the owner; other players see it only when the lobby option `shareGuarded` is on.
- **Hint markers (`lastHints`)**: each hint gets a monotonic `hintIndex` from `state.nextHintIndex`. When a hint touches cards, `{ hintIndex, hintType, value }` is appended to each touched card's `lastHints` (newest last). A new hint never clears another hint's markers — multiple recent hints stack so the visualization can convey provenance. Two rules prune markers: (1) **consumption** — when a card leaves the hand (play OR discard, success or misplay), each of its `lastHints` entries is removed from every other card in the same hand (one card from the hint's touched set "using up" the hint clears the whole hint); (2) **cap** — at most `HINT_MARK_LIMIT=4` markers per card; when a touched card would exceed 4, its oldest hintIndex is dropped from every card in the hand. The client renders newest-at-center fanning to the right with overlap.
- **Saved games**: every started game opens a new `saved-games/<timestamp>-<variant>.jsonl` file. The first line is a `start` header (seed, variant, options, players, hostId); each subsequent line is an event (`action`, `undo`, `rename`, `abandon-vote`, `end`). Writes use `fs.appendFile`, so a crash leaves at most one truncated trailing line which the loader tolerates. A natural game-end appends an `end` line but keeps the file open — if a player then undoes the game-ending move, the continuation is appended past the `end` and supersedes it on replay. Abandon is the only definitive close. Directory is gitignored; created at runtime.
- **Resume on `npm start`**: on boot the server scans `saved-games/` for files whose last event isn't `end` (incomplete or continued past a previous end), and prompts the host in the terminal to pick one of the 3 most recent (or to type a filename). The prompt is skipped silently when stdin isn't a TTY or when `HANABI_NO_RESUME_PROMPT=1`. Resumed players come back marked `online:false`; their browsers reattach to the same seat via the existing `playerId`/name reconnect path. Tests can override the directory with `HANABI_SAVED_DIR`.

## Hint mechanics

Hint touch policy per suit:
- `self` — touched only by hints matching that suit's color (standard 5 colors)
- `all`  — touched by any color hint (rainbow)
- `none` — never touched by color hints (black)

Color hint logic in `applyColorHint`:
- Compute `touchedSet` = colors that would be touched by this hint (e.g. red hint in rainbow variant → `{red, rainbow}`).
- For each card: if it's touched, **intersect** `possibleColors` with `touchedSet`; otherwise **subtract** `touchedSet`.

This gives the receiving player both positive AND negative information automatically (e.g. after a red hint, untouched cards lose "red" and "rainbow" from their possible-colors set).

Hintable colors = suits with `hintMatches === 'self'`. Rainbow and black themselves are NOT hintable directly.

Hints that touch zero cards are rejected by default. The host can enable the `allowEmptyHints` lobby option to allow them as a negative-information signal (the hint still costs a token and rules out that color/number across the receiver's hand).

## Card display rules (client)

For each card the client computes:
- `faceColor` — for other players' cards: the actual color (already known to the viewer). For own cards: the color, if the owner's `possibleColors` has narrowed to a single non-black entry, OR to just `{black}`.
- `faceNumber` — same idea: the actual number for others, or the owner's `possibleNumbers` if narrowed to a single entry.

If neither is known, the card renders face-down. Black is treated as an *implicit* possibility: it's filtered out of the visible possible-color list, so a card narrowed to `{red, black}` is displayed as "red" on the face. The player accepts the convention that any narrowed result might silently also be black.

The partial-information row (small swatches and number badges under the card) is only rendered when the owner has *some* information but not full information, separately on each axis. A card with no color info AND no number info shows nothing under the face. A card with only color info shows only color swatches, and vice versa.

## End-of-deck rules

Configurable per game:
- `standard` — when the last card is drawn, each player gets exactly one more turn (set `finalTurn = turn + N + 1` at the moment of emptying).
- `lax` — keep playing until all hands are empty; empty-handed players are skipped.

Both modes also end on the third fuse (immediate loss) or perfect score.

## WebSocket protocol

Server → client: `hello` (variant list), `identity` (your assigned `playerId`), `sync` (filtered view), `error`.
Client → server:
- `join { name, playerId? }`
- `configure { options }` (host only)
- `start { seed? }` (host only; works in lobby OR when a finished game is on screen)
- `action { action: { type: 'play'|'discard'|'hint'|'annotate', ... } }`
- `abandon` — cast a vote to abandon the current game; on the second distinct vote the room snaps back to the lobby. Voting twice toggles your own vote.

There is intentionally **no reset action**. To start over before a natural end, two players have to independently click "Abandon game" — that makes a single accidental click harmless. The host can also paste an old seed into the lobby's seed input to re-deal the same deck.

## Seeds and saved games

- Every game has a 32-bit unsigned `seed`. If the host doesn't supply one, the server generates a random seed at game start. The seed is stored on the game state and embedded in the save header under `saved-games/`.
- The seed is NOT exposed in the live view while a game is in progress — it would leak the entire deck. It only appears in the view (and is shown on the game-over banner) once `status === 'finished'`.
- To re-deal an identical starting hand, the host pastes the seed into the lobby's seed input before clicking Start. There is no step-through viewer yet; the save files are the source of truth for reconstruction.

The server broadcasts a fresh `sync` to all connections after every state change. Each client renders from `sync.view` — no client-side game state apart from the latest view.

## Game variants

Defined declaratively in `server/variants.js`. Each variant is a list of *suits*; each suit has:

- `color` — name used in card identifiers and SVG filenames
- `distribution` — array of card values to include (e.g. `[1,1,1,2,2,3,3,4,4,5]` is the standard 10-card suit)
- `direction` — `'up'` (play 1→5) or `'down'` (play 5→1)
- `hintMatches` — `'self'` (only own color hint applies), `'all'` (any color hint matches, like rainbow), `'none'` (no color hint ever matches, like black)

The five supported variants:

| id                              | suits                                                            | deck size |
| ------------------------------- | ---------------------------------------------------------------- | --------- |
| `simple`                        | 5 standard colors                                                | 50        |
| `rainbow`                       | + 10-card rainbow (matches all color hints)                      | 60        |
| `rainbowCritical`               | + 5-card rainbow (one of each number — every card is critical)   | 55        |
| `rainbowCriticalBlack`          | + 10-card black (no color hint matches)                          | 65        |
| `rainbowCriticalBlackReverse`   | + 10-card black played 5→1 with reversed distribution            | 65        |

When adding a new variant, add it to `VARIANTS` and add a row to the deck-size test in `server/game.test.js`. Test invariants (deck size, suit composition) — they catch typos in the distribution arrays.

## Card art

User-provided SVGs go in `client/cards/` with the naming convention `{color}-{number}.svg` (e.g. `red-3.svg`, `rainbow-5.svg`, `black-1.svg`) plus `back.svg` for face-down cards. The client should reference cards by this convention so art is hot-swappable.

## Deployment

The host runs `npm start` on their machine and shares the URL `http://<their-tailscale-hostname>:3000` with players. Tailscale handles NAT traversal and end-to-end encryption — do not add TLS, auth, or any other access control to the server; that's the tailnet's job. Anyone on the tailnet is trusted.
