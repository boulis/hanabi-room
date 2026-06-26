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
- **Card art toggle** — per-client checkbox in the top meta row. When on, fully-known cards render with the SVG from `client/cards/`.

## Card art

The repo ships with a set of SVG cards in `client/cards/` (filenames like `red-3.svg`, `rainbow-5.svg`, `black-1.svg`, `back.svg`). To swap them, drop your own SVGs in there with the same filenames; the client picks them up automatically when the *Card art* toggle is on.

## Saved games

Every started game writes an append-only JSONL log to `saved-games/<timestamp>-<variant>.jsonl`. The first line is a header (seed, variant, options, players, host); each subsequent line records one event (action, undo, rename, abandon-vote, end). The directory is gitignored.

On `npm start`, if any save's last event isn't an `end` (server crash, killed mid-game, or someone undid the game-ending move and kept playing) the host is prompted in the terminal to resume one of the 3 most recent — or type a filename for any other. Press Enter to skip. The prompt is silently skipped when stdin isn't a TTY (e.g. backgrounded for the smoke test) or when `HANABI_NO_RESUME_PROMPT=1` is set. After a resume, players reconnect by reopening their browser; their existing seat is recovered by `playerId` or by name.

There's no step-through replay viewer yet; the JSONL is the source of truth for reconstruction, and re-running a finished game from scratch only needs the seed (paste it into the lobby).

## Development

```bash
npm test                                # full unit test suite (node:test)
node --test server/rules.test.js        # one file
PORT=3999 node server/index.js &        # boot for the smoke test
PORT=3999 node smoke.mjs                # end-to-end WS protocol check
```

See [CLAUDE.md](./CLAUDE.md) for the architecture overview — module layout, hint mechanics, end-of-deck rules, WebSocket protocol, etc.
