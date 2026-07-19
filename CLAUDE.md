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
- `npm run benchmark` (or `node benchmark.mjs --seeds N --players 2,3 --variants simple --end lax`) — deterministic bot-vs-bot score statistics over fixed seeds. Run it before and after any bot-brain change and put the numbers in the commit message; results are never committed as files since the same code always reproduces them.

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
- **Saved games**: every started game opens a new `saved-games/<timestamp>-<variant>.jsonl` file. The first line is a `start` header (seed, variant, options, players, hostId, startedAt); each subsequent line is an event (`action`, `undo`, `rename`, `abandon-vote`, `end`). An `action` event may carry an optional `reasoning` string (≤200 chars): bots always record their decision reason, and the protocol accepts one from human clients too (no UI yet). Reconstruction stamps it on the action's log entry; live views strip it (it can reference hidden cards) — only the omniscient replay viewer (`viewerIndex -1`) and finished games show it. Writes use `fs.appendFile`, so a crash leaves at most one truncated trailing line which the loader tolerates. A natural game-end appends an `end` line but keeps the file open — if a player then undoes the game-ending move, the continuation is appended past the `end` and supersedes it on replay. Directory is gitignored; created at runtime.
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

Server → client: `hello` (variant list), `identity` (your assigned `playerId` plus the `roomId` and `roomName` you were placed in, and `isSpectator: true` if you joined as a spectator), `sync` (filtered view — either a `server-lobby` view or an `in-room` view), `error`, `roomCreated` (a resumed save landed in a fresh room; the client uses it to auto-enter), `deckExport`.

A view is one of:
- `kind: 'server-lobby'` — sent to connections that aren't in a room. Contains `rooms: [{ id, name, status, variantId, players, turn, allowSpectators, spectatorCount, ... }]`, `resumableSaves: [{ basename, variantId, playerNames, moves, ... }]`, and `library` — every save summarized (date, status, score/maxScore, players, tags; `seed` only when finished, since a live seed leaks the deck). Library summaries replay each file once and are cached by mtime (`listLibrary` in `savedGame.js`); the client renders them in a collapsed `<details>` "Game library" section with Replay / Copy seed / Tags / Delete per row.
- `kind: 'in-room'` — everything else you see today (lobby / playing / finished). Also carries `roomId` and `roomName` at the top level, plus `spectators: [{ id, name }]` (visible to everyone in the room) and `isSpectator: true` when the view belongs to a spectator connection. A spectator's view is built with `playerIndex` resolving to `-1` (the spectator id is never a seat), which is exactly the omniscient viewer index replay already uses — `viewCard` reveals every hand, own-hand annotations stay hidden (a spectator isn't the owner of anything), and `currentPlayer` never equals `-1` so every turn-gated control (Play/Discard/hint controls/tap-to-act/undo/abandon) renders as if it's simply nobody's turn. The client additionally hides the reaction bar for spectators.

