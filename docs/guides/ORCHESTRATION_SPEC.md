> **Provenance & status** — this is the operator's authoritative product spec
> ("Guide 1") for the orchestration harness, committed verbatim as the
> reference contract for builds B2+. Cross-reference: `docs/guides/HARNESS.md`
> (B1 surface, shipped @ `056cc85ce`) and the reconciliation section at its
> end, which maps this guide's parts onto the fork's build plan and records
> the vocabulary deltas (guide `plan` ↔ fork `reasoning`; guide
> `/v1/orchestrate/*` lands in B2/B3 on top of B1's `/v1/harness/*`).

# Guide 1 — OmniRoute Fork: Becoming the Orchestration Harness
> Target: your OmniRoute fork (github.com/Ansh-Kar/OmniRoute)
> Goal: the gateway executes what the brain delegates — allocation, parallel fan-out,
> swarms with A2A, judging, recovery — so Hermes never sees model IDs.
> Boundary rule: **the brain decides WHETHER to delegate; the harness decides HOW to execute.**
> The gateway must never decide to spawn sub-agents on its own.

---

## Status Tracker
- [x] Part 1 — Architecture overview & integration points — *honored by B1: aliases and `/v1/harness/task` execute through the existing routing path (`getComboForModel` → native combo machinery), never around it*
- [x] Part 2 — Tag taxonomy (shared contract) — *shipped in B1 @ `056cc85ce` as the finer-grained vocabulary `code | research | math | reasoning | vision | search | chat | image_gen` with benchmark axes; the guide's 6-string Hermes contract is a subset — `plan` joins as an accepted alias at B2 start (see HARNESS.md reconciliation)*
- [x] Part 3 — Jobs store & state machine — *shipped in B3 (orchestrate_jobs/tasks/job_log; queued→running→done|failed, attempts cap, per-transition audit log; expired-lease requeue/work-stealing + A2A remain B3.5)*
- [ ] Part 4 — Allocator (tags → provider-diverse assignment) — *static axis-ranked core shipped in B1 (capability aliases); health × speed × breaker multipliers land with the jobs store (B3) per Part 8*
- [x] Part 5 — Planner (DAG waves) — *shipped in B3 (topological readiness, parallel wave fire with max_concurrency, upstream injection truncated to 800 chars, failed deps block)*
- [ ] Part 6 — Orchestrator API (`/v1/orchestrate/*`) — *`/quick` ✅ B2; `/plan` + `GET /jobs/{id}?wait=` ✅ B3; blackboard + judge endpoints are B3.5*
- [ ] Part 7 — Swarm manager (blackboard + A2A + judge loop) — *B3, builds on the shipped `strategy: "swarm"` combo engine*
- [ ] Part 8 — Scoring integration & telemetry — *drift loop in B3/B5+*
- [ ] Part 9 — Build order & acceptance tests — *followed; step 1 (tags) done*

---

## Part 1 — Architecture overview & integration points

New code lives in one module tree, `orchestrator/`, sitting *above* your existing
routing engine: the orchestrator never calls providers directly — it submits work
through your existing provider/combo layer so all current resilience (breaker,
backoff, adaptive queue, quota tracking) applies unchanged.

```
client (Hermes)
   │  /v1/orchestrate/*
   ▼
┌─ orchestrator/ ─────────────────────────────┐
│ api         HTTP handlers, auth, validation │
│ planner     waves from depends_on           │
│ allocator   tags → ranked provider-diverse  │
│ swarm       blackboard, mailbox, judge loop │
│ jobs        SQLite store, state machine     │
└──────┬──────────────────────────────────────┘
       │ submits single requests (existing path)
       ▼
your routing engine (auto channels, fusion, combos)
       │
       ▼
providers (existing adapters)
```

Integration points in your existing code:
1. **Routing engine entry** — the orchestrator's per-task dispatch calls the same
   internal function your `/v1/chat/completions` handler uses, with a forced
   model + tag context. Do not bypass it.
2. **Tagging system** — allocator reads tags; judge writes benchmark drift back
   (Part 8). One enum, defined once (Part 2).
3. **A2A server** — swarm mailbox reuses your existing A2A transport rather than
   inventing a second one.
4. **Health/quota telemetry** — allocator's score function consumes the same
   signals your 16-factor auto scoring uses.

---

## Part 2 — Tag taxonomy (the shared contract)

One enum, three consumers (tagging, allocator, Hermes skill). Freeze it:

```
vision          understand/OCR/describe images
image_gen       generate/edit images
code            write/debug/explain code
research        fresh web facts / search
plan            deep reasoning, decomposition
chat            everything else (default)
```

Rules:
- Every model in the registry carries `tags: [...]` (multiple allowed) +
  `quality: {tag: 0..1}` + `provider` + `benchmark` (drift-adjusted, Part 8).
- Port the classifier from the sidecar design into your tagging module:
  name patterns → provider metadata (modalities/tools) → one-shot web
  enrichment for unknown IDs, cached per model ID forever (`tags_cache`).
- Hermes's plan contract uses these exact strings. No synonyms anywhere.

---

## Part 3 — Jobs store & state machine

SQLite table (the gateway already depends on SQLite or equivalent):

```sql
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  goal TEXT, mode TEXT,             -- parallel | swarm
  policy TEXT,                      -- JSON
  blackboard TEXT,                  -- JSON snapshot, updated in place
  status TEXT,                      -- active | judging | done | failed
  created_at REAL, deadline REAL
);
CREATE TABLE tasks (
  task_id TEXT, job_id TEXT,
  tag TEXT, prompt TEXT,
  depends_on TEXT,                  -- JSON array
  state TEXT,                       -- see state machine
  assigned_model TEXT, assigned_provider TEXT,
  attempts INT, lease_expires REAL,
  result TEXT, verdict TEXT,        -- judge outcome
  latency_ms REAL,
  PRIMARY KEY (job_id, task_id)
);
```

Task state machine (enforced in one place, `jobs.transition()`):

```
        ┌──────────┐  lease granted   ┌──────────┐   success   ┌────────┐
        │  queued  │ ───────────────► │ running  │ ──────────► │  done  │
        └────┬─────┘                  └────┬─────┘             └────────┘
             │ lease timeout / fail         │ fail
             │ (attempts+1, requeue)        │ attempts >= max
             ▼                              ▼
        ┌──────────┐                  ┌──────────┐
        │  queued  │                  │  failed  │ (visible in job status;
        └──────────┘                  └──────────┘  job may still succeed)
```

Invariants:
- Lease expiry without heartbeat → task returns to `queued` (this is the
  work-stealing mechanism; no separate scheduler pass needed).
- `attempts` capped by `policy.max_attempts` (default 3), then `failed`.
- Job `status` = `judging` while the judge pass runs (swarm mode only).
- Every transition writes a row to a `job_log` table — this is your audit trail
  and your debugging lifeline.

---

## Part 4 — Allocator

`allocator.assign(tasks, tags, policy) -> assignments`

Algorithm (quality-first, provider-diverse water-filling, per task tag):
1. Candidates = models with the tag, `alive`, not breaker-open.
2. Score each: `quality[tag] × health × speed × breaker_penalty` (Part 8).
3. Group by provider, sort each group by score.
4. Round-robin across providers (best of A, best of B, ..., then second of A...)
   until all tasks assigned or candidates exhausted; respect
   `policy.max_per_provider`.
5. If tasks remain unassigned: leave them `queued` with reason recorded —
   never silently downgrade. The planner re-runs allocation each wave, so a
   provider that cools down mid-job picks up the remainder (this replaces the
   sidecar's StealPool; the lease mechanism in Part 3 handles stragglers).

Determinism note: allocation is a pure function of (registry, stats, policy) —
same inputs, same assignment. This makes replays and tests trivial.

---

## Part 5 — Planner

`planner.next_wave(job) -> [tasks]` — topological:

- A task is ready when every `depends_on` is `done` (failed deps block the
  wave; the job surfaces this, it does not guess).
- Ready tasks go through `allocator.assign`, get leased, and dispatch through
  the existing routing path.
- Waves repeat until no ready tasks remain: everything `done` → job `done`;
  ready set empty but tasks incomplete → job `failed` with the blocking
  reasons in `job_log`.
- Each wave injects upstream outputs: for task T with deps, prepend
  `Upstream outputs:\n[dep_id]: <result truncated to 800 chars>` to its prompt.

---

## Part 6 — Orchestrator API

Base: existing server, same auth as `/v1/chat/completions`.
All requests accept optional `Idempotency-Key` header (client-generated UUID);
replays with the same key return the original job/result without re-executing.

### POST /v1/orchestrate/quick
Single delegated task. Synchronous.
```json
// request
{"tag": "vision", "prompt": "describe this image",
 "images": ["<url or base64>"], "policy": {"budget": "cheap|any|best"}}
// response 200
{"ok": true, "model": "provider/model-id", "provider": "provider",
 "text": "...", "latency_ms": 812, "score": 0.91,
 "decision": { ...your X-OmniRoute-Decision fields... }}
// response 503
{"ok": false, "error": "no_active_models", "tag": "vision"}
```
`budget` maps to a quality floor filter (`cheap` → cost class free/cheap only).

### POST /v1/orchestrate/plan
Batch or swarm. Asynchronous.
```json
{
  "goal": "4-page comic, consistent characters",
  "mode": "parallel",                    // or "swarm"
  "tasks": [
    {"id": "t1", "tag": "image_gen", "prompt": "...", "depends_on": []},
    {"id": "t2", "tag": "image_gen", "prompt": "...", "depends_on": ["t1"]}
  ],
  "blackboard": {"canon": "hero=Ravi, red scarf", "_locked": ["canon"]},
  "policy": {"max_per_provider": 4, "max_attempts": 3,
             "deadline_s": 600, "max_rounds": 3}
}
// response 202
{"job_id": "job_01J...", "status": "active", "accepted": 2}
```
Admission validation (replaces `validate_plan.py`): unknown tags, duplicate ids,
dangling depends_on, empty tasks → `400` with per-task errors. The Hermes skill
feeds these back to the brain for one corrected re-emission.

### GET /v1/orchestrate/jobs/{job_id}
```json
{"job_id": "...", "status": "active|judging|done|failed",
 "waves": [{"n": 1, "tasks": ["t1"]}],
 "tasks": [{"id": "t1", "state": "done", "model": "a/x", "latency_ms": 1200,
            "attempts": 1, "verdict": null}]}
```
Poll interval guidance: 2s, backoff to 5s after 30s. Also supports
`?wait=30` long-poll to cut chatter.

### GET /v1/orchestrate/jobs/{job_id}/blackboard
Current snapshot + history of appends (who wrote what).

### POST /v1/orchestrate/jobs/{job_id}/judge
Trigger or advance the consistency pass (swarm mode). Body:
```json
{"kind": "consistency", "spec_key": "canon",
 "check": "Do all outputs match the locked canon? List violations per task."}
```
Runs on the `vision` tag for image outputs, `plan` tag otherwise. Verdicts are
written to `tasks.verdict`; failed tasks are re-queued with the verdict injected
into their prompt, up to `policy.max_rounds`.

### Error codes
| code | meaning | client behavior |
|---|---|---|
| 400 | malformed plan | feed errors to brain, re-emit once |
| 404 | unknown job/tag | brain falls back to self-execution |
| 409 | idempotency replay mismatch | client bug; log it |
| 503 | no active models for tag | brain: retry later or escalate tag |
| 504 | job deadline exceeded | brain: partial results + honest note |

---

## Part 7 — Swarm manager

Activated only by `mode: "swarm"`:

1. **Prompt assembly** — each worker task's prompt is wrapped:
   ```
   <shared context>
   {blackboard snapshot, locked keys marked LOCKED}
   You are part i of n. Other parts: [...]. Read the blackboard; match
   established conventions. When done, your output must include a summary
   block (≤15 lines) for the blackboard.
   </shared context>
   {original task prompt}
   ```
2. **Blackboard** — store is the `jobs.blackboard` JSON. Workers "append" via
   the harness parsing the summary block from their result; direct writes are
   not exposed. Locked keys (`_locked`) can only change via the client (brain).
3. **Mailbox (A2A)** — reuse your A2A server: worker i may send a bounded
   question to worker j (`page3 → page2`). Harness enforces: one in-flight
   question per worker, 30s timeout, unanswered → worker proceeds with a note.
   Conversation never exceeds the wave: mailboxes are per-wave, per-job.
4. **Judge loop** — after final wave, run the judge (Part 6). Failed tasks
   re-queue with verdicts injected. `max_rounds` hard-stops refinement; round
   3 output is accepted with flaws recorded in `job_log`.
5. **Why not free-form A2A chat:** context drift, token burn, unbounded loops —
   the three failure modes from your research. Blackboard summaries + bounded
   mailbox + hard round cap avoid all three while keeping team coordination.

---

## Part 8 — Scoring integration & telemetry

Score function (one place, `allocator.score(model, tag)`):
```
score = quality[tag]                      # from tagging (static prior)
        × (0.5 + 0.5 × health)            # smoothed success rate
        × (0.5 + 0.5 × speed)             # decay vs latency EWMA
        × breaker_penalty                 # 0.2 when breaker open
```
Feed `health`/`speed` from your existing telemetry rather than a parallel
system. Judge verdicts write back: two consecutive failed verdicts on a model
for a tag → `benchmark -= 0.05` (floor 0.3), logged. This is the drift loop.

Telemetry: every orchestrated task emits your decision header plus
`X-OmniRoute-Job`, `X-OmniRoute-Task`, `X-OmniRoute-Wave` — one trace id ties a
Telegram reply to every sub-call that built it.

---

## Part 9 — Build order & acceptance tests

1. **Tag taxonomy + tagging port** — acceptance: `GET /v1/models` on the fork
   shows tags for every model; unknown-ID enrichment runs once, cached.
2. **Jobs store + state machine** — unit tests: lease expiry requeues;
   attempts cap fails; cycle detection returns `failed` with reason.
3. **`/quick`** — acceptance: `curl` a vision and a code tag; responses include
   model/score/decision; kill a provider mid-test → next call reroutes.
4. **Planner + allocator (`mode: parallel`)** — acceptance: 6-image plan
   finishes with ≥2 providers represented; kill provider A at wave 1 → its
   remaining tasks land on B without job failure.
5. **Swarm + judge** — acceptance: comic job with deliberately inconsistent
   page 3 → judge flags exactly page 3 → regenerated → final verdict clean;
   blackboard shows who wrote what.
6. **Deadline + idempotency** — acceptance: deadline exceeded returns partial
   results + status `failed(deadline)`; same Idempotency-Key replays return
   identical job_id with no duplicate provider calls.

When all six pass, the `:20129` sidecar is decommissioned and Hermes points at
the fork directly (Guide 2, Part 2).
