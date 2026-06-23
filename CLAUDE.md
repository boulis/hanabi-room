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
  - `view.js` — filters state into a per-viewer view (hides own card identities; gates annotations on the share flag)
  - `replay.js` — writes a JSON log file under `replays/` when a game finishes
  - `room.js` — lobby + game-room model: who's host, who's joined, action dispatch
  - `index.js` — HTTP static server + WebSocket transport; thin shell over `room.js`
  Keep game logic in `game.js` / `rules.js` and view filtering in `view.js`. The transport doesn't know game rules.
- **Per-card hint state**: every card carries `possibleColors`, `possibleNumbers`, `colorClued`, `numberClued`, and `annotations`. Formal hints update these; annotations are owner-only metadata. Cards in your own hand are sent to you WITHOUT their `color`/`number` fields, but WITH the inferred constraints — that's how you see "this could be red or rainbow" without seeing what it actually is.
- **Replays**: finished games are written to `replays/` as JSON. Directory is gitignored; created at runtime.

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

## End-of-deck rules

Configurable per game:
- `standard` — when the last card is drawn, each player gets exactly one more turn (set `finalTurn = turn + N + 1` at the moment of emptying).
- `lax` — keep playing until all hands are empty; empty-handed players are skipped.

Both modes also end on the third fuse (immediate loss) or perfect score.

## WebSocket protocol

Server → client: `hello` (variant list), `identity` (your assigned `playerId`), `sync` (filtered view), `error`.
Client → server: `join`, `configure` (host), `start` (host), `reset` (host), `action` (`{type: 'play'|'discard'|'hint'|'annotate', ...}`).

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