Client → server:
- `createRoom { roomName?, playerName, playerId? }` — creates a fresh room and auto-joins the caller.
- `enterRoom { roomId, playerName, playerId? }` — joins an existing room as a player.
- `spectateRoom { roomId, playerName }` — joins as a spectator instead of a seat. Rejected with `spectators_disabled` unless the host has turned on the room's `allowSpectators` option (default off, lobby-only toggle, host-only). Allowed in either room phase — watching the pre-game lobby has no hidden information to protect. Spectator ids are never persisted client-side (no reconnect-by-id); a reload just re-sends `spectateRoom` for a fresh one. Spectators cannot take any seat-gated action — `play`/`discard`/`hint`/`undo`/`requestUndo`/`abandon`/`react`/`configure`/bot management/etc. all require a real seat and reject a spectator id the same way they'd reject an unknown one.
- `leaveRoom` — drop back to the server lobby (works for spectators too).
- `resumeSave { file, roomName? }` — spins up a new room from a saved game and returns `roomCreated`; the client then sends `enterRoom` for it.
- `replaySave { file, upto }` — stateless replay stepping: the server rebuilds the state after the first `upto` events of the save and replies `replayView { file, upto, total, view }`, where the view is omniscient (`viewerIndex: -1` reveals all hands). Refused with `save_in_use` while a live room holds the file. The client shows it on the game screen with a step bar.
- `branchSave { file, upto, roomName? }` — "play from move N": copies the save's header plus its first `upto` events into a fresh `…-branch-….jsonl` save, resumes it into a new room (players offline, reclaimed by name), and replies `roomCreated`. The original save is untouched; the branch persists independently. Rejected (`bad_branch`) if the truncated game is already finished.
- `tagSave { file, tags }` — set a save's tags (≤8, ≤24 chars each), stored in the sidecar `saved-games/tags.json` so the JSONL format stays pure replay data. Tags show in the library list.
- `deleteSave { file }` — anyone may delete an incomplete save from the server lobby (saves carry no durable owner identity, and the tailnet is trusted). It's a soft delete: the file moves to `saved-games/trash/`, recoverable by the host from the terminal. Refused with `save_in_use` while an open room is appending to that file.
- `closeRoom` — host only; removes the room and kicks everyone back to the lobby.
- `deleteRoom { roomId, playerId }` — sent from the server lobby (where the connection holds no seat, so the client passes its persistent `playerId`). Allowed when the caller is the room's creator (`creatorId`, stamped at `createRoom`; falls back to the save's host for resumed rooms) or when the room is idle (no players, or every seat offline). Anyone still connected to the room is kicked back to the server lobby.
- `configure { options }` (host only)
- `start { seed? }` (host only; works in lobby OR when a finished game is on screen)
- `action { action: { type: 'play'|'discard'|'hint'|'annotate', ... }, reasoning? }` — `reasoning` is optional free text explaining the move, recorded in the save file (see Saved games above); bots send theirs automatically.
- `undo` — roll back the most recent play/discard/hint; only the player who took it can undo it. The undone action's log entries are kept, flagged `undone: true` (clients strike them out with an [UNDO] badge); saves record undo as a distinct event and replay reproduces the struck entries.
- `requestUndo` — toggle a request that the current undo owner (top of the undo stack) undoes. Transient (never saved); cleared by any action, undo, or new game. The owner's view gets `undoRequests: [names]`; others get `canRequestUndo`/`undoRequestedByMe`.
- `abandon` — cast a vote to abandon the current game; on the second distinct vote the game is marked finished with `endReason: 'abandoned'` (same game-over screen as a natural end, so players can review or export the deck order before starting a new one). Voting twice toggles your own vote.
- `react { emoji }` — send an ephemeral reaction (allowed set: 👏 🤔 ❓ 😱 🎉). The server validates, throttles (500ms per connection, silent drop), and relays `reaction { playerIndex, emoji }` to everyone in the room — reactions are never part of game state and never appear in saves. Clients float the emoji over that player's row for 2s (`.reaction-bubble`, re-attached across re-renders). Requires a game on screen (playing or finished) and a seat — spectators don't get a reaction bar.
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

