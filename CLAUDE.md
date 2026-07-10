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
  - `room.js` — a single game room: who's host, who's joined, action dispatch
  - `rooms.js` — in-memory registry of rooms (`Map<id, room>`) keyed by 6-hex ids, with `createRoom`/`getRoom`/`listRooms`/`addRoom`/`deleteRoom`/`summarizeRoom`. Rooms are ephemeral; only saved-game files persist across server restarts.
  - `index.js` — HTTP static server + WebSocket transport; routes each connection to at most one room at a time
  Keep game logic in `game.js` / `rules.js` and view filtering in `view.js`. The transport doesn't know game rules.
- **Per-card hint state**: every card carries `possibleColors`, `possibleNumbers`, `colorClued`, `numberClued`, `lastHints` (recent hint markers touching this card, see below), and `annotations` (a `{ note, guarded }` pair). Formal hints update the constraints; annotations are owner-controlled metadata. Cards in your own hand are sent to you WITHOUT their `color`/`number` fields, but WITH the inferred constraints — that's how you see "this could be red or rainbow" without seeing what it actually is. The `note` field is always private to the owner. The `guarded` boolean is visible to the owner; other players see it only when the lobby option `shareGuarded` is on.
- **Hint markers (`lastHints`)**: each hint gets a monotonic `hintIndex` from `state.nextHintIndex`. When a hint touches cards, `{ hintIndex, hintType, value }` is appended to each touched card's `lastHints` (newest last). A new hint never clears another hint's markers — multiple recent hints stack so the visualization can convey provenance. Two rules prune markers: (1) **consumption** — when a card leaves the hand (play OR discard, success or misplay), each of its `lastHints` entries is removed from every other card in the same hand (one card from the hint's touched set "using up" the hint clears the whole hint); (2) **cap** — at most `HINT_MARK_LIMIT=4` markers per card; when a touched card would exceed 4, its oldest hintIndex is dropped from every card in the hand. The client renders newest-at-center fanning to the right with overlap.
- **Saved games**: every started game opens a new `saved-games/<timestamp>-<variant>.jsonl` file. The first line is a `start` header (seed, variant, options, players, hostId, startedAt); each subsequent line is an event (`action`, `undo`, `rename`, `abandon-vote`, `end`). Writes use `fs.appendFile`, so a crash leaves at most one truncated trailing line which the loader tolerates. A natural game-end appends an `end` line but keeps the file open — if a player then undoes the game-ending move, the continuation is appended past the `end` and supersedes it on replay. Directory is gitignored; created at runtime.
- **Deck import**: the lobby accepts a JSON file in the deck-order export format. The host's import is validated against the currently selected variant (exact multiset match + card-string format); a `bad_deck` error is returned otherwise. The pending deck shows in the lobby with a Clear button; it's re-validated at `startGame` time (in case the variant was changed) and then **cleared after the game starts** (one-shot). `createInitialState` takes an optional `deckCards` (draw order); save headers always include the post-shuffle/imported draw order under `deck`, with seed-shuffle as a fallback for older save files.
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

Server → client: `hello` (variant list), `identity` (your assigned `playerId` plus the `roomId` and `roomName` you were placed in), `sync` (filtered view — either a `server-lobby` view or an `in-room` view), `error`, `roomCreated` (a resumed save landed in a fresh room; the client uses it to auto-enter), `deckExport`.

A view is one of:
- `kind: 'server-lobby'` — sent to connections that aren't in a room. Contains `rooms: [{ id, name, status, variantId, players, turn, ... }]`, `resumableSaves: [{ basename, variantId, playerNames, moves, ... }]`, and `library` — every save summarized (date, status, score/maxScore, players, tags; `seed` only when finished, since a live seed leaks the deck). Library summaries replay each file once and are cached by mtime (`listLibrary` in `savedGame.js`); the client renders them in a collapsed `<details>` "Game library" section with Replay / Copy seed / Tags / Delete per row.
- `kind: 'in-room'` — everything else you see today (lobby / playing / finished). Also carries `roomId` and `roomName` at the top level.

Client → server:
- `createRoom { roomName?, playerName, playerId? }` — creates a fresh room and auto-joins the caller.
- `enterRoom { roomId, playerName, playerId? }` — joins an existing room.
- `leaveRoom` — drop back to the server lobby.
- `resumeSave { file, roomName? }` — spins up a new room from a saved game and returns `roomCreated`; the client then sends `enterRoom` for it.
- `replaySave { file, upto }` — stateless replay stepping: the server rebuilds the state after the first `upto` events of the save and replies `replayView { file, upto, total, view }`, where the view is omniscient (`viewerIndex: -1` reveals all hands). Refused with `save_in_use` while a live room holds the file. The client shows it on the game screen with a step bar.
- `branchSave { file, upto, roomName? }` — "play from move N": copies the save's header plus its first `upto` events into a fresh `…-branch-….jsonl` save, resumes it into a new room (players offline, reclaimed by name), and replies `roomCreated`. The original save is untouched; the branch persists independently. Rejected (`bad_branch`) if the truncated game is already finished.
- `tagSave { file, tags }` — set a save's tags (≤8, ≤24 chars each), stored in the sidecar `saved-games/tags.json` so the JSONL format stays pure replay data. Tags show in the library list.
- `deleteSave { file }` — anyone may delete an incomplete save from the server lobby (saves carry no durable owner identity, and the tailnet is trusted). It's a soft delete: the file moves to `saved-games/trash/`, recoverable by the host from the terminal. Refused with `save_in_use` while an open room is appending to that file.
- `closeRoom` — host only; removes the room and kicks everyone back to the lobby.
- `deleteRoom { roomId, playerId }` — sent from the server lobby (where the connection holds no seat, so the client passes its persistent `playerId`). Allowed when the caller is the room's creator (`creatorId`, stamped at `createRoom`; falls back to the save's host for resumed rooms) or when the room is idle (no players, or every seat offline). Anyone still connected to the room is kicked back to the server lobby.
- `configure { options }` (host only)
- `start { seed? }` (host only; works in lobby OR when a finished game is on screen)
- `action { action: { type: 'play'|'discard'|'hint'|'annotate', ... } }`
- `undo` — roll back the most recent play/discard/hint; only the player who took it can undo it. The undone action's log entries are kept, flagged `undone: true` (clients strike them out with an [UNDO] badge); saves record undo as a distinct event and replay reproduces the struck entries.
- `requestUndo` — toggle a request that the current undo owner (top of the undo stack) undoes. Transient (never saved); cleared by any action, undo, or new game. The owner's view gets `undoRequests: [names]`; others get `canRequestUndo`/`undoRequestedByMe`.
- `abandon` — cast a vote to abandon the current game; on the second distinct vote the game is marked finished with `endReason: 'abandoned'` (same game-over screen as a natural end, so players can review or export the deck order before starting a new one). Voting twice toggles your own vote.
- `react { emoji }` — send an ephemeral reaction (allowed set: 👏 🤔 ❓ 😱 🎉). The server validates, throttles (500ms per connection, silent drop), and relays `reaction { playerIndex, emoji }` to everyone in the room — reactions are never part of game state and never appear in saves. Clients float the emoji over that player's row for 2s (`.reaction-bubble`, re-attached across re-renders). Requires a game on screen (playing or finished).
- `exportDeck` — any player may request the deck order of the finished game; the server replies with `deckExport { data, filename }` for the client to save as a file. Rejected if the game isn't finished (would otherwise leak the remaining draw pile).

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

