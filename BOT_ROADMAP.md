# Bot roadmap — beyond the rule-based brain

Design notes from a brainstorm (July 2026) on where the Hanabi bot could go
next. The current state and the seam everything plugs into are described
first; the rest is options, trade-offs, and costs — not commitments.

## Where we are

`bot.mjs` is a WebSocket client; `server/botBrain.js` is a pure function
`decide(view, conventions) → { action, reason }` fed the same filtered view a
human client renders. The bot cannot cheat by construction — hidden
information never reaches it. Everything below is a different implementation
of that one seam; transport, seating, reconnects, and the
retry-with-safe-fallback path stay as they are.

The rule brain plays the `standard` convention set (colour hint plays the
newest touched card, number hints save, chop = oldest untouched) and scores
~20–22/25 average on `simple`, 24+ on the rainbow variants, with perfect
games on good seeds. Known limits: it spends hints at first opportunity
(poor token economy), only recognizes danger on the *next* player's chop,
and has no finesse/prompt-style inference. A `patient` convention set
(urgency gating: only hint plays that are next-to-act or on the chop, or
when tokens are plentiful; prefer chop-playable hints, which are a play and
a save at once) is the cheapest expected improvement, likely +1–2 points.

## Option A — LLM brain (hybrid recommended)

An LLM brain is a drop-in async `decide`:

1. **Serialize the view to compact text** — piles, tokens, visible hands,
   own cards as constraint sets ("card 2: red|blue, 2|3, number-hinted
   t12"), discard, recent log. ~800–1,200 tokens per turn.
2. **Stable system prompt** carrying the rules and the conventions
   *verbatim*. Conventions become a text file rather than code — this is the
   cleanest realization of "select the conventions we play". Being stable,
   it prompt-caches; only the per-turn view is paid at full price.
3. **Structured output**: a JSON schema over `play/discard/hint` so replies
   always parse. Validate legality locally; on an illegal move, timeout, or
   refusal, fall through to the rule brain so the game never stalls.

**Honest expectation**: LLMs are mediocre at raw Hanabi deduction; with the
conventions spelled out an Opus-class model plays around the rule bot's
level, not above it. The value is flexibility and personality: charitable
interpretation of slightly-off human hints, table talk, explaining its
reasoning in chat.

**Recommended shape — hybrid**: the rule brain computes constraint facts and
a shortlist of sound moves; the LLM picks among them and does the talking.
Caps cost (smaller prompts) and caps the downside (it cannot misplay into a
fuse the rules forbid).

**Cost ballpark** (2-player game ≈ 35 bot moves; ~1K fresh input + ~2K
cached + ~300 output per move; prices as of mid-2026):

| Model | $/MTok in/out | ≈ cost per game |
|---|---|---|
| Haiku 4.5 | 1 / 5 | ~$0.05 |
| Sonnet 5 (intro pricing) | 2 / 10 | ~$0.15–0.20 |
| Opus 4.8 | 5 / 25 | ~$0.40–0.50 |

Latency of 2–10 s per move reads as a thinking player — a feature, not a
bug. Implementation lives in this repo (`server/botBrainLLM.js`,
`@anthropic-ai/sdk` dependency, `ANTHROPIC_API_KEY` env var), selected via
a `--brain` flag on `bot.mjs`.

## Option B — reinforcement learning

Hanabi is *the* canonical multi-agent RL benchmark: DeepMind's Hanabi
Learning Environment (HLE, 2019) exists precisely for this. Known 2-player
self-play results: Rainbow-DQN ≈ 20/25, FAIR's SAD ≈ 24, Off-Belief
Learning (OBL) ≈ 24+. Scale is not the obstacle — HLE simulates thousands
of steps/second, and even our own Node engine runs ~100 games/second/core,
so hundreds of thousands of games are hours of CPU, not a data problem.

**The trap: convention compatibility.** Self-play agents invent private
codes ("red hint = play slot 3") that are gibberish to humans — they score
24 with their clone and single digits with you. This is the open research
problem the benchmark was built around (ad-hoc teamplay). If the goal is a
strong partner *for our table, playing our conventions*, vanilla self-play
is the wrong objective. Mitigations, in increasing ambition: reward-shape
around the stated conventions; OBL-style training (more grounded,
human-compatible play); behaviour-clone from human games. Our
`saved-games/*.jsonl` files are exactly the right format for the latter,
but dozens of games ≠ the tens of thousands imitation learning wants —
they serve as fine-tuning/eval data, not the main course.

**Paths, ascending effort:**

| Path | Effort | Compute cost | Gets you |
|---|---|---|---|
| Bridge a published pretrained agent (SAD/OBL checkpoints) | Weekend: Python WS client mapping our view → HLE observation encoding | ~$0 (CPU inference) | ~24/25 self-play strength; 2-player `simple` only; alien conventions |
| Train our own on HLE | Days of engineering (PPO/R2D2 plumbing) | ~$20–100 (consumer GPU or ~$1/hr cloud GPU, days) | Rainbow-to-SAD level with our own objective |
| Port `rules.js` to Python, train on our variants | Above + ~a day porting (rules are small and pure) | Similar | Rainbow/black/reverse variants (HLE lacks them) + convention-aware rewards |

**Deployment**: export the policy net to ONNX (a few MB) and run inference
inside `bot.mjs` via `onnxruntime-node`. The playing bot stays
self-contained — no Python, no GPU, no service at game time.

## Repo shape

Keep training separate. It is a different animal (Python, PyTorch,
experiment tracking, gigabytes of checkpoints, run-based lifecycle); the
contract between the repos is the WS protocol and view schema already
documented in CLAUDE.md. This repo keeps the bots' runtime: `botBrain.js`,
`bot.mjs`, eventually an ONNX loader plus the committed few-MB model, and
the LLM brain. The training repo keeps everything that produces models,
plus a small Python WS client for live evaluation games against the real
server.

The brain seam becomes a CLI switch:

```
node bot.mjs --brain rules            # today's convention automaton
node bot.mjs --brain llm              # Anthropic API hybrid
node bot.mjs --brain onnx:model.onnx  # trained policy
```

## Suggested sequencing

1. **`patient` convention set** — free, likely +1–2 points, pure
   `botBrain.js` work.
2. **LLM hybrid** — best value if the goal is fun and character;
   ~$0.05–0.50/game; reuses everything built.
3. **Bridge a pretrained HLE agent** — feel the strength ceiling (and its
   alienness as a partner) before committing to training; usually reshapes
   what you want the reward function to be.
4. **Train our own** — a proper learning project; modest dollars, large
   time; convention compatibility is the genuinely hard part.
