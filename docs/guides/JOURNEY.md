# The journey — rationale and decisions, build by build

Why this fork exists, why each build is shaped the way it is, and which
alternatives were rejected along the way. Companion to `HARNESS.md`
(how each build works) and `USAGE.md` (how to call it).

**The goal, stated once:** multiple models from multiple providers
working simultaneously on one job, picked by what they're good at, on a
gateway that doesn't throttle that concurrency back down — and a caller
(the Hermes brain, or any agent) that never sees a model name.

---

## Before the harness: the substrate

**Tag index with provider, category, benchmark retrieval** (pre-B1).
*Decision:* rank models by capability tags and benchmark axes, not ids.
*Why:* "pick a model" is the wrong abstraction — the caller wants a
capability, and model quality per capability changes with every release.
*Rejected:* hand-curated model lists (churn), provider-prefix routing
(still names vendors). The discipline that survived every later build:
**no evidence is never silently converted into a number** — unscored
models sort last instead of getting an invented score.

**Admission + transport profile** (pre-B1, incl. upstream PR #4288).
*Decision:* raise per-key admission limits to ≥ active agents and tune
the dispatcher's concurrent streams. *Why:* the gateway itself was the
bottleneck — the whole point dies if concurrency is clamped to 1–2 at
the front door.

**Agent-swarm combo strategy** (pre-B1). The first "different tasks to
different models" primitive — later generalized by the orchestrator
into waves.

**Guides absorbed verbatim** (B1-era docs commits). The operator's
Guide 1 (orchestration spec) and Guide 2 (Hermes abstraction) were
committed unmodified into `docs/guides/` as authoritative contracts, with
build annotations added under their status trackers. *Why verbatim:*
a spec that gets paraphrased gets drifted; the ticked checklists are the
acceptance criteria every build is measured against.

---

## B1 — capability routing (tags, classifier, aliases)

*Problem:* the brain must stop naming models.
*Decisions:*
- **Classifier is heuristics-first** (regex/weight scoring), with an
  optional stage-2 model pass. *Why:* a classifier call is a wasted
  dispatch when the verdict is immediately exercised — a wrong-but-sane
  route fails over natively. Confidence is reported honestly (`low`
  says so) instead of being hidden.
- **Capability aliases are EPHEMERAL combos** built from the tag index,
  not DB rows. *Why:* no drift between "the alias" and "the current
  best specialists" — the combo is derived at resolution time.
  Operator-created literal combos still win by exact-name precedence.
- **One shared vocabulary** (`TASK_TYPES` → index queries) used by the
  classifier, `/v1/models/best`, and the aliases — "classified as code"
  and "best for code" can never disagree.

## B2 — the Hermes contract (`/quick`, budget tiers)

*Problem:* Guide 2's brain needs one synchronous delegation primitive.
*Decisions:* tag + self-contained prompt in, guide-shaped answer out;
**Idempotency-Key forwarded** so the chat pipeline's NATIVE replay
semantics apply unchanged — no duplicate side effects when the brain
retries. Budget tiers (`:best` / `:cheap`) suffix the alias rather than
forking the vocabulary.

## B3 — the orchestrator core (jobs, waves, plan API)

*Problem:* real work is dependency-ordered and multi-step.
*Decisions:*
- **Jobs store with an append-only audit log** (guide Part 3's
  invariant): every transition is a logged event — the debugging
  lifeline when a 40-task job goes sideways at 3 a.m.
- **Topological waves (Kahn's algorithm):** ready tasks fire in parallel
  (bounded by `max_concurrency`), upstream outputs inject into
  dependents (truncated to 800 chars — context is not free).
- **Deadline semantics = partials stay visible:** on breach the job
  fails `deadline` but completed tasks keep their results. *Rejected:*
  fabricating failure text for unfinished tasks (a partial truth is
  better than a complete lie).
- **Pure runner + injected `TaskDispatch`:** the whole wave loop is
  testable without network — every later build's e2e tests ride this.
- Idempotent replays at the plan level (same `Idempotency-Key` → same
  job, no re-execution).

## B3.5 — swarm mode (blackboard, @ask, judge)

*Problem:* free-form agent collaboration drifts, burns tokens, loops.
*Decisions — each failure mode avoided BY CONSTRUCTION, not by prompt:*
- **Blackboard is append-only and harness-parsed:** workers share state
  only through `<summary>` blocks the harness parses; they cannot write
  each other's shared context. Drift becomes structurally impossible
  instead of politely discouraged.
- **Bounded A2A:** at most ONE `@ask <task>: <question>` per worker per
  wave, relayed by the harness with a 30 s timeout; unanswered → the
  asker proceeds with a note. *Rejected:* open peer-to-peer chat
  (unbounded by definition).
- **Judge loop with a hard cap, then acceptance:** failed verdicts
  requeue with feedback up to `max_rounds`; after that, flaws are
  ACCEPTED and logged (`accepted with judge flaws`). *Why:* infinite
  refinement is the classic swarm failure mode; the guide chose
  "bounded loops" and the implementation makes it literal.
- Media dispatch (image_gen) rides the same wave machinery — the first
  crack in "everything is chat."

## B4 — the Hermes surface (hermes/*, NIM hardening, tiers, traces)

*Decisions:*
- **`hermes/*` reserved namespace mapped onto capability aliases with
  fixed tiers** (`hermes/fast` → `chat:cheap`, `hermes/smart` →
  `chat:best`). *Why:* the client needs a STABLE pin that never churns
  with model releases, while the harness keeps deciding the actual
  model.
- **NIM 429 hardening:** Retry-After cooldowns, sliding-window RPM
  ceilings, rotation to unsaturated keys. *Why:* a rate-limited key
  must be a non-event for the caller — the brain has better things to
  do than backoff arithmetic.
- **`?tier=auto`:** classification complexity picks the budget
  (fast → cheap, deep → best). The brain stops making cost/quality
  judgment calls it has no data for.
- **Trace headers** (`X-OmniRoute-Job/Task/Wave`) on every orchestrator
  dispatch. *Why:* admin logs must be able to explain every sub-call —
  and per the abstraction rules, USER replies never can.

## Toolchain build — the fast-turn environment

*Problem:* sandbox resets cost 5–10 minutes of re-clone/re-install per
turn; the full 2700-package install OOMs a 2 GB box.
*Decisions:* persistent toolchain (node tarball + minimal deps tarball)
+ `setup-fast.sh` one-command recovery; **scoped test suites +
`tsconfig.fastcheck.json` (with playwright/transformers stubs) as the
per-turn gates, full-dependency suites as CI-only.** *Why:* turn speed
was explicitly prioritized; the risk was paid down by keeping the full
gates real, just not per-turn. The bundle was dropped in favor of
patches (the offline path), because a 13k-file bundle in the snapshot
slowed every turn.

## B5 — the allocator (scores, drift, leases)

*Problem:* assigned routing needs a principled picker.
*Decisions:*
- **Score = quality × (0.5+0.5·health) × (0.5+0.5·speed) × breaker.**
  Multipliers, not additive bonuses, so a dead provider can never
  out-score a healthy one on quality alone.
- **Health as Laplace (s+1)/(s+f+2):** no zero-division, and a cold
  model gets 0.5 — benefit of the doubt without trust. Health/speed
  come from the jobs store's OWN task outcomes (the harness grades
  itself), not a separate metrics pipeline that can disagree.
- **Water-filling assignment, provider-diverse:** best-of-A, best-of-B,
  then second-of-A… capped by `max_per_provider`. Provider diversity is
  the reliability story — one vendor's outage is a slowdown, not an
  outage.
- **Judge drift per VERDICT with a 2-failure streak threshold, floor
  0.3, pass resets.** *The scar:* an early version penalized on raw
  float comparisons and produced phantom penalties from rounding noise —
  the 3-decimal rounding requirement is a permanent fixture now.
- **Lease expiry + work-stealing:** a dead worker's task is stolen when
  its lease lapses (`max(300 s, task_timeout+30 s)`); waves can't stall
  on a corpse.
- **Never silently downgrade:** tasks with no surviving candidate fall
  back to the capability alias and LOG it (`assign_fallback_alias`).

## B6 — cost budgets

*Problem:* a job must be stoppable by spend, not just by time.
*Decisions:*
- **Usage only from serving responses** (OpenAI-style objects, both
  stores); unreported usage is never fabricated. Judge/mailbox overhead
  excluded and documented — budgets price the WORK, not the
  bookkeeping.
- **On breach, abort UNSTARTED tasks; in-flight dispatches finish.**
  *Why:* killing a mid-flight dispatch throws away tokens already
  spent — the opposite of a budget.
- **Deferred sweep:** nothing stays queued on a dead job.
- Job ends `failed`/`budget_exhausted` with partial results visible —
  the same deadline semantics, one more reason code. (Verified before
  shipping: the active-status guard means finalize/judge can never
  overwrite the budget failure.)

## B7 — multimodal dispatch

*Problem:* real jobs produce images, audio, music, video, and search —
not just text.
*Decisions:*
- **`modality` field + media TAGS that imply it.** *Why both:* the tag
  is the one-field vocabulary (consistent with everything prior);
  modality makes a literal `/v1/search` dispatch possible on a chat tag
  WITHOUT changing what the `search` tag already meant. Validation
  forces tag/modality consistency so the two can never disagree.
- **Three new tags, no new taxonomy:** the registry subcategories
  (text-to-speech, music-gen, video-gen) already existed — the ranking
  machinery generalized instead of being forked.
- **Result envelopes with caps + digests:** speech audio embeds base64
  only ≤192 KB (sha256 beyond), music/video JSON capped at 2 MB
  (`truncated: true` + digest). *Why:* a job record must not bloat by
  megabytes per task; the digest keeps the result verifiable, and the
  input is on the row so regeneration is deterministic.
- **Media tasks can't answer @ask** (they have no chat model behind
  them) — skipped with a logged reason, not silently dropped.