## Bot player

**Lobby bots (the normal way):** any seated player can add or remove bots from the room lobby via the `addBot` / `removeBot { playerId }` messages (the client shows a "+ Add bot" button and a Remove button per bot). These bots live inside the server process (`server/bots.js`): a bot is an ordinary seat whose turns are driven by `botBrain.decide` against `viewFor(room, botId)` after a human-feeling delay (`HANABI_BOT_DELAY_MS`, default 1200). At most `MAX_TOTAL_BOTS = 10` bots across all rooms; the lobby view carries `botSlotsFree`. Bots can only be added/removed in the lobby phase; they are tagged `isBot` in every view, don't keep a room from being idle-deletable (`isRoomIdle` ignores them), are freed when their room is deleted or closed, and are skipped when host transfers on leave. If a bot's action tops the undo stack, a `requestUndo` makes the bot undo it, then pause (`HANABI_BOT_UNDO_GRACE_MS`, default 6000) so the requester can chain their own undo. Bot seats in resumed saves come back as ordinary offline seats — re-add bots from the lobby after a resume.

**CLI bot:** `node bot.mjs` (or `npm run bot --`) runs the same brain as a normal WebSocket client, e.g. from another machine. Decision logic lives in `server/botBrain.js` as a pure function `decide(view, conventions)` — it sees only the same filtered view a human gets, so it cannot cheat by construction. Transport, reconnect, and CLI flags live in `bot.mjs`.

Conventions (the `standard` set in `CONVENTION_SETS`, selectable via `--conventions`): oldest card is leftmost; a colour hint marks the *newest touched* card for play (tracked via `lastHints` markers, which the server consumes when any card of that hint leaves the hand); a number hint means *keep* unless a card becomes provably playable; discard priority is provably-useless card → chop (oldest untouched) → forced. It also saves the next player's critical chop (last remaining copy) with a number hint, and stalls with a harmless number hint at full tokens.

Flags: `--server URL` (default localhost:3000), `--room ID` or `--create [--room-name X]` (default: join the newest lobby room, else create), `--name`, `--delay MS` (thinking pause, default 900), `--autostart N` (start when N players are seated, only if the bot is host), `--seed S`, `--conventions standard`.

Testing: `server/botBrain.test.js` crafts exact decks (dealing is round-robin: player 0 gets draws 0,2,4,…) to pin each convention, plus bot-vs-bot full games on every variant that must end legally — `rules.js` throws on any illegal action, so a completed game doubles as a legality proof. Typical scores: ~20–22/25 on `simple`, perfect games on good seeds.

## Card art

User-provided card images go in `client/cards/` with the naming convention `{color}-{number}.{ext}` (e.g. `red-3.png`, `rainbow-5.webp`, `black-1.svg`). The client always requests `/cards/{color}-{number}` (no extension); the server probes for `.png`, `.webp`, `.jpg`, `.jpeg`, `.avif`, `.svg`, and `.gif` in that order and serves whichever it finds, so the host can drop any supported format without touching code.

## Deployment

The host runs `npm start` on their machine and shares the URL `http://<their-tailscale-hostname>:3000` with players. Tailscale handles NAT traversal and end-to-end encryption — do not add TLS, auth, or any other access control to the server; that's the tailnet's job. Anyone on the tailnet is trusted.
