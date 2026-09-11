# OmniRoute — parallel-execution fork

Fork of [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)
(`release/v3.8.51`, base commit `f9a1cc8`) tuned for **parallel execution**:
multiple models from multiple providers working simultaneously, chosen by
**what they are good at**, on a gateway whose admission and transport layers
don't throttle the concurrency back down.

Branch: `fork/parallel-execution`. Everything else is upstream — rebase often,
diverge deliberately.

## Why

- Adding more providers only maximizes usage if requests actually run **in
  parallel** across them. OmniRoute's fusion strategy already fans a prompt
  out to a panel and synthesizes with a judge — but the panel was a
  hand-maintained model list that rots with every vendor release, and the
  default admission profile was tuned for memory safety on small hosts, not
  for agent fan-out.
- Choosing models for a task ("a coder", "vision for item recognition",
  "speech-to-text") required client-side catalog filtering. There was no
  uniform retrieval vocabulary.

## What the fork changes

### 1. Model tagging: provider + category + benchmark (`open-sse/services/modelTags`)

3300+ models from the chat registry and every media registry are tagged with
provider, a closed category vocabulary (`chat`, `coder`, `reasoning`,
`vision`, `image-gen`, `image-edit`, `video-gen`, `speech-to-text`,
`text-to-speech`, `music-gen`, `embedding`, `rerank`, `ocr`, `search`,
`moderation`, `upscale`) and a benchmark score (curated versioned seeds,
runtime-overridable via `scoreLookup` for the arena/taskFitness stack).
Retrieval: `findModelsByTags` with filters (category, providers,
`minBenchmark`, tools, vision, context), `distinctModels` (relay duplicates
collapse onto first-party providers) and `diverseProviders` (round-robin).

HTTP surface: `GET /api/models/tags` (management auth), including
`panel=true` panel preview.

### 2. Tag-driven fusion panels (`combo.config.panelFromTags`)

A fusion combo may resolve its panel at dispatch time from the tag index:
distinct models from distinct providers (`perProvider` hard cap, default 1),
quality floor (`minBenchmark`), capability floors, provider allow/blocklists,
size clamped to the fusion `maxPanel` heap guard. Malformed specs and empty
resolutions fall back to the literal `models` list; pre-fork combos are
byte-identical in behavior. Combo schema: `models` may be empty when
`panelFromTags` is present (create + update paths).

Examples: `examples/fusion-parallel/` (combos + import script).

### 3. Agent-swarm combo strategy (`strategy: "swarm"`, `config.swarm`)

The one-call multi-task fan-out that fusion (same task × N models) and
pipeline (different tasks, sequential) both lack: **N different tasks → N
different models, in parallel** (`open-sse/services/swarm.ts`).

- Each task carries its own instruction (injected as the worker's leading
  system turn, reusing `prependSystemInstruction`) and its own worker: an
  explicit `provider/model`, a `fromTags` spec (same selector vocabulary as
  `panelFromTags`, resolved at dispatch time), or the combo's `defaultModel`.
- **Cross-task diversity**: tag resolution skips models already claimed by an
  earlier task while alternatives exist — identical specs still yield
  different models from different providers.
