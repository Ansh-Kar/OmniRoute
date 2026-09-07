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
