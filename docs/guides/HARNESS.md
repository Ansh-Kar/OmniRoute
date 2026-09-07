# Harness — capability routing (agent harness, Layer 3 / build B1)

> Status: **B1 shipped** (benchmark axes + classifier + capability aliases +
> catalog API). Layers 4 (agent registry) and 5 (swarm coordinator) build on
> this surface — see `HARNESS_ROADMAP.md` at the repo (or fork) root and
> `docs/guides/SWARM.md` for the already-shipped swarm engine.

OmniRoute's chat surface is model-addressed: the caller names a model, the
gateway routes it across providers with failover. The harness inverts that
for agents: **the caller names the WORK, the gateway picks the model.**

```
POST /v1/harness/task  { messages, tools }
        │
        ▼
  TaskClassifier ──►  { type: code, complexity: deep, modalities: [] }
        │
        ▼
  CapabilityIndex ──►  axis-ranked specialists (SWE-bench for code, …)
        │
        ▼
  capability alias  ──►  "code" = ephemeral priority combo
        │                 (failover, admission, breakers, translation)
        ▼
  /v1/chat/completions (native pipeline, streaming passes through)
```

## The three pieces

### 1. Benchmark axes (`open-sse/services/modelTags/benchmarkAxes.ts`)

The composite `benchmark` score ranks models *within a category*. Axes rank
them *for a task type*, on the evidence that matters:

| Axis | What it measures | Ranked via |
|---|---|---|
| `swe_bench` | real-repo issue resolution | code tasks (primary) |
| `humaneval` | self-contained coding | code tasks (fallback axis) |
| `math500` | competition math | math tasks |
| `gpqa` | graduate-level reasoning | reasoning tasks |
| `mmlu` | broad knowledge | reasoning fallback axis |
| `lmarena_elo` | human preference ELO | chat tasks |

Discipline (inherited from the seed benchmark table):

- Scores are **curated 0..100 ballparks**, not measured results — every entry
  carries a `basis` note saying so. Override them with arena/fitness data via
  the runtime `scoreLookup` hook when you have real numbers.
- LMArena ELO (~1200–1500) is normalized `(elo − 1200) / 3`.
- **"No evidence" is never a number.** A model with no score on the queried
  axis sorts after every axis-scored model and cannot pass `minBenchmark > 0`.
  Axis scores are never silently replaced by the composite benchmark.

Query-side: `findModelsByTags(index, { category: "coder", axis: "swe_bench" })`
ranks by axis only; omit `axis` and behavior is byte-identical to pre-B1.

### 2. Task classifier (`open-sse/services/harness/classifier.ts`)

Two stages, cheapest first:

1. **Heuristics** (free, always on): body shape — image parts mean a vision
   task, full stop — then keyword scoring over the user turns. Tool-bearing
   requests lean `code`. Complexity is `deep` on >6k chars, >12 messages, or
   explicit "step-by-step / comprehensive / thorough" markers, else `fast`.
2. **Model fallback** (opt-in): when stage 1 is low-confidence AND a dispatch
   is provided, one cheap classifier call re-reads the request and returns
   strict JSON. Any failure — HTTP, non-JSON, bad enum — degrades to stage 1.
   The classifier can refine a decision; it can never break a request.

Output: `{ type, complexity, modalities, confidence, stage, alias, reason }`.
`type` uses the vocabulary `code | research | math | reasoning | vision | search |
chat | image_gen`, and `alias` is the capability alias to route through.

### 3. Capability aliases (`open-sse/services/harness/capabilityAliases.ts`)

Seven reserved **bare** model names: `code`, `vision`, `reasoning`, `math`,
`research`, `search`, `chat`. Sent as the `model` on any chat-shaped surface
they resolve — at request time, every request — to an ephemeral **priority
combo** over the tag index's current best specialists for that capability:

- Ranked by the task's axes (SWE-bench for code, MATH-500 for math, GPQA for
  reasoning, LMArena for chat), distinct models, provider-diverse, top 6.
- Because the alias IS a combo, the full native machinery applies: priority
  failover across candidates, admission, circuit breakers, quota-share,
  protocol translation, streaming. A vendor outage or a better model landing
  tomorrow is absorbed with zero edits.
- Resolution order in `getComboForModel` (`src/sse/services/model.ts`):
  exact DB combo → model-combo mappings → **capability alias** → ordinary
  model. Operator-owned combos named `code` deliberately override the alias;
  `provider/code` (prefixed) is an ordinary model reference.
- Resolution ladder when a category is empty: category fallback
  (research/search → chat), then capability-floor drop (requireTools/
  requireVision), then null — a 404 from the model layer, never a silent
  wrong route.

## HTTP surface (API-key policy)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/models/catalog` | Full capability catalog: categories, composite + per-axis scores, flags, context. Filters: `category`, `axis`, `providers`, `minBenchmark`, `requireTools`, `requireVision`, `limit`, `offset`. |
| `GET /api/v1/models/best?task=code` | The allocator query. `task` in classifier vocabulary (or raw `category=` + `axis=`). Same `TASK_TYPE_TO_QUERY` mapping the classifier and aliases use — the three can never drift apart. |
| `POST /api/v1/harness/classify` | Classify without executing. Body is a chat-shaped request; `{ "useModel": true }` enables stage 2. |
| `POST /api/v1/harness/task` | Classify → rewrite `model` to the alias → execute via this server's own `/v1/chat/completions` with the caller's credentials. Streaming passes through verbatim. `?alias=code` forces a route; `?classify_only=true` returns only the decision. Response carries `X-Harness-Route` and `X-Harness-Tier` headers. |

> `catalog` and `best` are reserved words under `/api/v1/models` (they
> out-rank the `[...model]` catch-all). A provider model literally named
> "catalog" is still reachable as `provider/catalog`.

### Examples

```bash
# Who is best for code right now?
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:3000/api/v1/models/best?task=code&limit=4"

# Classify a request
curl -H "Authorization: Bearer $KEY" \
  -d '{"messages":[{"role":"user","content":"refactor this bug"}]}' \
  http://localhost:3000/api/v1/harness/classify
# → { classification: { type: "code", complexity: "fast", alias: "code", … } }

# Fire-and-forget: the gateway picks and routes the model
curl -H "Authorization: Bearer $KEY" \
  -d '{"messages":[{"role":"user","content":"prove this bound"}]}' \
  http://localhost:3000/api/v1/harness/task
# → response from the MATH-500-ranked priority combo, X-Harness-Route: math

# Or skip the harness endpoint and just use the alias as a model:
curl -H "Authorization: Bearer $KEY" \
  -d '{"model":"code","messages":[…]}' \
  http://localhost:3000/api/v1/chat/completions
```

## What builds on this (B2+)

- **Layer 4 (B2): agent registry + spawner** — `capability_need` strings in
  spawn requests resolve through this same index.
- **Layer 5 (B3): SwarmCoordinator** — the shipped swarm engine's task steps
  gain classifier-derived `capability_need` defaults.
- **Layer 2 (B4): hermes plugin** — `X-Harness-Tier` (fast/deep) already
  emitted by `/v1/harness/task` feeds its complexity tiers.

## Seeding policy

Axis seeds intentionally extend the curated flagship set of the composite
table (same ids, versioned, no family patterns). To re-seed or override:

- Edit `AXIS_SEEDS` in `open-sse/services/modelTags/benchmarkAxes.ts` —
  keep the discipline: versioned ids that exist in the provider catalog,
  0..100 ballparks, a `basis` note on every entry.
- Or supply a runtime `scoreLookup` when building the index — it outranks
  seeds and marks `source: "runtime"`.
