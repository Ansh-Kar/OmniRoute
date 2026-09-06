# Agent-swarm examples

Ready-to-import `swarm` combos: **different tasks → different models, in
parallel**, in a single call. Full documentation:
`docs/guides/PARALLEL_EXECUTION.md` → _"Agent swarms (`swarm` strategy)"_.

## Combos

| Combo             | Shape                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `launch-swarm`    | 3 tag-picked specialists (reasoning / chat / vision), `synthesize: true` → one merged answer.      |
| `research-swarm`  | 3 tag-picked workers, `resultFormat: "json"` → structured per-task records for programmatic use.   |
| `dev-squad`       | architect + coder + reviewer, synthesized by an explicit `judgeModel`.                             |
| `ad-hoc-swarm`    | Placeholder tasks — drive it per request with `body.swarm.tasks` (below).                          |

## Import

```bash
bash examples/swarm/import.sh [base-url] [api-key]
```

## Using a swarm

Point any OpenAI-compatible client at the combo (model = combo name):

```json
{
  "model": "launch-swarm",
  "messages": [{ "role": "user", "content": "We're launching a time-travel debugger called Chronos." }]
}
```

The three specialists run in parallel; with `synthesize: true` the response is
one coherent answer. Without synthesis, the response is a synthetic chat
completion with labeled sections (`## strategy — provider/model`, …) — or
structured JSON with `resultFormat: "json"`.

## Per-request swarms (`ad-hoc-swarm`)

One combo, any workload — send the tasks with the request (`body.swarm`):

```json
{
  "model": "ad-hoc-swarm",
  "messages": [{ "role": "user", "content": "Ship v2 of our API." }],
  "swarm": {
    "tasks": [
      { "label": "changelog", "task": "Write the v2 changelog from the user's request.", "fromTags": { "category": "chat", "minBenchmark": 75 } },
      { "label": "sdk", "task": "Outline the SDK migration guide.", "fromTags": { "category": "coder", "minBenchmark": 80 } },
      { "label": "risks", "task": "List the top migration risks.", "fromTags": { "category": "reasoning", "minBenchmark": 80 } }
    ],
    "synthesize": true
  }
}
```

`body.swarm` overrides the combo's stored tasks, accepts every run-level
field (`synthesize`, `judgeModel`, `defaultModel`, `maxConcurrency`,
`resultFormat`), and is stripped before workers are dispatched.

## Notes

- Workers run chat-shaped: tools stripped, non-streaming, task instruction as
  the leading system turn. Streaming/tool-bearing clients should use
  `synthesize: true` (the judge preserves the client's stream flag and tools).
- Tag specs re-resolve on every dispatch and are cross-task diverse: two tasks
  with the same spec get different models when the catalog allows.
- A failed/timed-out/lane-full task is reported per task; the rest of the run
  completes. Max 40 tasks per run; default concurrency 8 (tune
  `maxConcurrency`, and see the admission tuning section of the guide for
  wider fan-outs).
