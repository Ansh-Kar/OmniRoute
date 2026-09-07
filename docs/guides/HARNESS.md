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

## Guide 1 reconciliation (orchestration spec ↔ shipped B1)

The authoritative product spec for B2+ is `docs/guides/ORCHESTRATION_SPEC.md`
("Guide 1" — jobs store, allocator, planner waves, `/v1/orchestrate/*`,
blackboard/A2A/judge loop). Its consumer-side counterpart — the Hermes brain
contract, abstraction rules, and the end-to-end verification matrix — is
`docs/guides/HERMES_ABSTRACTION_SPEC.md` ("Guide 2"). B1 already implements
Guide 1's foundation; the deltas are recorded here so the two vocabularies
can never drift silently.

### Vocabulary mapping

| Guide 1 contract string | Fork (B1) equivalent | Notes |
|---|---|---|
| `code` | `code` | identical — SWE-bench-ranked alias |
| `vision` | `vision` | identical |
| `image_gen` | `image_gen` | task type (media endpoint, not chat dispatch) |
| `research` | `research` | search-grounded category, chat fallback |
| `plan` | `reasoning` (gpqa/mmlu axes) | **B2 action**: add `plan` as an accepted task type + capability alias with the same axes, so the Hermes contract's exact strings all work; `reasoning` remains as the fine-grained internal name |
| `chat` | `chat` | identical (LMArena-ranked) |
| — | `math`, `search` | fork extras (MATH-500 axis; web-search category) — supersets are safe: the contract requires its strings to exist, not others to not |

### Surface mapping

| Guide 1 | Fork status |
|---|---|
| Part 2 tagging + classifier port | ✅ B1 (`benchmarkAxes.ts`, `classifier.ts`, tag index `axes:`) |
| Part 4 allocator (static `quality[tag]` + provider round-robin) | ✅ B1 capability aliases (axis-ranked, distinct + provider-diverse) |
| Part 6 `/v1/orchestrate/quick` | B2 — thin wrapper over B1's `/v1/harness/task` (`?alias=`) plus budget→floor mapping |
| Part 3 jobs store + leases, Part 5 planner, Part 6 `/plan` + jobs, Part 7 swarm manager | B3 (SwarmCoordinator) — builds on the shipped `strategy: "swarm"` engine; workers stay logical dispatches (guide Part 1: everything submits through the existing routing path) |
| Part 8 health × speed × breaker multipliers + drift | B3 allocator wiring + B5+ drift loop |
| Idempotency-Key, deadline, `X-OmniRoute-Job/Task/Wave` headers | B3 acceptance criteria (guide Part 9 step 6) |

### Boundary rule (verbatim from the guide, enforced by design)

> The brain decides WHETHER to delegate; the harness decides HOW to execute.
> The gateway must never decide to spawn sub-agents on its own.

B1 complies: `/v1/harness/task` routes and executes ONE delegated request;
fan-out only happens when the caller explicitly configures a swarm/fusion
combo or sends `body.swarm`.

## B2 — the Hermes contract surface (Guide 1 Part 6 /quick, Guide 2)

**Shipped in B2** (see FORK.md for the commit): `plan` vocabulary, budget
tiers, and `POST /api/v1/orchestrate/quick`.

### `plan` and the Guide 2 capability reference

Guide 2's brain contract uses exactly six strings:
`vision · image_gen · code · research · plan · chat`. All of them now work
across the whole B1 surface (`?task=`, `/harness/classify` output, aliases,
`/harness/task`): `plan` is a first-class task type (whole-registry
GPQA/MMLU ranking, same axes as `reasoning` — decomposition IS deep
reasoning) with its own alias and classifier class. `math`, `search` and
`reasoning` remain as safe supersets.

### Budget tiers — `alias:best` / `alias:cheap`

`policy.budget` from Guide 1 maps to a budget suffix on the bare alias name
(parsed only when there is no provider prefix, so `vendor/code:best` stays
an ordinary model reference):

| Budget | Behavior |
|---|---|
| `any` (default) | the plain alias — top 6 axis-ranked, provider-diverse |
| `best` | top **3** axis-ranked specialists only |
| `cheap` | **fast-tier** models only (name heuristic: flash/mini/air/haiku/lite/nano/small/instant/turbo/fast/`<n>b`), drawn from a widened pool; relaxes to `any` when the tier is empty |

These are documented approximations until per-model cost data lands in the
tag index (B5+); both tiers relax rather than 404 — a thinner route beats a
dead one. Unknown suffixes (`code:deluxe`) are not aliases and fall through
to ordinary model resolution.

### `POST /api/v1/orchestrate/quick`

Single delegated task, synchronous. The brain names a tag, never a model:

```bash
curl -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"tag":"vision","prompt":"describe this image","images":["data:image/png;base64,…"],
       "policy":{"budget":"any"}}' \
  http://localhost:3000/api/v1/orchestrate/quick
# → {"ok":true,"model":"openai/gpt-5.6","provider":"openai","text":"…",
#    "latency_ms":812,"score":0.84,"decision":{"strategy":"priority",…}}
```

- Chat-shaped tags execute through the alias (full native failover);
  `model`/`provider`/`decision` come from the pipeline's own
  `X-OmniRoute-*` response headers — never guessed.
- `image_gen` resolves the tag index's best image specialist and dispatches
  the images API with that explicit model (single-model in B2; the B3
  allocator brings real image failover).
- `Idempotency-Key` is forwarded into the chat pipeline, so **native
  idempotent replay** applies to quick calls unchanged.
