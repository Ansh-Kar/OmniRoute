# The Gateway Tool — an Agent's Guide (SKILL)

> **Load this before orchestrating sub-agents.** You (the calling agent —
> Hermes, or any brain) never pick models and never pick tags. You name
> work; the gateway picks models on category + benchmark scores + provider
> identity, keeps parallel calls on distinct models, and avoids routing
> your work back to your own model on near-ties. This guide is the whole
> tool surface.

---

## 0. The contract in one paragraph

One endpoint, every provider. Selection is the gateway's job: your task's
**category** (code, research, math, reasoning, plan, vision, search, chat,
image_gen, audio_speech, music_gen, video_gen) is inferred from the prompt
itself, **benchmark scores** rank the candidates, and **provider/model
identity** spreads parallel work (never the same model twice while
alternatives remain — that is what task tracking is for). You may pass a
tag to override the category when you know better; you may NEVER name a
model. If you run on a model yourself (`caller_model`), the gateway uses
it only as a **lenient** anti-bias signal: on a near-tie it routes the
sub-agent elsewhere; if your model is clearly the best by benchmark, it
wins on merit and the task is flagged `bias_same_model` — visible, never
hidden, never forced onto a worse model.

---

## 1. The tool surface

| Endpoint | Use it for |
|---|---|
| `POST /v1/orchestrate/objectives` | **Your default.** Submit an objective (with or without subtasks). Returns a job. |
| `POST /v1/orchestrate/quick` | One small synchronous task, answer in the response. |
| `GET /v1/orchestrate/jobs/{id}/wait-first?timeout=30` | Sleep until the FIRST task completes. Your loop tick. |
| `GET /v1/orchestrate/jobs/{id}?wait=30` | Full job view (the source of truth). |
| `POST /v1/orchestrate/jobs/{id}/tasks` | Refill: append tasks to a RUNNING job. |
| `POST /v1/orchestrate/spawn` | Delegate a self-contained task to a helper job. |
| `GET /v1/orchestrate/wait?job_ids=a,b&timeout=30` | Wake when ANY of several jobs completes. |
| `POST /v1/harness/classify` | Ask what the gateway would route a prompt as (debugging). |
| `GET/POST /v1/router/candidates` | **Self-assessment.** Who can serve this task — including YOU, ranked by the identical score. |
| `GET /v1/models/best?task=code&limit=6` | See the ranked candidates for a category (never required). |

## 2. Submit an objective

```json
POST /v1/orchestrate/objectives
{
  "objective": "Build and verify a JWT auth module",
  "caller_model": "<the model YOU run on>",
  "subtasks": [
    { "prompt": "Write the token issuer in typescript" },
    { "prompt": "Write integration tests for the issuer", "depends_on": ["t1"] }
  ],
  "policy": { "scheduling": "stream", "max_rounds": 3 }
}
→ 202 { "job_id": "job_…", "inferred_tags": { "t1": "code" }, … }
```

Rules:
- **subtasks optional** — a bare objective runs as a single task. Decompose
  when the work genuinely parallelizes; don't manufacture a plan.
- **tags optional** — inferred from each prompt (`inferred_tags` in the
  response, `tag_inferred` in the log). Pass one only when the prompt's
  phrasing would mislead the inference (e.g. a code task written as prose).
- **caller_model** — name yourself. It enables the lenient bias guard and
  propagates to your spawned helpers.
- Policy you may set: `scheduling: "stream"` (per-completion; recommended
  for parallel work) or `"wave"` (barrier batches, default), `deadline_s`,
  `max_concurrency`, `max_total_tokens`, `max_rounds` (judge refinement
  cap), `bias_tolerance` (0–1, default 0.85 — how close two models must be
  before the guard diversifies away from your model; 0 = always avoid).

## 3. Drive the per-completion loop

