# Using the harness — endpoint syntax

The fork serves everything under `/v1/*` (rewritten internally to
`/api/v1/*` — both forms work). The examples use the brain's default
`http://localhost:20128`. Every endpoint takes the gateway's normal auth
(Bearer key) and honors per-key policies.

The one rule that shapes everything: **callers name capabilities, never
model ids.** Models are ranked, picked, failed over, and re-picked by the
harness.

---

## 1. Direct conversation — `model: "auto"`

The brain's config.yaml default. A bare `model: "auto"` on the normal
chat endpoint classifies the conversation and routes it to the right
capability alias in-pipeline:

```bash
curl -s http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model": "auto",
       "messages": [{"role": "user", "content": "refactor this failing test"}]}'
# → routed as a `code` request; the response is a normal chat completion.
```

Capability aliases also work directly as model ids — with optional budget
tiers:

| model id | meaning |
|---|---|
| `code`, `chat`, `vision`, `reasoning`, `math`, `research`, `plan`, `search` | best current specialists for that capability (axis-ranked) |
| `code:best`, `chat:best`, … | top-3 quality tier |
| `code:cheap`, `chat:cheap`, … | fast/cheap tier (flash/mini-class models) |
| `hermes/fast` | `chat:cheap` (stable client pin) |
| `hermes/smart` | `chat:best` |
| `hermes/code`, `hermes/vision`, … | capability equivalents of the namespace |

## 2. One-shot delegation — `POST /v1/orchestrate/quick`