Conventions (the `standard` set in `CONVENTION_SETS`, selectable via `--conventions`): oldest card is leftmost; a colour hint marks the *newest touched* card for play (tracked via `lastHints` markers, which the server consumes when any card of that hint leaves the hand) — **every** colour hint still marked on the hand stays a pending play target (played oldest-hint-first). If a colour hint fully pins another touched card AND that card is playable, the pinned card is played first (its play consumes the hint's markers, retiring the newest-touched target); a pinned-but-unplayable card changes nothing — the newest touched card is still the one to play (do NOT cancel on any pin: colour hints unavoidably touch rainbow cards, so that reading makes all colour hints self-cancel once a rainbow card is known). Because those markers are consumed when *any* card of the hint leaves the hand, a colour target's play obligation would be lost if the receiver discards an older card that merely shared the hint (a forced or alarm-convention discard) before playing the target; to survive that, the bot records each live colour target's card id in the driver memory and rescues it across such a discard — but not across a *play* (a pinned-playable sibling played first deliberately retires the target), keyed on whether the bot's own last hand-exit was a discard or a play (`rememberColorTargets`/`mergedColorTargets`/`myLastHandExit`; without memory this degrades to marker-only, so rollouts and the CLI bot are unchanged). A number hint means *keep* unless a card becomes provably playable, except a **"1" hint**, which asks for every touched card to be played (oldest first) while it can still be a playable 1 — unless a touched 1 is pinned to a single identity (then it's information, e.g. "that's the dead duplicate"). Discard priority is provably-useless card → chop (oldest untouched) → forced (oldest card that isn't provably critical) — but when every card is clued and the forced pick could still be critical, the bot stalls with a harmless hint instead while tokens remain.

Own-card deduction combines hint constraints with *copy-counting* (an identity whose every copy is visible — played, discarded, or in a hand the deducer can see — is ruled out) plus *cross-card elimination* (a card pinned to a single identity claims a copy, iterated to a fixpoint). The same deduction, restricted to what the receiver can see, drives hint-giving: all valid play hints are enumerated and scored (plays caused, how soon touched cards matter, information, minus useless/duplicate touches; colour hints outrank number hints as a class). Saves: a critical or lone-2 chop is saved — by a play hint when the card is playable now, by a pinning colour hint when that proves it unplayable, else by the number keep-hint — for the next player, or for a later player when everyone in between has a pending play. Saves look one move ahead: a keep-hint slides the receiver's discard onto their next unclued card, and when that card is save-worthy too, the bot saves whichever loss costs more pile points (losing an early critical truncates its whole pile). At full tokens it stalls with a harmless number hint. **Protective stall** (`protectiveStall`): whenever the bot is forced to stall — no play and nothing safe to discard, but tokens remain — it spends that otherwise-wasted token protecting a partner's save-worthy chop if one exists, even when the partner has a pending play (so the primary save above was skipped on the assumption they'll play). It's free insurance against a partner who dumps their critical chop anyway (a human misread, or a differing view); it costs nothing when they do play. Falls back to the harmless keep-hint when no chop needs protecting. **Alarm convention**: when hints can't cover the danger (no tokens, or one hint can't protect two endangered cards whose loss is expensive), the bot makes an out-of-the-ordinary discard — a useful touched card, the chop despite an obvious play, a card past the chop, or a cheaper critical, in that order of safety — and the next player reacts by guarding their oldest unclued card(s) with the annotate interface (2 cards when the alarmer still had tokens, 1 when they had none), which moves their chop (`alarmGuards` receiver-side, `findAlarmMove` sender-side; drivers apply guards before deciding since annotate is turn-free). Guard flags feed back into the sender's chop model when the room shares them (`shareGuarded`; the benchmark and bot-vs-bot tests turn it on). Once the deck is empty and ≤6 cards remain in hands, an **endgame search** enumerates the consistent identities of the bot's own hand and simulates every legal action to the game's end with the real rules engine, taking the best worst-case outcome (fuse losses penalised). Because it models the partner as this same bot, once a win is guaranteed every move scores equally, so a **human-partner tie-break** (`endgameHelpfulness`) orders genuine (worst, avg) ties: a hint that hands the partner an actionable play ranks above a discard or a real gamble, above a hint touching only dead cards (inert to a bot, but a human may read it as a play cue and misfire), above "playing" a provably dead card (a guaranteed wasteful misfire, strictly worse than discarding it). This never lowers the worst-case score — it only picks the least reckless, most legible move among equally winning ones. **Forced-play signals** (2-player, token-starved deadlock, needs the driver-owned memory object passed as `decide`'s third argument): when one player is fully locked and the other holds a play fully determined by shared knowledge, the free player's discards advance a pointer over the locked player's possibly-playable cards (oldest first) and their eventual play commands the pointed card played; while armed, the free player's plays are only made as signals (`forcedPlayStep`).

`BOT_VERSION` in `botBrain.js` names the current brain; `bot-performance.md` records what each version changed and its full benchmark table. Bump the version and add an entry (run `npm run benchmark` before and after) whenever the decision logic changes.

Flags: `--server URL` (default localhost:3000), `--room ID` or `--create [--room-name X]` (default: join the newest lobby room, else create), `--name`, `--delay MS` (thinking pause, default 900), `--autostart N` (start when N players are seated, only if the bot is host), `--seed S`, `--conventions standard`.

Testing: `server/botBrain.test.js` crafts exact decks (dealing is round-robin: player 0 gets draws 0,2,4,…) to pin each convention, plus bot-vs-bot full games on every variant that must end legally — `rules.js` throws on any illegal action, so a completed game doubles as a legality proof. Typical scores: ~20–22/25 on `simple`, perfect games on good seeds.

## Card art

User-provided card images go in `client/cards/` with the naming convention `{color}-{number}.{ext}` (e.g. `red-3.png`, `rainbow-5.webp`, `black-1.svg`). The client always requests `/cards/{color}-{number}` (no extension); the server probes for `.png`, `.webp`, `.jpg`, `.jpeg`, `.avif`, `.svg`, and `.gif` in that order and serves whichever it finds, so the host can drop any supported format without touching code.

## Deployment

The host runs `npm start` on their machine and shares the URL `http://<their-tailscale-hostname>:3000` with players. Tailscale handles NAT traversal and end-to-end encryption — do not add TLS, auth, or any other access control to the server; that's the tailnet's job. Anyone on the tailnet is trusted.