- Errors: `400 {"ok":false,"error":"invalid_request","details":[…]}`
  (per-field, for the brain's one corrected re-emit) and
  `503 {"ok":false,"error":"no_active_models","tag":…}` when a capability
  has no live candidates — the guide's "capability temporarily unavailable"
  case.

`score` is the served model's axis score (0..1) for the tag's ranking axis
(null when the served model has no evidence).

## B3 — the orchestrator core (Guide 1 Parts 3+5+6, parallel mode)

**Shipped in B3**: jobs store + task state machine, planner waves, and
`POST /v1/orchestrate/plan` + `GET /v1/orchestrate/jobs/{id}`. Swarm mode
(blackboard + A2A mailbox + judge loop, guide Part 7) lands in B3.5.

### Execution model

```
POST /v1/orchestrate/plan {goal, mode:"parallel", tasks:[{id, tag, prompt, depends_on}], policy}
   → 202 {ok, job_id, status:"active", accepted:N}
waves: ready tasks (all depends_on done) fire in parallel (max_concurrency);
       upstream results are injected into dependents ("Upstream outputs:" +
       per-dep result truncated to 800 chars); transient failures requeue
       (attempts < max_attempts), exhausted tasks fail and BLOCK dependents;
       deadline exceeded → job failed("deadline"), partial results intact.
GET /v1/orchestrate/jobs/{id}?wait=30 → status, waves, tasks, log tail
```

- **State machine** (guide Part 3): `queued → running → done | failed`;
  every transition writes `orchestrate_job_log` — the audit trail.
- **Allocator**: each task's tag dispatches through its capability alias
  (with the job's budget tier), so provider diversity and failover come
  from the native combo machinery; the guide's health×speed multipliers
  ride the same failover path and get explicit scoring in B5+.
- **Persistence**: `orchestrate_jobs` / `orchestrate_tasks` /
  `orchestrate_job_log` (SQLite, idempotent bootstrap; the prefix avoids
  the existing jobRegistry `jobs` table). `image_gen` tasks route via the
  chat alias in B3 (media dispatch per-task lands with B3.5's swarm work).
- **Idempotency-Key**: unique index at the store; replays return the
  ORIGINAL job (200 + `replayed: true`), never re-executing.
- **Admission validation** (replaces `validate_plan.py`): unknown tags,
  duplicate ids, dangling `depends_on`, cycles, empty tasks, task cap 40 →
  `400 {ok:false, errors:[…]}` so the brain re-emits the plan once,
  corrected. `mode:"swarm"` is rejected with an explicit "next build" error.

### Failure semantics (guide Part 7, B3 subset)

| Behind the scenes | API says |
|---|---|
| Task failed, requeued, succeeded | normal `done` (attempts visible in the task row) |
| Task exhausted attempts | task `failed`; dependents stay `queued`; job `done` (with `failure_reason`) when others finished, `failed("blocked")` when nothing can run |
| Deadline exceeded | job `failed("deadline")`, finished results readable, queued tasks untouched |
| Plan invalid | `400` with per-task errors (one corrected re-emit) |

## B3.5 — swarm mode (Guide 1 Part 7)

`mode: "swarm"` now executes: blackboard, bounded A2A relay, and the judge
loop, on top of the B3 wave engine.

### Blackboard (guide Part 7.1–7.2)

Swarm workers' prompts are wrapped with a `<shared context>`: the goal, the
blackboard snapshot (locked keys marked `[LOCKED]`), part identity, and the
output contract — end with a `<summary>` block of ≤15 lines. The HARNESS
parses those summaries and merges them under `blackboard.summaries.<taskId>`;
workers never write anything else, and `_locked` keys are untouchable
(validation even rejects plans that lock missing keys). `GET
/v1/orchestrate/jobs/{id}/blackboard` returns the snapshot plus the append
history (who wrote what, in order).

### Bounded A2A relay (guide Part 7.3, adapted)

Workers are stateless one-shot dispatches, so free-form mid-wave chat is
replaced by its bounded equivalent: a worker may emit ONE
`@ask <task-id>: <question>` line per wave; the harness relays it as a
single ≤30s dispatch to the asked worker's specialty, and the answer lands
on `blackboard.mailbox` — the asker (or the judge) reads it from the shared
state on the next round. Unanswered → `"(unanswered — proceed with a note)"`.
Context drift, token burn, and unbounded loops are avoided by construction.

### Judge loop (guide Part 7.4 + Part 6)

After the waves complete, the job enters `judging`: a judge pass (the
`plan` alias — `vision` for image jobs) reviews every part's summary
against the locked canon (or a caller-supplied check) and returns strict
JSON verdicts. Failed parts re-queue with the verdict injected into their
prompt (`[judge feedback, round N: …]`, attempts reset); clean passes end
the job `done`. `policy.max_rounds` (default 3, capped 5) hard-stops
refinement — the last round's output is **accepted with flaws recorded** in
the job log (`task_flaw_accepted`). Unparseable judge output never
fabricates a clean verdict: the parts are accepted as-is and the anomaly
logged. `POST /v1/orchestrate/jobs/{id}/judge` manually triggers or
advances a pass (409 while running).

### Per-task media dispatch

`image_gen` tasks now dispatch the images API with the tag index's best
image specialist (previously routed via the chat alias). Image models skip
the `<shared context>` wrapper (they cannot follow it) and receive the raw
prompt with upstream notes; their results are stored as image JSON with the
summary falling back to the raw output.

### Failure semantics additions (guide Part 7, swarm)

| Behind the scenes | API says |
|---|---|
| Judge round failed a part, re-ran, clean | normal `done`; `verdict` + `judge_rounds` visible |
| Judge keeps failing a part until max_rounds | `done` with `failure_reason: accepted with judge flaws…`; `task_flaw_accepted` in the log |
| @ask went unanswered | mailbox note on the blackboard; work proceeds |
