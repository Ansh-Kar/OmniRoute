# Setup: Point Hermes at OmniRoute (user guide)

> Ten minutes, base-project structure unchanged: add the providers you
> want, create **one** API key, point Hermes at the endpoint. Hermes then
> gets every model through one URL — and never picks a model itself: the
> gateway routes on category + benchmark scores, spreads parallel calls
> across models, and (when Hermes names its own model) avoids routing
> sub-agents back to it on near-ties.

```
you ──► add providers + keys (dashboard, as always)
   ──► create ONE OmniRoute API key
   ──► Hermes base URL = http://localhost:20128/v1   key = that one key
Hermes ──► /v1/orchestrate/objectives ──► sub-agents on the best models
```

---

## 1. Run the gateway

Same as the base project — nothing fork-specific here:

```bash
# from a checkout of this fork:
npm install
npm run dev          # dev server on http://localhost:20128
# or for always-on:
npm run build && npm start
```

A fresh install answers immediately (the keyless free tier is pre-wired),
so you can verify before adding anything:

```bash
curl http://localhost:20128/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "ping"}]}'
```

## 2. Add your providers (dashboard → Providers)

Open <http://localhost:20128> and go to **Providers** — the same page as
the base project. Add each provider you have a credential for (OpenAI,
Anthropic, Gemini, OpenRouter, …) and paste its API key. That's the entire
provider setup: the fork adds no new provider concepts, no new config
files, no env vars per provider.

What the fork ADDS on top (invisible here, automatic later):
- every provider's models carry **benchmark scores** per category
  (code / math / reasoning / research / …), so routing is merit-based;
- a **tag index** (provider + category + benchmarks) that the orchestrator
  ranks candidates from;
- **circuit breakers + canaries** per provider, so a dead provider stops
  receiving work until it recovers.

## 3. Create ONE API key (dashboard → API Manager)

Go to **API Manager** and create a key. This is the single key Hermes
uses — it reaches every provider you added. (Keys are the base project's
own mechanism; the fork doesn't change them.)

## 4. Point Hermes at the endpoint

Give Hermes (or any OpenAI-compatible agent) two values:

| Setting | Value |
|---|---|
| Base URL | `http://localhost:20128/v1` |
| API key | the OmniRoute key from step 3 |

(`/v1/*` and `/api/v1/*` are the same thing — the fork rewrites one to the
other, so either works.)

If Hermes supports an OpenAI-style client config, that's all it takes:
the chat endpoint (`/v1/chat/completions`) behaves exactly like OpenAI's,
with `model: "auto"` for automatic routing. The orchestration surface
(objectives, sub-agents, spawn) lives under `/v1/orchestrate/*` — see the
next step.

## 5. Install the orchestration skill (one file)

Copy the agent guide into Hermes's skills directory so it knows the tool:

```bash
cp docs/guides/AGENT_TOOL_GUIDE.md  ~/.hermes/skills/omniroute/SKILL.md
```

That file is the entire agent-facing contract: submit objectives
(`POST /v1/orchestrate/objectives` — no model picking, no tag picking;
the gateway infers categories and routes by benchmark), drive the
per-completion loop (`wait-first`), refill (`/jobs/{id}/tasks`), delegate
(`/spawn`), and wake (`/v1/orchestrate/wait`). Hermes should also name
itself (`caller_model`) — that activates the bias guard.

## 6. Smoke-test the orchestration path

```bash
KEY=omni-…   # the key from step 3

# one synchronous task (fastest check):
curl -s http://localhost:20128/v1/orchestrate/quick \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"tag": "chat", "prompt": "Say ready."}'

# the real thing — an objective with two parallel subtasks:
curl -s http://localhost:20128/v1/orchestrate/objectives \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
        "objective": "Draft a release note and a tweet for v1.2",
        "subtasks": [
          {"prompt": "Write a 200-word release note for v1.2 (fast serial cache, new providers)"},
          {"prompt": "Write a 280-char launch tweet"}
        ],
        "caller_model": "gpt-4o",
        "policy": {"scheduling": "stream"}
      }'
# → {"ok": true, "job_id": "job_…", "inferred_tags": {"t1": "chat", "t2": "chat"}, …}

# watch it land per completion:
curl -s "http://localhost:20128/v1/orchestrate/jobs/<job_id>/wait-first?timeout=30" \
  -H "Authorization: Bearer $KEY"
```

## 7. Knobs you might care about (all optional — defaults are sane)

| Policy | Default | Meaning |
|---|---|---|
| `scheduling` | `wave` | `stream` = per-completion scheduling (recommended for parallel work); `wave` = barrier batches |
| `deadline_s` | 600 | Job time budget; partial results survive a breach |
| `max_concurrency` | 8 | Parallel task slots |
| `max_total_tokens` | ∞ | Cost ceiling; unstarted tasks abort on breach |
| `max_rounds` | 3 | Judge refinement rounds before accepting with flaws |
| `bias_guard` | true | Avoid routing sub-agents to Hermes's own model |
| `bias_tolerance` | 0.85 | How lenient that guard is: 0 = always avoid, 1 = avoid only when another model is at least as good |
| `max_children` | 4 | Concurrent spawned helper jobs per parent |

## 8. Troubleshooting

- **401/403** — wrong key, or the key lacks scope; check API Manager.
- **`no_active_models` on a category** — no provider covering that
  category is healthy/connected; check Providers (breakers may be open).
- **Hermes calls a model name directly** — it shouldn't; re-install the
  skill (step 5). `model: "auto"` on chat is the only "pick" it needs.
- **Port conflict** — 20128 is the default; change it the same way as the
  base project.