- **Back-compat by construction:** pre-B7 rows carry no modality and
  resolve by TAG at read time — exactly the historical behavior.

## B8 — cross-cutting hardening (compression, canaries, benchmarks, Guide 2)

*Decisions:*
- **Compression is opt-in** (`compress_context`, default false).
  *Why:* compression trades prose fidelity for tokens; that trade is
  the caller's call, not the harness's. Caveman/lite preserves code
  blocks; failure falls back verbatim (compression must never break a
  dispatch).
- **Canaries are conservative by construction:** no state = no behavior
  change; dead needs 2 consecutive failures; dead verdicts EXPIRE
  (10 min) so a canary outage can never permanently cull a model.
  Probe semantics: ANY HTTP answer (401/403 included) = alive — only
  network-level failures count. No background timer runs uninvited;
  operators drive the cadence.
- **Benchmark wiring via the reserved injection point:** the index
  build never touches the DB — the DB-backed taskFitness stack (user
  override → arena ELO → models.dev tier) is injected as `scoreLookup`
  at the live singleton. Only `coder`/`reasoning` map, and only
  DB-backed sources — the fitness stack's own static table is
  deliberately unmapped (it would launder one set of ballparks into
  another "runtime" label).
- **`model: "auto"` in-pipeline** on the direct chat path, with
  operator combos still winning by exact-name precedence.