Single synchronous task, guide-shaped answer. Everything the worker
needs must be in `prompt` (workers do not see the caller's conversation).

```bash
curl -s http://localhost:20128/v1/orchestrate/quick \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ea1b-4c3f-9d2a-77b6f1c2e3d4" \
  -d '{"tag": "vision",
       "prompt": "describe this image",
       "images": ["data:image/png;base64,..."],
       "policy": {"budget": "any"}}'
```

- `tag` — capability vocabulary (see §3).
- `policy.budget` — `any` (default) | `best` | `cheap`.
- `policy.retry_503_after_ms` — 0–120000, default 0. Guide 2's "on 503,
  retry once after 20s" made fork-side: when the tag's candidates
  exhaust, wait and retry ONCE before the honest 503.

Responses:

```json
{"ok": true, "model": "openai/gpt-5.6", "provider": "openai",
 "text": "…", "latency_ms": 812, "score": 0.91, "decision": {…},
 "retried": true}                                        // 200 (retried only when a retry happened)

{"ok": false, "error": "no_active_models", "tag": "vision", "retried": true}   // 503
```

`Idempotency-Key` replays return the original result without
re-executing (native pipeline semantics, forwarded by /quick).

## 3. Decomposition — `POST /v1/orchestrate/plan`

Submit a plan of tagged, dependency-ordered tasks; returns 202
immediately and executes as parallel waves in the background.

```bash
curl -s http://localhost:20128/v1/orchestrate/plan \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3d1c…" \
  -d '{
    "goal": "4-page comic about Ravi",
    "mode": "swarm",
    "tasks": [
      {"id": "script", "tag": "chat",   "prompt": "write the script",        "depends_on": []},
      {"id": "art",    "tag": "image_gen", "prompt": "draw page 1",          "depends_on": ["script"]},
      {"id": "refs",   "tag": "research", "modality": "search",
       "prompt": "find reference art styles for Indian webcomics",           "depends_on": []}
    ],
    "blackboard": {"canon": "hero=Ravi, red scarf", "_locked": ["canon"]},
    "policy": {"routing": "assigned", "max_total_tokens": 150000,
               "compress_context": true}
  }'
# → 202 {"ok": true, "job_id": "job_m1x…", "status": "active", "accepted": 3}
```

**Tag vocabulary** (what the harness knows how to rank):
`code` · `research` · `math` · `reasoning` · `plan` · `vision` ·
`search` · `chat` · `image_gen` · `audio_speech` · `music_gen` ·
`video_gen`

**Modality** (B7) — which endpoint family executes the task:
`text` (default) · `image` · `search` · `speech` · `music` · `video`.
Media tags imply theirs (`image_gen`→image, `audio_speech`→speech,
`music_gen`→music, `video_gen`→video). `modality: "search"` on any chat
tag dispatches literally to `/v1/search` (web search, no model). Media
results land on the task row as JSON envelopes
(`{images|search|speech|music|video: …}`).

**Policy fields:**

| field | range / values | default | notes |
|---|---|---|---|
| `budget` | any \| best \| cheap | any | quality tier |
| `max_attempts` | 1–5 | 3 | per-task retries |
| `max_concurrency` | 1–16 | 8 | wave parallelism |
| `deadline_s` | 1–86400 | 600 | partials stay visible on breach |
| `task_timeout_ms` | 1000–600000 | 120000 | per dispatch |
| `routing` | alias \| assigned | alias | assigned = allocator water-filling (B5) |
| `max_per_provider` | 1–16 | 3 | assigned routing, provider spread |
| `max_total_tokens` | 0–1e9 | 0 | 0 = unlimited; on breach unstarted tasks abort, job fails `budget_exhausted` (B6) |
| `judge` | bool | true | swarm mode: run the judge loop |
| `max_rounds` | 1–5 | 3 | judge refinement cap, then flaws are accepted |
| `compress_context` | bool | false | Caveman compression of the swarm shared context before fan-out (B8) |

## 4. Polling — `GET /v1/orchestrate/jobs/{id}?wait=30`

`?wait=` long-polls (500 ms ticks, capped at 60 s). The job shape:

```json
{
  "job_id": "job_m1x…", "status": "done", "goal": "…", "mode": "swarm",
  "failure_reason": null, "judge_rounds": 1,
  "blackboard": {"canon": "…", "summaries": {"script": "…"}, "mailbox": {}},
  "usage": {"prompt_tokens": 12040, "completion_tokens": 3311,
            "total_tokens": 15351, "budget_tokens": 150000},
  "waves": [{"n": 1, "tasks": ["script", "refs"]}, {"n": 2, "tasks": ["art"]}],
  "tasks": [
    {"id": "art", "tag": "image_gen", "modality": "image", "state": "done",
     "depends_on": ["script"], "model": "openai/gpt-image-2", "provider": "openai",
     "wave": 2, "attempts": 1, "latency_ms": 8420,
     "prompt_tokens": 24, "completion_tokens": null,
     "verdict": "pass", "error": null,
     "result": "{\"images\": […]}"}
  ],
  "log": [ /* last 100 audit events: task_start, task_done, task_requeued,
              task_assigned, assign_fallback_alias, lease_expired,
              context_compressed, task_budget_aborted, job_budget_exhausted,
              blackboard_append, mailbox_relayed, mailbox_skipped,
              judge_start, judge_verdicts, model_drift_penalty, job_done … */ ]
}
```

`status`: `active` → `judging` (swarm) → `done` | `failed`.
`failure_reason`: `deadline` | `blocked` | `budget_exhausted` —
in every case completed work stays visible; nothing is fabricated.

## 5. Classify / forced-route — `POST /v1/harness/task`

The single-call Layer 3 endpoint (classify + route + execute):

```bash
curl -s "http://localhost:20128/v1/harness/task" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [...], "tools": [...]}'

# variants:
#   ?alias=code           forced route, no classification
#   ?classify_only=true   decision only, no execution
#   ?tier=auto            complexity picks the budget (fast→cheap, deep→best)
```

## 6. Allocator query — `GET /v1/models/best?task=code&limit=6`

The ranking the harness itself uses, as a read-only query
(`?task=` classifier vocabulary or `?category=` raw + optional
`?axis=`, `?minBenchmark=`).

## 7. Liveness canaries — `GET /v1/models/canaries`, `POST /v1/models/canaries/check`

```bash
# snapshot: per-model {alive, lastCheckAt, latencyMs, consecutiveFailures,
# lastError}, config, and the current dead list rankings skip
curl -s http://localhost:20128/v1/models/canaries -H "Authorization: Bearer $KEY"

# run one probe round now (reachability: any HTTP answer = alive;
# ?limit=12 rotates provider coverage)
curl -X POST "http://localhost:20128/v1/models/canaries/check?limit=12" \
  -H "Authorization: Bearer $KEY"
```

## 8. Trace headers

Every orchestrator-originated upstream call carries
`X-OmniRoute-Job`, `X-OmniRoute-Task`, `X-OmniRoute-Wave` (and
`X-Harness-Route` on /harness/task) — admin logs can explain every
sub-call; user replies never name models, routes, or providers.

## 9. Task states & failure semantics (recap)

- Task: `queued → running → done | failed`; failures under
  `max_attempts` requeue; at the cap the task fails and the job
  CONTINUES (a job may succeed with failed tasks — the response's
  `failure_reason` says how many).
- A task is READY when every `depends_on` is `done`; failed deps BLOCK
  dependents (job fails `blocked` with reasons on each task).
- `deadline_s` breach: remaining tasks stay queued, job fails
  `deadline`, completed work visible.
- `max_total_tokens` breach: unstarted tasks abort
  (`task_budget_aborted`), in-flight dispatches finish, job fails
  `budget_exhausted`.
