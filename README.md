# hanabi-room

A self-hosted [Hanabi](https://en.wikipedia.org/wiki/Hanabi_(card_game)) card game for a small group of friends. One person runs the server on their laptop; the rest connect with a browser. No hosted service, no accounts, no signup — just `npm start` and share the URL.

Designed for 2–5 friends who are happy on an honour system (the host runs the game *and* plays, so they could in principle peek at server state — don't).

## Requirements

- **Node.js 20 or newer** (uses ES modules, the built-in test runner, `structuredClone`, and `crypto.randomUUID`).
- A browser (recent Chrome / Firefox / Safari).
- For remote friends: a way for them to reach the host machine on port 3000. The intended setup is **[Tailscale](https://tailscale.com/)** — install on every laptop, join one tailnet, done. LAN play also works without any extra setup.

## First-time setup

```bash
git clone <this repo>
cd hanabi-room
npm install
```

## Running

```bash
npm start
```

The server prints `hanabi-room listening on http://0.0.0.0:3000`. Override the port with `PORT=4000 npm start`.

## Playing

1. The **host** opens `http://localhost:3000`, types a name, and lands in the lobby. They become the host automatically.
2. Friends open `http://<host>:3000` in their browsers:
   - On the same Wi-Fi → use the host's LAN IP, e.g. `http://192.168.1.42:3000`.
   - Over the internet → use the host's Tailscale hostname, e.g. `http://boulis-mbp:3000`.
3. Once 2–5 players have joined, the host picks the variant and other options and clicks **Start game**.

To test on a single machine, open different browsers (Chrome + Firefox) — each has its own `localStorage` so they get separate identities. Two tabs in the *same* browser share storage and will both act as the same player.

## Game options (host sets in the lobby)

- **Variant**: Simple (5 colors), Rainbow (+ rainbow suit), Rainbow Critical (5-card rainbow), + Black, + Black Reverse (black plays 5→1 with three 5s, one 1).
- **End rule**: Standard (one final round once the deck empties) or Lax (play until all hands are empty, skipping empty-handed players).
- **Share guarded cards**: when on, every player can see each other's red "G" guard markers. When off, guard marks are private to the owner.
- **Allow hints that touch no cards**: lets you give a "red" hint when nobody has red cards, costing a token to convey negative info.
- **Seed** (optional): paste a 32-bit number to re-deal an identical deck from a previous game.

## Mid-game features

- **Undo** — only the player who took the most recent action can undo it, and only if no one has acted after them. Chains backwards across players.
- **Abandon game** — needs **two** distinct votes to take effect, so a single mis-click is harmless.
- **Annotate** — pencil icon on your own cards opens a *Guard* checkbox and a private *Note* field. The note is never shared.
- **Change name** — link in the top header; renames you for everyone immediately.
- **Card art toggle** — per-client checkbox in the top meta row. When on, fully-known cards render with the image from `client/cards/` (PNG/WebP/JPEG/SVG/AVIF/GIF — first match wins).

## Card art

Drop card images into `client/cards/` named `{color}-{number}.{ext}` (e.g. `red-3.png`, `rainbow-5.webp`, `black-1.svg`). Supported extensions: PNG, WebP, JPEG, AVIF, SVG, GIF. The server probes that order and serves whichever one exists, so you can mix formats or swap SVG → PNG just by replacing the file. When the *Card art* toggle is on, the client requests the image via `/cards/{color}-{number}` (no extension) — no code changes needed.

## Saved games

Every started game writes an append-only JSONL log to `saved-games/<timestamp>-<variant>.jsonl`. The first line is a header (seed, variant, options, players, host, startedAt); each subsequent line records one event (action, undo, rename, abandon-vote, end). The directory is gitignored.

When a game finishes (perfect, fuses, deck-out, or two-vote abandon) the game-over screen exposes an **Export deck order** button for every player. It downloads a JSON file describing the shuffled deck (variant, start time, duration, final score, ordered card list, and the matched-set description) for use with companion tools.

The lobby also has an **Import deck order** file input so the host can hand-pick the next deck — drop in a JSON file in the same export format and the cards are validated against the selected variant (size + multiset). The pending deck shows in the lobby with a Clear button; it's used by the next game and then cleared (one-shot).

On `npm start`, if any save's last event isn't an `end` (server crash, killed mid-game, or someone undid the game-ending move and kept playing) the host is prompted in the terminal to resume one of the 3 most recent — or type a filename for any other. Press Enter to skip. The prompt is silently skipped when stdin isn't a TTY (e.g. backgrounded for the smoke test) or when `HANABI_NO_RESUME_PROMPT=1` is set. After a resume, players reconnect by reopening their browser; their existing seat is recovered by `playerId` or by name.

Any save can be stepped through from the server lobby: the **Review** button on a Game library row replays it move by move, showing every hand (including the bots' recorded reasoning). **Play from move N** branches a save into a new game that carries on from that point, leaving the original untouched. Re-running a finished game from scratch only needs the seed — paste it into the lobby.

## Game library and bot par

The server lobby's **Game library** lists every save. Click a row to open its info page: the result, the game options, the per-player stats table (the same one the game-over banner shows), the seed, the tags — and **the bot par for its deck**.

Par is what a table of bots scores when dealt the very same cards. It's the context a bare score lacks: 22/25 means one thing on a deck the bots wring 25 out of and quite another on one they can only get 20 from. It's computed once per save (a game takes ~25ms to simulate), stored in `saved-games/bot-scores.json` along with the brain version that produced it, and recomputed when that version moves. New games get their par the moment they end — it shows on the game-over banner next to the final score.

The info page also lists **other games dealt from the same deck**, each a link to its own info page, so you can line up several attempts at one deck (the point of pasting a seed back into the lobby). Deck identity is the draw order, not the seed: the same seed shuffles a different deck in a different variant, and an imported deck order reproduces a deck under a fresh seed.

Seed, par and the same-deck list stay hidden while a game is unfinished — all three say something about a deck still being played.

## Development

```bash
npm test                                # full unit test suite (node:test)
node --test server/rules.test.js        # one file
PORT=3999 node server/index.js &        # boot for the smoke test
PORT=3999 node smoke.mjs                # end-to-end WS protocol check
npm run bot-scores                      # (re)compute bot par for every save
```

See [CLAUDE.md](./CLAUDE.md) for the architecture overview — module layout, hint mechanics, end-of-deck rules, WebSocket protocol, etc.

Open bot work and the decisions taken on it live in [BOT_ROADMAP.md](./BOT_ROADMAP.md); what each bot version changed, with benchmarks, is in [bot-performance.md](./bot-performance.md).