- **The guide's "retry once after 20s" became a fork-side opt-in**
  (`retry_503_after_ms`) so the brain can stop timing retries itself.
- Toolchain scar: the deps tarball was repacked with a nested prefix
  and `setup-fast.sh`'s `2>/dev/null` silently linked nothing — the
  script now fails LOUDLY on a broken link. Silent failure is worse
  than the failure.

## B9 — the breaker feed

*Problem:* B5's formula carried `× breaker(0.2 open)` but every caller
passed `false` — a multiplier with no data source.
*Decisions:*
- **Read the REAL registry** — the same provider-keyed breakers the
  chat pipeline consults. Not a second breaker system that could
  disagree with the first.
- **OPEN and HALF_OPEN penalize; DEGRADED does not** (DEGRADED passes
  requests by design; half-open is probing, not proven healthy).
- **Peek, never create:** the feed reads the registry without
  instantiating breakers, so ranking never pollutes the resilience
  dashboards.
- **Persisted-state fallback** for a cold process — a restart doesn't
  forget an open breaker until reality re-trips it.

---

## Process decisions (the meta-journey)

- **Push after every build.** The build sandbox recycles without
  warning; GitHub is the only durable source of truth. Every build
  lands implement → test → gates → commit → push → artifacts in one
  turn.
- **Patches as the offline path** (0001–0016): replayable history
  independent of the live repo.
- **Scoped gates per turn, full gates in CI.** The fastcheck lesson
  cuts both ways: tsc timed out for three builds on a thrashing 2 GB
  box and we honestly marked it "re-verify in CI" — then a fresh box
  ran the SAME program clean in 21 s. The code was never the problem;
  the environment was. Knowing which is which is most of the job.
- **Fixtures tell the truth.** Test literals get patched to match
  reality (B6's usage nulls, B8's control-run comparison), never the
  other way around.
- **Every user-supplied guide is a contract.** Status trackers get
  ticked with build annotations when the fork-side mechanics ship —
  the two live-client-only rows are the only ones still open, and they
  say so.

## B10 — Objective orchestration (the OpenResearch adaptation)

**What shipped**: `/v1/orchestrate/objectives` (objective-first; tags
inferred, never user-chosen), the caller-model bias guard,
`policy.scheduling: "stream"` (per-completion admission), refill
(`POST /jobs/{id}/tasks`), spawn (`POST /v1/orchestrate/spawn` — no
nesting, in-flight cap, brief isolation), and the two wake endpoints
(`wait-first`, multi-job `wait`). Plus the OpenDev-skill guide rewritten
to the new protocol.

