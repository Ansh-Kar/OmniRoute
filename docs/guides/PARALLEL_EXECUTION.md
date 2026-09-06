# Parallel Execution Guide

> Fork feature: run **multiple models from multiple providers simultaneously**,
> pick them by **what they are good at** (category + benchmark), and tune the
> gateway so concurrent agent traffic stops tripping its own admission gate.

This guide covers the four pieces of the fork's parallel-execution story:

1. **Model tagging** — every catalog model carries provider, category and
   benchmark tags, retrievable via `GET /api/models/tags`.
2. **Tag-driven fusion panels** — a fusion combo whose panel is _resolved at
   dispatch time_ from those tags (`config.panelFromTags`), fanning one prompt
   out to distinct models across distinct providers in parallel, with a judge
   synthesizing the final answer.
3. **Agent swarms** — the `swarm` combo strategy: assign N **different tasks**
   in one call, each executed by its own specialist model (explicit or
   tag-picked) **in parallel** — the one-call multi-task fan-out.
4. **Admission + transport tuning** — the deployment profile that lets
   "main agent + concurrent subagents" traffic actually reach the providers
   instead of 503ing at OmniRoute's own front door.

---

## 1. Model tagging and retrieval

The tag index (`open-sse/services/modelTags`) tags 3300+ models from the chat
provider registry and every media registry (image, audio, video, rerank,
embedding, OCR, search, moderation, music, upscale):

| Tag                                      | Meaning                                              |
| ---------------------------------------- | ---------------------------------------------------- |
| `chat`                                   | Conversational base category                         |
| `coder`                                  | Coding-specialized (id patterns like `-code`, codex) |
| `reasoning`                              | Reasoning/thinking-capable (registry flag or id)     |
| `vision`                                 | Image understanding (registry flag or id)            |
| `image-gen`                              | Image generation models                              |
| `image-edit`                             | Image-to-image / inpainting capable                  |
| `video-gen`                              | Video generation                                     |
| `speech-to-text`                         | Transcription (e.g. whisper family)                  |
| `text-to-speech`                         | TTS                                                  |
| `music-gen`                              | Music generation                                     |
| `embedding`                              | Embedding models                                     |
| `rerank`                                 | Rerankers                                            |
| `ocr`, `search`, `moderation`, `upscale` | Utility modalities                                   |

Each entry also carries capability fields (`tools`, `vision`, `reasoning`,
`contextLength`) and — when known — a **benchmark** score (0–100). Scores come
from a small curated seed table of versioned flagship ids; an unknown model
simply has _no_ score ("no evidence", never a made-up number). Runtime layers
can override seeds via the `scoreLookup` hook (e.g. wiring in the arena/taskFitness
stack).

### Querying

```bash
# Top coder models, at least benchmark 80, one per provider
curl "http://localhost:20128/api/models/tags?category=coder&minBenchmark=80&diverse=true&distinct=true"

# Vision models that support tools, from two specific providers
curl "http://localhost:20128/api/models/tags?category=vision&requireTools=true&providers=anthropic,openai"

# Preview the exact fusion panel a combo would resolve
curl "http://localhost:20128/api/models/tags?panel=true&category=chat&size=4&minBenchmark=85"
```

Retrieval semantics worth knowing:

- `distinct=true` collapses relay duplicates — the same model offered by 20
  provider keys is represented once, by its most canonical (first-party)
  provider.
- `diverse=true` round-robins across providers instead of pure score order.
- `minBenchmark>0` filters out unscored models entirely.

## 2. Parallel fusion panels (`panelFromTags`)

OmniRoute's **fusion** strategy fans a prompt out to a panel of models **in
parallel** and a judge model synthesizes one final answer (quorum-grace
collection, anonymized sources). Upstream, the panel is a hand-maintained
model list — this fork lets the panel be **resolved from tags at dispatch
time**, so it tracks the catalog instead of rotting:

```json
{
  "name": "parallel-coders",
  "strategy": "fusion",
  "models": [],
  "config": {
    "panelFromTags": {
      "category": "coder",
      "size": 4,
      "minBenchmark": 80,
      "perProvider": 1,
      "requireTools": true
    },
    "judgeModel": "openai/gpt-5.6",
    "fusionTuning": { "minPanel": 2, "stragglerGraceMs": 8000 }
  }
}
```

Fields:

| Field                            | Default | Meaning                                                                  |
| -------------------------------- | ------- | ------------------------------------------------------------------------ |
| `category`                       | —       | Required. Any tag from the vocabulary above.                             |
| `size`                           | `4`     | Panel size, clamped to `[2, 40]` (the fusion `maxPanel` heap guard).     |
| `minBenchmark`                   | `0`     | Quality floor; unscored models never pass a floor > 0.                   |
| `perProvider`                    | `1`     | **Hard** cap on models per provider. `1` = the multi-provider guarantee. |
| `providers`                      | all     | Provider allowlist.                                                      |
| `excludeProviders`               | none    | Provider blocklist.                                                      |
| `requireTools` / `requireVision` | off     | Capability floor for every panel member.                                 |

Behavioral guarantees:

- **Distinct models from distinct providers** — `perProvider: 1` means a panel
  of 4 needs 4 distinct providers; a category with fewer yields a smaller panel
  (logged + `truncated`) rather than same-vendor padding.
- **Graceful fallback** — a malformed spec, or a spec that matches no models,
  logs a warning and falls back to the combo's literal `models` list. Combos
  carrying both use `models` as the fallback. Pre-fork combos are unaffected.
- Everything downstream of panel resolution is upstream machinery: hidden-model
  filtering, vision-compatibility filtering for image-bearing requests,
  connection-aware expansion, judge vision checks, quorum-grace collection.

The panel re-resolves on **every dispatch** — when a vendor ships a better
model or you add a provider connection, the panel picks it up without touching
the combo.

### Ready-made examples

See `examples/fusion-parallel/` for combos covering the common categories
(coder, vision, chat, reasoning) and an import script.

## 3. Agent swarms (`swarm` strategy)

Fusion runs **one** prompt through a panel; pipeline runs **different** prompts
**sequentially**. The `swarm` strategy covers the third shape — the agent
swarm: submit **several different tasks in a single call** and OmniRoute picks
a specialist for each, runs them all **in parallel**, and returns labeled
per-task results (or one synthesized answer). Paired with an agent client
(Hermes, Claude Code with subagents, …), one request fans out into a working
swarm of different models from different providers.

```json
{
  "name": "product-launch-swarm",
  "strategy": "swarm",
  "models": [],
  "config": {
    "swarm": {
      "tasks": [
        { "label": "strategy", "task": "Draft the go-to-market strategy.", "fromTags": { "category": "reasoning", "minBenchmark": 85 } },
        { "label": "copy",     "task": "Write the launch landing-page copy.", "model": "anthropic/claude-opus-4.6" },
        { "label": "art",      "task": "Describe the hero illustration.", "fromTags": { "category": "vision", "requireVision": true } },
        { "label": "audit",    "task": "Red-team the pricing page copy.", "fromTags": { "category": "reasoning", "excludeProviders": ["example-flaky"] } }
      ],
      "defaultModel": "openai/gpt-5.6",
      "maxConcurrency": 8
    }
  }
}
```

Each task carries its own instruction and its own worker:

| Task field   | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `label`      | Display label used in the result (defaults to `task-1`, `task-2`, …).      |
| `task`       | Required. The instruction, injected as the worker's leading system turn.   |
| `model`      | Explicit worker `"provider/model"`. Wins over `fromTags`.                  |
| `fromTags`   | Tag-resolved worker — same selectors as `panelFromTags` (`category`,       |
|              | `minBenchmark`, `providers`, `excludeProviders`, `requireTools`,            |
|              | `requireVision`), resolved at dispatch time.                                |

Run-level fields:

| Field           | Default    | Meaning                                                        |
| --------------- | ---------- | -------------------------------------------------------------- |
| `defaultModel`  | —          | Fallback worker for tasks with neither `model` nor a matching  |
|                 |            | `fromTags` spec.                                               |
| `maxConcurrency`| `8`        | Parallel workers (bounded pool; hard cap 40 = `maxTasks`).     |
| `synthesize`    | `false`    | Merge task outputs into one answer via `judgeModel` instead of |
|                 |            | returning labeled sections.                                    |
| `judgeModel`    | first worker | The synthesizer when `synthesize` is on.                      |
| `resultFormat`  | `sections` | `sections` (labeled markdown) or `json` (structured records).  |

Behavioral guarantees:

- **Cross-task diversity** — tag resolution skips models already claimed by an
  earlier task while alternatives exist, so identical specs still yield
  different models from different providers.
- **Chat-shaped tasks** — workers get the request body (vision input fine) with
  the task instruction prepended, `tools` stripped and streaming forced off,
  exactly like a fusion panel member. Media endpoints (image/audio/video
  generation) are out of scope for tasks.
- **Per-task isolation** — a failed, timed-out (120 s), or admission-rejected
  (`chat_admission_busy`) task is reported as a failed section; the rest of
  the run completes. Only total failure returns 503 (with per-task reasons).
