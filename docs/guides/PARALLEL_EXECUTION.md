# Parallel Execution Guide

> Fork feature: run **multiple models from multiple providers simultaneously**,
> pick them by **what they are good at** (category + benchmark), and tune the
> gateway so concurrent agent traffic stops tripping its own admission gate.

This guide covers the three pieces of the fork's parallel-execution story:

1. **Model tagging** — every catalog model carries provider, category and
   benchmark tags, retrievable via `GET /api/models/tags`.
2. **Tag-driven fusion panels** — a fusion combo whose panel is _resolved at
   dispatch time_ from those tags (`config.panelFromTags`), fanning one prompt
   out to distinct models across distinct providers in parallel, with a judge
   synthesizing the final answer.
3. **Admission + transport tuning** — the deployment profile that lets
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

## 3. Admission and transport tuning

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

## 4. Putting it together

A parallel coding-agent setup:

1. `.env` from this fork's `.env.example` — admission + transport already tuned.
2. Import the example combos: `bash examples/fusion-parallel/import.sh`.
3. Point your agents at the fusion combo (model = combo name), or keep single
   models and let the admission profile handle the fan-out.
4. Watch `/api/models/tags?panel=true&category=coder&size=4` to see what the
   panel resolves to today.