```
loop:
  GET /v1/orchestrate/jobs/<jobId>/wait-first?timeout=30
  #   → wakes on the FIRST task completion since the call started.
  # The wake is a SIGNAL, not the source of truth:
  #   - re-read the FULL task list in the response every wake
  #   - act on every newly-terminal task (completed_since), not just the one
  #     that woke you — a task that finished while you analyzed the last
  #     one will NOT appear in the next completed_since
  # For each completed task: READ its result, then decide —
  #   - more work of this kind? POST /jobs/<id>/tasks to refill the slot
  #   - done? stop launching
  # re-issue wait-first each tick; exit when "drained": true
```

Do NOT tight-poll. Do NOT wait-for-all when you could act per completion —
under `stream` scheduling a freed slot refills the moment you append.

## 4. Delegate (spawn)

Spawn a helper for work with a **clean boundary** (surveying, write-ups,
independent exploration) — never for a step of the loop you're driving.

```json
POST /v1/orchestrate/spawn
{
  "parent_job_id": "job_…",
  "brief": "Survey the auth codebase and report the current token flow.
            Read-only: launch no runs. Output: a 10-line summary.",
  "caller_model": "<your model>"
}
→ 202 { "job_id": "job_…", "parent_job_id": "job_…", "in_flight": 1, "cap": 4 }
```

- The brief must be **self-contained**: the helper sees NOTHING of your
  conversation, tasks, or results — only the brief (plus any `context`
  object you copy in explicitly). Include constraints, allowed compute,
  expected output, definition of done.
- A helper **cannot spawn** (409 `spawn_nesting`). At most `max_children`
  helpers in flight (429 `spawn_cap`) — wait for one to finish.
- Wake on any helper: `GET /v1/orchestrate/wait?job_ids=a,b&timeout=30` →
  `{woken, job, states, drained}`. Same discipline: the states map is the
  source of truth; `drained: true` is your exit.

## 5. One small task (quick)

```json
POST /v1/orchestrate/quick
{ "tag": "search", "prompt": "current stable version of node?", "policy": { "budget": "cheap" } }
→ { "ok": true, "text": "…", "latency_ms": 812 }
```
Synchronous, one capability. Use for lookups and single questions — not
for anything you'll parallelize.

## 6. Failure semantics (never guess around these)

- Task states: `queued → running → done | failed`. A failed task under
  `max_attempts` requeues automatically — don't resubmit it.
- Job failures: `deadline` (time out — partial results remain readable),
  `blocked` (a dependency failed; the reasons are on each task),
  `budget_exhausted` (token budget hit; unstarted tasks aborted).
- A job may be `done` with failed tasks — `failure_reason` says how many.
  Read the task rows, not just the status.
- Unknown job id (404): the job is gone or expired — resubmit the work.

## 7. "Can I do it myself?" — the delegation decision tree

Before doing any task yourself, ask the registry — not your own confidence:

```
Can I do it?
  ├── trivial (one short reply, no lookup)        → do it
  ├── within capability but specialized           → compare external
  │     (router/candidates: your rank vs PRIMARY)    specialists
  ├── complex / long / parallelizable             → delegate / swarm
  └── outside capability (vision? OCR? media?)    → delegate, always
```

`POST /v1/router/candidates` with `caller_model` names yourself and returns
your rank under the SAME scoring function every other model is scored by —
`would_win: true` means doing it yourself is genuinely the best route;
`status: "filtered"` means you can't serve it at all. You also get
PRIMARY/SECONDARY/FALLBACK tiers with EVERY filtered candidate and its
dimensions (specializations, benchmarks, reliability, cost, latency), so
contextual judgment is yours: if the image is a UI screenshot, prefer the
model whose `ui_understanding` is high even when it's SECONDARY.

The routing engine knows whether a model is "better than you" — you don't
have to. Use it.

## 8. Anti-patterns

- **Naming a model.** Never. If you find yourself wanting a specific model,
  name the CATEGORY and let the benchmarks decide.
- **Tagging everything.** Tags are inferred; pass one only to correct a
  misread.
- **Tight polling.** `wait-first` exists so you sleep until signal.
- **Waiting for all before thinking.** Act per completion.
- **Spawning from a helper.** Refused by design — do the work or wait.
- **Resubmitting failed tasks.** The runner already retries to
  `max_attempts`; resubmission duplicates work. Append NEW tasks instead.