- **Heap guard (#1905)** — more than 40 tasks is refused before fan-out.
- **Tool-bearing requests** — without `synthesize`, a request carrying `tools`
  bypasses the fan-out and routes directly to the judge (or first task's
  model) with tools intact, mirroring fusion's #6771 discipline; with
  `synthesize`, the swarm runs and the judge answers with the client's tools.

Response shapes:

- `resultFormat: "sections"` (default) — a synthetic OpenAI-style
  `chat.completion` whose content is labeled markdown (`## label — model`).
  Because this response is synthesized after protocol translation it is always
  OpenAI-chat-shaped and non-streaming: OpenAI-compatible clients are fine;
  native-format or streaming clients should use `synthesize`.
- `resultFormat: "json"` — same envelope, content is a JSON document
  (`{object: "swarm_run", okCount, total, results[]}`).
- `synthesize: true` — a real model call on the original request (streaming
  and tools preserved, full protocol fidelity) that merges the labeled
  outputs into one coherent answer.

### Per-request swarms (`body.swarm`)

The task list can be supplied — or overridden — per request, so a single swarm
combo serves any ad-hoc workload an agent wants to fan out:

```json
{
  "model": "product-launch-swarm",
  "messages": [{ "role": "user", "content": "Launch our new debugger." }],
  "swarm": {
    "tasks": [
      { "label": "api", "task": "Draft the public API reference outline.", "fromTags": { "category": "coder", "minBenchmark": 80 } },
      { "label": "docs", "task": "Write the quickstart tutorial.", "model": "openai/gpt-5.6" }
    ],
    "synthesize": true
  }
}
```

`body.swarm` accepts every run-level field (`tasks`, `synthesize`,
`judgeModel`, `defaultModel`, `maxConcurrency`, `resultFormat`) and takes
priority over the combo's stored `config.swarm`. The field is stripped before
workers are dispatched, so it never leaks to a provider. A swarm combo with no
`config.swarm` tasks can also define its tasks as `models` steps carrying a
per-step `prompt` — the pipeline shape, executed in parallel.

### Ready-made examples

See `examples/swarm/` for ready-to-import swarm combos and an import script.

## 4. Admission and transport tuning

When several agents (or one agent with parallel subagents, or fusion panels)
hit OmniRoute at once, two internal gates can throttle you before any provider
rate limit does:

### `chat_admission_busy` (503)

Heavyweight chat requests (large bodies, many messages/tools) contend for
bounded admission capacity. Symptoms and mechanics: see
`docs/guides/TROUBLESHOOTING.md` → _"Chat requests fail with 503 /
chat_admission_busy"_ and issue [#9012](https://github.com/diegosouzapw/OmniRoute/issues/9012).

The fork ships this profile (active in `.env.example` and `docker-compose.yml`):

```bash
OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT=4        # match your active agent count
OMNIROUTE_CHAT_ADMISSION_QUEUE_MS=5000      # drain bursts server-side
OMNIROUTE_CHAT_ADMISSION_MAX_QUEUED_BYTES=16777216  # 16 MB parked-body budget
```

Guidance:

- Set `MAX_HEAVY_IN_FLIGHT` to your **active agent count** (main + subagents).
  The auto-derived byte budget and the heap-pressure shed (0.75 ratio) stay in
  force underneath — this is a bounded count profile, not "use the host".
  Raising it costs heap residency for each request's whole lifetime.
- Prefer widening `QUEUE_MS` over raising the count when bursts are short:
  waiting costs latency, not memory.
- Monitor `chatAdmission.*` at `/api/monitoring/health` when tuning.

### Proxy dispatcher concurrency (transport)

PR [#4288](https://github.com/diegosouzapw/OmniRoute/pull/4288) (merged in the
v3.8.30 base of this fork) replaced the single shared upstream socket of a
cached HTTP/SOCKS proxy dispatcher with a concurrent-tunnel pool
(`OMNIROUTE_PROXY_DISPATCHER_CONNECTIONS`, default 32, cap 256). The fork bumps
the deployment default to **64**: a fusion panel of 4–8 models × several agents,
all sharing one account-level proxy over long-lived SSE streams, can exceed 32
concurrent tunnels and serialize behind the pool.

```bash
OMNIROUTE_PROXY_DISPATCHER_CONNECTIONS=64
```

## 5. Putting it together

A parallel coding-agent setup:

1. `.env` from this fork's `.env.example` — admission + transport already tuned.
2. Import the example combos: `bash examples/fusion-parallel/import.sh`
   (panels) and/or `bash examples/swarm/import.sh` (swarms).
3. Point your agents at the fusion combo (model = combo name), or keep single
   models and let the admission profile handle the fan-out.
4. Watch `/api/models/tags?panel=true&category=coder&size=4` to see what the
   panel resolves to today.