- Workers run chat-shaped like fusion panel members: tools stripped,
  non-streaming, per-target admission lane probe (#9654 discipline), 120 s
  per-task timeout, bounded concurrency pool (default 8).
- Per-task isolation: a failed/timed-out/lane-full task is reported in the
  result and never sinks the run; total failure 503s with per-task reasons.
  More than 40 tasks is refused pre-fan-out (#1905 heap guard).
- Response shapes: labeled sections or structured JSON (synthetic OpenAI chat
  completion), or `synthesize: true` — a synthesizer call on the original
  request (streaming + tools preserved, fusion-judge discipline; #6771-style
  bypass for tool-bearing requests without synthesis).
- **Per-request swarms**: `body.swarm` (tasks + any run option) overrides the
  combo's stored tasks and is stripped before workers are dispatched; a combo
  may also define tasks as `models` steps with per-step `prompt` (the pipeline
  shape, executed in parallel).
- Registered as a canonical routing strategy end-to-end:
  `ROUTING_STRATEGY_VALUES`/`ROUTING_STRATEGIES` metadata,
  `HANDLED_COMBO_STRATEGIES`/dispatch leaves (known-symbols gate G1),
  `comboStrategySchema` (schema options derive from the shared constant), and
  `combos.swarm`/`combos.swarmDesc` i18n keys in all 42 locales. The combo
  schema allows an empty `models` list when `config.swarm.tasks` is present.

Examples: `examples/swarm/` (combos + import script + README).

### 4. Parallel-agent admission + transport profile (deployment defaults)

No admission **code** changes — upstream semantics are kept exactly (all 74
admission/proxy-dispatcher tests green). The fork ships deployment defaults
instead (`.env.example`, `docker-compose.yml`, annotated in
`docs/reference/ENVIRONMENT.md`):

| Variable                                    | Upstream | Fork    | Why                                                 |
| ------------------------------------------- | -------- | ------- | --------------------------------------------------- |
| `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT`        | unset    | `4`     | main + 3 concurrent subagents; match agent count    |
| `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS`         | `2000`   | `5000`  | drain bursts server-side (#9012 guidance)           |
| `OMNIROUTE_CHAT_ADMISSION_MAX_QUEUED_BYTES` | `4 MB`   | `16 MB` | several ~750 KB agent bodies parked during the wait |
| `OMNIROUTE_PROXY_DISPATCHER_CONNECTIONS`    | `32`     | `64`    | fusion panels × agents sharing one account proxy    |

### 5. Harness B1 — capability routing (`feat(harness)` @ 056cc85ce)

Layer 3 of the agent harness: **the caller names the work, the gateway picks
the model.** Full guide in `docs/guides/HARNESS.md`.

- **Benchmark axes** (`open-sse/services/modelTags/benchmarkAxes.ts`): six
  normalized 0..100 axes — `swe_bench`, `humaneval`, `math500`, `gpqa`,
  `mmlu`, `lmarena_elo` (ELO via `(elo−1200)/3`) — seeded over the curated
  flagship set with the same discipline as the composite seeds (basis notes,
  runtime `scoreLookup` outranks seeds, "no evidence" is never a number).
  `findModelsByTags` gains `axis:` — one axis ranks and floors the whole
  chat registry; no axis = byte-identical pre-B1 behavior.
- **Task classifier** (`open-sse/services/harness/classifier.ts`): free
  stage-1 heuristics (image parts → vision; keyword scoring → code / math /
  reasoning / research / search; deep markers + size + history → fast/deep)
  plus an opt-in stage-2 model call that only refines low-confidence
  verdicts and degrades to stage 1 on any failure.
- **Capability aliases** (`capabilityAliases.ts`): bare reserved model names
  `code`/`vision`/`reasoning`/`math`/`research`/`search`/`chat` resolve —
  per request, inside `getComboForModel`, after DB lookups — to ephemeral
  PRIORITY combos over the index's current best specialists. Full native
  combo machinery applies (failover, admission, breakers, translation).
  Operator combos named `code` deliberately override; `provider/code` is an
  ordinary model; empty resolution falls through to a 404, never a wrong
  route.
- **API** (API-key policy): `GET /api/v1/models/catalog`,
  `GET /api/v1/models/best?task=`, `POST /api/v1/harness/classify`,
  `POST /api/v1/harness/task` (classify → rewrite model to the alias →
  self-fetch `/v1/chat/completions` with forwarded credentials; streaming
  passthrough; `X-Harness-Route`/`X-Harness-Tier` headers;
  `?classify_only`/`?alias` overrides). Documented in both OpenAPI specs;
  routes + coverage gates green (699 paths / 99.3%).
- Tests: `tests/unit/services/harness-b1.test.ts` (17 — axis
  seeding/ranking/reordering/floors, legacy parity, classifier incl. hostile
  shapes and stage-2 degradation, alias construction + live-registry
  resolution, `getComboForModel` seam e2e). `typecheck:core` clean.

### 5b. Harness B2 — Hermes contract surface (`feat(harness)`)

Guide 1 Part 6 `/quick` + Guide 2's capability vocabulary (see
`docs/guides/HARNESS.md` §B2 and `docs/guides/ORCHESTRATION_SPEC.md`):

- **`plan` task type + alias + classifier class** — Guide 2's six contract
  strings (`vision · image_gen · code · research · plan · chat`) all work
  across the B1 surface; whole-registry GPQA/MMLU ranking.
- **Budget tiers** — bare-name suffix `alias:best` (top-3 specialists) and
  `alias:cheap` (fast-tier names from a widened pool, relaxing to `any` when
  empty). Unknown suffixes fall through to ordinary resolution;
  provider-prefixed names never parse as budget aliases.
- **`POST /api/v1/orchestrate/quick`** — single delegated task,
  synchronous, guide-shaped response `{ok, model, provider, text,
  latency_ms, score, decision}` with model/provider/decision read from the
  pipeline's own `X-OmniRoute-*` headers; `image_gen` dispatches the images
  API with the index's best image specialist; `Idempotency-Key` is
  forwarded so the chat pipeline's NATIVE idempotent replay applies;
  errors are guide-shaped (400 per-field `invalid_request`, 503
  `no_active_models`).
- Tests: `tests/unit/services/harness-b2.test.ts` (12 — plan vocabulary,
  budget tiers + relaxation, seam resolution, quick shape mapping with
  stub dispatches incl. 503/throw paths and image_gen). All services
  417/417, openapi routes/coverage, typecheck:core green.

### 5c. Harness B3 — orchestrator core (`feat(harness)`, Guide 1 Parts 3+5+6)

Jobs, waves, and the plan API (parallel mode; swarm/blackboard/judge is
B3.5). See `docs/guides/HARNESS.md` §B3:

- **Jobs store** — `orchestrate_jobs` / `orchestrate_tasks` /
  `orchestrate_job_log` (SQLite, idempotent bootstrap; prefixed to avoid
  the jobRegistry `jobs` table). Task state machine `queued → running →
  done | failed` with attempts, and a per-transition audit log.
- **Planner** — topological waves: a task is ready when every `depends_on`
  is done; ready tasks fire in parallel (max_concurrency, default 8);
  upstream results inject into dependents (`Upstream outputs:` + per-dep
  result truncated to 800 chars); failed deps BLOCK dependents with
  reasons surfaced, never guessed around.
- **Runner** — requeues transient failures up to `max_attempts` (default
  3); deadline exceeded → job `failed("deadline")` with partial results
  intact. Every task dispatches through its capability alias (+ job budget
  tier) via the native chat pipeline, so provider diversity/failover come
  from the combo machinery. Pure logic + `JobsStore` interface —
  in-memory store for tests/embedders, SQLite store for production.
- **API** — `POST /api/v1/orchestrate/plan` (admission validation with
  per-task errors replacing `validate_plan.py`: unknown tags, duplicate
  ids, dangling depends_on, cycles, empty tasks, 40-task cap;
  Idempotency-Key replays return the ORIGINAL job, never re-executing;
  202 + background wave loop) and `GET /api/v1/orchestrate/jobs/{id}`
  (status, waves, per-task state/model/latency/attempts, log tail;
  `?wait=N` long-poll). `mode:"swarm"` rejected with an explicit
  next-build error.
- Tests: `tests/unit/services/harness-b3.test.ts` (12 — admission matrix,
  clamping, planner readiness/blocking/truncation, runner e2e with
  scripted dispatches: two-wave upstream injection, requeue-then-succeed,
  attempts-exhausted + blocked dependent, deadline partials, idempotency
  conflict, API shape). services 429/429, openapi 702 paths / 99.3%,
  typecheck:core clean.

### 5d. Harness B3.5 — swarm mode (`feat(harness)`, Guide 1 Part 7)

Blackboard, bounded A2A relay, and the judge loop on the B3 wave engine
(see `docs/guides/HARNESS.md` §B3.5):

- **Blackboard** — swarm prompts wrapped with `<shared context>` (goal,
  snapshot, `[LOCKED]` markers, part identity, output contract: a ≤15-line
  `<summary>` block); the HARNESS parses summaries into
  `blackboard.summaries.<taskId>` — workers never write the board, locked
  keys untouchable (plans locking missing keys are rejected at admission).
  `GET /v1/orchestrate/jobs/{id}/blackboard` = snapshot + append history.
- **Bounded A2A relay** — one `@ask <task-id>: <question>` per worker per
  wave, relayed by the harness as a single ≤30s dispatch to the asked
  worker's specialty; the answer lands on `blackboard.mailbox`. Stateless
  workers keep the guide's failure modes (drift/burn/loops) avoided by
  construction.
- **Judge loop** — after the waves, status `judging`: a `plan`-tagged
  (image jobs: `vision`) judge reviews summaries against the locked canon
  or a caller check, strict-JSON verdicts; failed parts re-queue with
  `[judge feedback, round N]` injected (attempts reset); `max_rounds`
  (default 3, cap 5) hard-stops refinement — final output accepted with
  flaws logged (`task_flaw_accepted`). Unparseable verdicts never
  fabricate a clean pass. `POST /jobs/{id}/judge` for manual advance.
- **Per-task media dispatch** — `image_gen` tasks dispatch the images API
  with the tag index's top image specialist (no chat-alias detour);
  image models skip the shared-context wrapper.
- Tests: `tests/unit/services/harness-b35.test.ts` (14 — prompt assembly,
  summary/merge with locked keys, @ask parsing + relay + degradation,
  judge input/vision-tag/parsing, runner e2e: blackboard fill + clean
  pass, requeue-with-feedback, max_rounds flaw acceptance, mailbox answer
  + unanswered note, image-task raw prompt). Combined harness suites
  55/55; services 443/443; openapi 704 paths / 99.3%; typecheck:core
  clean.

### 5e. Harness B4 — hermes surface + NIM hardening (`feat(harness)`, Guide 2 Layer 2)

The Guide 2 hermes plugin mapped onto the fork's alias infra (no runtime
plugin loader exists — a static registry IS the plugin), NVIDIA NIM 429
hardening, complexity tiers, and orchestrator trace headers (see
`docs/guides/HARNESS.md` §B4):

- **`hermes/*` reserved model namespace** — `hermesCombos.ts` maps ten
  role-shaped names onto capability aliases with fixed budget tiers
  (`hermes/fast`→`chat:cheap`, `hermes/smart`→`chat:best`,
  `hermes/code`/`code-best`/`reason`/`plan`/`math`/`vision`/`research`/
  `search`). Resolved at `getComboForModel` step 3.5 — after DB combos
  (operator wins), exact names only, unknown names 404 (never mis-route).
  `hermes` added to the reserved provider prefixes (408→409): custom nodes
  cannot shadow the namespace.
- **NIM 429 hardening** — `nimRateLimitTracker.ts` (per-connection sliding
  60s request windows, Retry-After-derived cooldowns capped at 5 min,
  learned RPM ceilings) + a `nvidia` 429 failover block in `chatCore`
  (codex-pattern): persist cooldown via `markConnectionRateLimitedUntil`
  (survives token refresh, visible to all requests), rotate to a sibling
  key preferring unsaturated ones, ≤3 attempts, probe-origin 429s isolated
  (#9817 parity), all-keys-cooling → 429 passthrough with Retry-After.
- **Complexity tiers** — `/v1/harness/task?tier=auto`: fast→`alias:cheap`,
  deep→`alias:best`; `X-Harness-Budget` response header; default unchanged.
- **Trace headers** — orchestrator dispatches carry `X-OmniRoute-Job`/
  `Task`/`Wave` through the self-fetch (both chat and images paths).
- Tests: `tests/unit/services/harness-b4.test.ts` (19 — tracker windows/
  cooldowns/ceilings/caps/decay/reset, hermes registry+membership+
  resolution+tier contract+reserved prefix, tier=auto route deep/fast/
  default/forced) + reserved-prefix suite extended (hermes node rejection,
  count 409). Combined harness 74/74; services 461/461; openapi 704
  paths / 99.3%; typecheck:core clean.

### 5f. Harness B5 — allocator, drift loop, lease expiry (`feat(harness)`, Guide 1 Parts 4+8)

Guide 1 Part 4+8 completion — the live half of routing on top of B1's
static ranks (see `docs/guides/HARNESS.md` §B5):

- **Allocator scoring** — `open-sse/services/harness/allocator.ts` (pure,
  deterministic): `quality × (0.5+0.5×health) × (0.5+0.5×speed) ×
  breaker_penalty`; health/speed from the jobs store's own per-model task
  outcomes (`aggregateModelStats`, both stores), Laplace-smoothed so no
  history is neutral.
- **Assigned routing** — `policy.routing: "assigned"` runs
  provider-diverse water-filling per wave (`max_per_provider`, unused-model
  preference) and dispatches the literal picked model (`task_assigned`
  logged with score); default stays `"alias"` (B1 behavior, native combo
  failover). Unassignable tasks fall back to the alias, logged. Image
  dispatch honors assignments.
- **Judge drift loop** — every verdict writes back per served model: two
  consecutive fails → quality −0.05 per further fail (floor 0.3),
  `model_drift_penalty` logged; persisted in `orchestrate_model_drift`
  (SQLite) / in-memory map; feeds the next wave's allocator.
- **Lease expiry + work-stealing** — tasks carry `lease_until`
  (`max(5min, task_timeout+30s)`); expired running leases are stealable,
  and each wave sweeps lost tasks back to `queued` (`lease_expired` logged,
  attempts preserved) — Part 9 acceptance "lease expiry requeues" is a
  tested behavior in both stores.
- Tests: `tests/unit/services/harness-b5.test.ts` (19 — score formula
  exactness, water-fill/max_per_provider/penalty/health reordering,
  determinism, lease lifecycle + steal + requeue + SQLite parity, drift
  streak/reset/cap + SQLite parity, policy clamps, e2e: alias vs assigned
  dispatch, lease-expiry recovery, judge drift write-back). Combined
  harness+regression batch 124/124; openapi 704/99.3%; fastcheck tsc clean.

### 5g. Harness B6 — cost budgets (`feat(harness)`, cross-cutting)

`policy.max_total_tokens` + per-task token usage accounting (see
`docs/guides/HARNESS.md` §B6):

- **Usage** — dispatch outcomes carry OpenAI-style usage; per-task
  `prompt_tokens`/`completion_tokens` columns (both stores) aggregate into
  `jobToApi().usage`; unreported usage never fabricated.
- **Breach** — unstarted tasks abort (`task_budget_aborted`), deferred
  tasks swept, job fails `budget_exhausted` with partial results visible;
  deadline semantics; default 0 = unlimited (unchanged behavior).
- Tests: `tests/unit/services/harness-b6.test.ts` (7 — policy clamps,
  usage accounting + jobToApi aggregation, SQLite round-trip parity,
  budget abort e2e incl. deferred sweep, no-budget and
  usage-less-dispatch guards). Combined batch 131/131; openapi 704/99.3%.

### 5h. Harness B7 — multimodal task dispatch (`feat(harness)`, cross-cutting)

Task `modality` + three new media capability tags (see
`docs/guides/HARNESS.md` §B7):

- **Modality** — `text|image|search|speech|music|video`; media tags
  imply theirs (`audio_speech`/`music_gen`/`video_gen` are new tags with
  registry subcategories `text-to-speech`/`music-gen`/`video-gen`);
  `search` on a chat tag = literal `/v1/search` dispatch. Validation
  enforces tag/modality compatibility.
- **Dispatch** — media endpoints via self-fetch (speech returns audio
  bytes → base64 envelope ≤192 KB, digest beyond; music/video JSON
  envelopes capped at 2 MB with sha256 + `truncated`); search results
  envelope carries query + results.
- **Semantics** — media tasks skip swarm wrappers, can't answer @ask
  (`mailbox_skipped`), image/video jobs get a vision judge;
  `task.modality` in jobToApi; SQLite column with tag-implied fallback
  for pre-B7 rows.
- Tests: `tests/unit/services/harness-b7.test.ts` (9 — validation
  compatibility rules, runner plumbing, mailbox skip, envelope caps,
  SQLite round-trip). Combined batch 140/140; openapi 704/99.3%.
- Toolchain: `min-deps.package.json` js-yaml pin corrected
  (`^5.4.1` → `^4.1.0` — v5 doesn't exist; the stale tarball shipped
  3.15.2 and broke the openapi check scripts' named imports); deps
  tarball rebuilt with js-yaml 4.3.2.

### 5i. Harness B8 — cross-cutting hardening (`feat(harness)`)

Compression + canaries + benchmark wiring + Guide 2 fork-side mechanics
(see `docs/guides/HARNESS.md` §B8):

- **Compression** — `policy.compress_context` (default false): Caveman/
  lite over each swarm worker's context before fan-out; code preserved;
  `context_compressed` log with token delta; verbatim fallback.
- **Canaries** — 2-consecutive-failure dead marking; freshness window
  (stale dead stops filtering); `findModelsByTags` skips fresh-dead;
  empty state = no behavior change. Routes:
  `GET /v1/models/canaries`, `POST /v1/models/canaries/check`
  (reachability semantics: any HTTP answer = alive).
- **Benchmark wiring** — DB-backed taskFitness (user override → arena
  ELO → models.dev tier) injected as the live index's `scoreLookup`
  (coder→coding, reasoning→analysis only; ×100 rescale).
- **Guide 2** — bare `model: "auto"` classifies + routes on the direct
  chat path; `policy.retry_503_after_ms` on /quick retries ONCE before
  the honest 503.
- Toolchain: deps tarball layout bug fixed (nested `minstall/` prefix
  silently broke node_modules links) + setup-fast.sh now fails loudly on
  a broken link.
- Tests: `tests/unit/services/harness-b8.test.ts` (15 — retry semantics,
  compression on/off + control comparison, canary state machine +
  ranking skip + probe semantics, override→runtime-score flow, auto
  classifier decisions). Combined batch 155/155; openapi 706/99.3%;
  fastcheck tsc clean.

### 5j. Harness B9 — the breaker feed (`feat(harness)`)

The allocator's 0.2 multiplier reads the live provider breaker registry
(see `docs/guides/HARNESS.md` §B9): OPEN/HALF_OPEN penalize, DEGRADED/
CLOSED/unknown don't; persisted-state fallback survives restarts;
`peekCircuitBreaker` reads without creating; `RunnerDeps.breakerOpen`
plumbs it from the plan route (absent = B5 behavior). Tests:
`tests/unit/services/harness-b9.test.ts` (7 — predicate signature +
score math, feed semantics incl. persisted fallback + no-creation,
runner steering away from an open provider). Combined batch 162/162;
openapi 706/99.3%; fastcheck tsc clean.

### 5k. Docs — USAGE.md + JOURNEY.md (`docs(fork)`)

`docs/guides/USAGE.md`: the consolidated endpoint syntax — model:"auto"
and the alias/hermes vocabularies, /quick (incl. retry_503_after_ms),
/plan (tags, modality rules, full policy table), jobs polling shape and
failure reasons, /harness/task variants, /v1/models/best, the canary
routes, trace headers, and task-state semantics.
`docs/guides/JOURNEY.md`: the decision log — per-build rationale,
rejected alternatives, and the process scars (drift-penalty rounding,
silent tarball links, box-bound tsc). The workspace README gained the
same usage section and a journey pointer.

### 5l. B10 — Objective orchestration for the brain (`feat(harness)`)

The OpenResearch adaptation (alphaXiv), translated from their research
agent workspace to our gateway: **the caller names objectives, not models
and not tags.**

- **Tag inference** — `tag` optional on every plan/objective task; the
  classifier's stage-1 heuristics infer it from the prompt (`tag_inferred`
  log, `inferred_tags` in responses). Explicit tags still win; unknown
  tags still 400. `objectiveToPlanBody` normalizes the new
  `POST /v1/orchestrate/objectives` body (subtasks optional — a bare
  objective becomes the single task) through the ONE admission path
  (validatePlan).
- **Bias guard** — `caller_model` on the job (SQLite column; jobFromPlan
  from the body). When set (and `policy.bias_guard` not false): alias
  routing pins the best tag-viable NON-caller model (`bias_avoided`
  logged); assigned routing scores the caller's model ×0.6
  (allocator `avoidModel`); the judge also avoids it (self-grading is the
  sharpest bias); no alternative → runs anyway, flagged
  `bias_same_model` per task in jobToApi. Penalty, not a ban — never
  deadlocks a single-model deployment.
- **Stream scheduling** — `policy.scheduling: "wave"|"stream"` (wave
  default, byte-identical B3 barriers). Stream = per-completion
  admission (the `orx exp wait` loop shape): a freed slot refills
  immediately (no barrier), `task.wave` carries the dispatch ordinal,
  swarm blackboard merges + mailbox relays land per completion. The
  stream loop is deliberately parallel to runWaves (shared building
  blocks, different admission discipline) so the battle-tested wave path
  stays untouched. Tests caught the double-count bug (running-state ∪
  tracked-launches) that would have quietly reintroduced the barrier.
- **Refill + spawn + wakes** — `POST /jobs/{id}/tasks` appends to a
  LIVE job (deps may reference existing tasks; 409 `job_terminal`);
  `POST /v1/orchestrate/spawn` creates a helper job with a self-contained
  brief (context copied verbatim, never derived), no nesting (409), an
  in-flight cap of `policy.max_children` (429, default 4 ≥ the admission
  floor of 2), and the bias guard propagates to children;
  `GET /jobs/{id}/wait-first` wakes on the first task completion since
  call start (baseline-diffed `completed_since`, `drained` exit);
  `GET /v1/orchestrate/wait?job_ids=` is the multi-job analog.
- **Drive-by fixes** — the jobs route's `?wait=` long-poll claimed a 60s
  cap but never enforced it (stuck-active job = infinite spin); bounded
  by wall clock now. Build-1 (parallel session) type breaks repaired:
  the OpenDev policy fields were missing from the Required<> assembly
  (every persisted row carried undefined), `TaskType` wasn't re-exported,
  and "worktree" modality crashed `pickMediaModel`'s type (it's an
  execution location, not an endpoint family — dispatch treats it as
  text). New `tsconfig.harness-check.json` gate: tsc over the whole
  harness/orchestrate slice (fastcheck never covered these files — its
  21s "clean" was checking 27 core files + imports).

Tests: `tests/unit/services/harness-b10.test.ts` (25 — inference,
objective/spawn normalization, allocator penalty-not-ban, e2e alias/assigned
bias avoidance, stream refill-before-barrier timing proof, wave still
barriers, stream retry/deadline/budget/swarm-per-completion, refill
validation, lineage, jobToApi surface). Combined batch 177/177; harness
tsc 0 errors; openapi 709/714 (99.3%).

### 6. Transport: concurrent proxy dispatcher streams (already upstream)

PR [#4288](https://github.com/diegosouzapw/OmniRoute/pull/4288)
(`fix(proxy): allow concurrent proxy dispatcher streams`) was **merged into
`release/v3.8.30`** — this fork's v3.8.51 base already contains the
concurrent-tunnel pooling (`OMNIROUTE_PROXY_DISPATCHER_CONNECTIONS`, default
32, cap 256) that replaced the single shared upstream socket. Verified in this
fork: `tests/unit/proxy-dispatcher-family.test.ts` and
`tests/unit/proxy-concurrency-keepalive-regression.test.ts` pass. The fork's
contribution is the capacity bump above + documentation.

## Incidental fixes

- `open-sse/config/audioRegistry.ts`, `open-sse/config/rerankRegistry.ts`:
  explicit array annotations in `getAllAudioModels`/`getAllRerankModels` —
  these files entered the `typecheck:core` program (via the tag index's
  imports) with latent `never[]` inference errors under the core tsconfig.

## Documentation

- `docs/guides/PARALLEL_EXECUTION.md` — the full guide (tags, panels, swarms,
  admission, transport).
- `docs/guides/HARNESS.md` — the agent-harness Layer-3 surface (axes,
  classifier, aliases, catalog/task API) and the seeding policy.
- `examples/fusion-parallel/README.md` — fusion panel examples walkthrough.
- `examples/swarm/README.md` — swarm examples walkthrough.
- `docs/reference/ENVIRONMENT.md` — fork deployment defaults annotated on the
  affected rows.

## Verification (this fork, on the v3.8.51 base)

- `tsc -p tsconfig.typecheck-core.json` — clean.
- New tests: `tests/unit/services/model-tags.test.ts` (15),
  `tests/unit/services/fusion-tag-panel.test.ts` (5, e2e through the real
  combo engine + live registry),
  `tests/unit/services/swarm-strategy.test.ts` (21, e2e dispatch + pure
  units: parallel fan-out, body.swarm override, tag diversity, partial/total
  failure, synthesis, tool-bearing bypass, schema, parsing).
- Existing suites re-run green: fusion strategy/judge/partial-failure (10),
  combo-config schema, full `tests/unit/combo/*` + `fusion-*` (203),
  `tests/unit/services/*` (388), admission + proxy-dispatcher (377),
  `autocombo-unification` (7 — strategy parity).
- i18n gates: translation-ratio (41 locales within baseline) and
  ui-keys-coverage (all ≥ 80%) — `combos.swarm`/`combos.swarmDesc` added to
  all 42 locales.
- Gates: `check:env-doc-sync`, `check:openapi-routes` (695 paths),
  `check:api-docs-refs`, `check:known-symbols` (21 canonical strategies, all
  dispatched) — all pass.

Not re-verified here (sandbox limits): `typecheck:api`/dashboard typecheck
(needs >2 GB RAM for the full Next.js program) and the Electron/Docker builds.
Run those in CI.

## Rebase procedure

```bash
git remote add upstream https://github.com/diegosouzapw/OmniRoute.git
git fetch upstream
git rebase upstream/release/v3.8.5x   # conflicts expected only in:
                                      #   .env.example, docker-compose.yml,
                                      #   ENVIRONMENT.md rows, combo schema,
                                      #   docs/openapi.yaml (path block)
```

The fork's code footprint is deliberately small and additive (one new module
directory, ~30 lines in `dispatchPrelude.ts`, one schema block, one route
file, two registry type annotations) to keep rebases mechanical. Changelog
fragments are intentionally not added to `changelog.d/` — this file is the
fork's changelog; drop the commits upstream as PRs if you want them landed
and let the fragments come from the PR numbers.