**Why these, from their design**: their auto-research loop is built on
per-completion control (wake on first finish, reconcile, refill) — our
waves were barriers, so the loop shape was impossible. Their `agent
spawn` rules (self-contained brief, no nesting, in-flight cap, explicit
compute authorization) translated almost verbatim. Their "the caller
names work" philosophy became tag inference; the "harness picks models"
half is exactly what our alias/allocator stack already does.

**Decisions**:
- Bias guard is a penalty (×0.6 / best-alternative pin), not a ban — a
  single-model deployment must still work, flagged not blocked.
- Stream mode is a parallel scheduler, not a refactor of runWaves: the
  wave path is the shipped B3–B9 surface; both share every building
  block. The first stream test caught a double-count bug (running-state
  ∪ tracked-launches) that would have silently reintroduced the barrier.
- The wait endpoints return the FULL job view — their discipline, verbatim:
  the wake is a signal, the store is the source of truth.
- Embeddings-based routing: deferred (designed seam = classifier stage
  boundaries); it needs an embedding source decision (provider
  /v1/embeddings vs local transformers) — a build of its own.

**Scars**:
- The other session's Build 1 landed with type breaks our fastcheck
  couldn't see (it covers 27 core files + imports — never the harness
  slice). `tsconfig.harness-check.json` now typechecks the whole changed
  surface in ~17s; it immediately caught the missing Required<> policy
  fields, the un-exported TaskType, and the worktree-modality mismatch.
- The jobs `?wait=` long-poll never enforced its documented 60s cap —
  found by reading while writing wait-first. Bounded now.
- `pickBiasAvoidModel` returned a candidate object where every caller
  wanted a string — the test caught it because tsc had aborted on a
  config error (TS6053 missing file) before typechecking. Lesson: a tsc
  run that errors on config checked nothing; always surface config-level
  failures as build-stop.

## B11 — Lenient bias guard + parallel diversity + the two guides

**The user's correction, parsed**: selection basis is category + benchmark
score + provider/model identity; the tag is bookkeeping for parallel
execution ("doesn't call the same model twice"); the bias guard was too
eager — it should yield to benchmark merit. Plus: an agent guide for the
tool and a setup guide for the user (base-project structure, one key).

**What shipped**: `bias_tolerance` (default 0.85) — the guard only breaks
near-ties toward diversity; outside the band the better model wins,
flagged not forced (×0.6 → ×0.8 multiplier, and only inside the band).
Stream mode now honors assigned routing with a run-scoped `usedModels`
set — the literal "never call the same model twice" for parallel tasks,
with exhaustion falling back to reuse. Two guides: the agent-facing
skill (AGENT_TOOL_GUIDE) and the user setup (SETUP_HERMES).

**Decisions**:
- Tolerance gating lives in one pure function (`biasAvoidApplies`) shared
  by the allocator and the alias pin — the leniency can never drift
  between the two routing paths.
- Strict mode (tolerance 0) is preserved as an explicit option, and the
  b10 strict tests pin it — old behavior is a setting, not a deletion.
- usedModels is caller-owned and ADDED-to by the allocator: the stream
  runner owns the run scope, the allocator stays a pure function of its
  inputs.
- The setup guide leans on the base project's own surfaces (dashboard
  Providers, API Manager) — the fork adds routing intelligence, not
  setup steps.

## B12 — The capability registry (the layered router)

**The user's spec, nearly verbatim**: rich per-model descriptors
(capabilities / specializations / benchmarks / operational / reliability /
preferred_for); a two-stage pipeline (hard capability filter 100→17, then
unified ranking 17→3); Hermes gets ALL candidates as PRIMARY/SECONDARY/
FALLBACK with multi-dimensional metadata for contextual judgment; the
router maintains empirical P(success | model, task) instead of trusting
benchmarks (closed loop: result → evaluator → update stats → router); and
the rule that the router cannot select itself unless it wins the SAME
scoring function applied to everyone.

**What shipped**: capabilityRegistry.ts (pure) + the per-category closed
loop on both stores and both assigned-routing paths + /v1/router/candidates
with equal-scoring self-assessment + the agent guide's delegation decision
tree ("Can I do it?" → trivial/specialized/complex/outside, answered by
the registry not by confidence).

**Decisions**:
- Unknown evidence is NEUTRAL (multiplier 1, smoothed 0.75 for empirical)
  — absence of evidence never zeroes a candidate and never promotes one.
- categoryRates are built from every observed (model|category) key, not
  the model's own categories — a vision model with observed code history
  surfaces that history (the first test draft got this wrong; the fix
  removed the model-categorization dependency entirely).
- Equal scoring supersedes nothing: B11's near-tie diversification still
  governs dispatch; B12's rule governs PRESENTATION and self-assessment.
  The caller sees its honest rank; the orchestrator still breaks near-ties
  toward diversity.
- swe_bench counts as code capability (humaneval alone was too narrow).
