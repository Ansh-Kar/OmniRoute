# OmniRoute — Revised Intelligent Routing Guide

## Objective

Extend OmniRoute from conventional routing into a fast, task-aware model federation layer.

The new routing mode should answer:

> **Which available execution model is best suited for this task, based on capability evidence, benchmarks, observed workflow performance, reliability, latency and cost?**

OmniRoute should **not** become an agent runtime or planner. Hermes already provides those capabilities.

---

# 1. Target Architecture

```text
                         HERMES
                  Executive / Planner
                         |
              +----------+----------+
              |                     |
          self / tools          model work
              |                     |
              |                     v
              |                 OmniRoute
              |                     |
              |             capability matching
              |                     |
              |                ranking/cache
              |                     |
              |          +----------+----------+
              |          |          |          |
              |        primary   secondary   fallback
              |          |          |          |
              |          +----------+----------+
              |                     |
              |                  provider
              |                     |
              |                   model
              |                     |
              +----------+----------+
                         |
                       result
                         |
                       Hermes
```

The important boundary is:

**Hermes decides what work should happen. OmniRoute determines which model is appropriate to execute model work.**

---

# 2. Do NOT Replace Existing Routing

Keep all existing routing modes and behavior.

For example:

```text
round_robin
weighted
priority
power_of_two
...
```

Add:

```text
intelligent
```

This should be an additional strategy, not a rewrite of the existing router.

This preserves backward compatibility and gives users a choice.

---

# 3. Model Registry

Create/standardize structured metadata for every model.

Recommended structure:

```yaml
model:
  id: model-id
  name: Model Name
  provider: provider-id

capabilities:
  text: true
  vision: true
  audio: false
  video: false
  ocr: true
  coding: true
  reasoning: true
  image_generation: false
  tool_calling: true

specializations:
  - visual_reasoning
  - ocr

benchmarks:
  ocr: 96
  vision: 94
  reasoning: 87

benchmark_metadata:
  source: public
  snapshot: 2026-09-01
  confidence: medium

operational:
  context_window: 128000
  latency_p50_ms: 1800
  cost_per_million_tokens: 0.40
```

Do not invent missing benchmarks.

Use:

```text
null / unknown
```

when evidence does not exist.

---

# 4. Benchmark Philosophy

Public benchmarks are **prior evidence**, not truth.

The router should preserve:

```text
public benchmark
+
observed workflow performance
```

as separate signals.

Do not overwrite benchmark scores with runtime observations.

Benchmarks may also be unavailable for certain capabilities, especially web research. That is expected.

---

# 5. Observed Performance

Record real workload outcomes.

Example:

```yaml
observed:
  screenshot_ocr:
    attempts: 37
    successes: 35
    success_rate: 0.946
    p50_latency_ms: 1800

  ui_debugging:
    attempts: 12
    successes: 11
    success_rate: 0.917
```

This allows OmniRoute to learn:

```text
P(success | model, task_type, input_characteristics)
```

Keep observations task-specific where practical.

---

# 6. Capability Index

Do not scan every model for every request.

Build indexes:

```text
ocr
  -> model-a
  -> model-b
  -> model-c

vision
  -> model-a
  -> model-d

coding
  -> model-b
  -> model-e
```

The flow becomes:

```text
task
 -> required capabilities
 -> capable candidates
 -> scoring
```

This should be fast enough that routing overhead is negligible compared with model inference.

---

# 7. Intelligent Candidate Scoring

The intelligent strategy should combine:

```text
capability match
benchmark evidence
observed task performance
reliability
availability
latency
cost
context compatibility
```

Conceptually:

```text
score =
    capability_match
  + benchmark_evidence
  + observed_performance
  + reliability
  - latency_penalty
  - cost_penalty
```

Do not hard-code the final formula prematurely.

Make weights/configuration testable.

---

# 8. Task Profile

The router should consume a compact task profile rather than attempting to fully reason about the task.

Example:

```json
{
  "task_type": "screenshot_ocr",
  "modalities": ["image"],
  "capabilities": ["ocr", "vision"],
  "complexity": "medium",
  "context_required": 32000
}
```

Hermes can provide the semantic task description when needed.

OmniRoute's job is to turn that into candidate ranking.

---

# 9. Return the Whole Candidate Set

Do not expose only three models.

For a capability with 12 candidates:

```json
{
  "primary": "model-a",
  "secondary": [
    "model-b",
    "model-c"
  ],
  "fallback": [
    "model-d",
    "model-e",
    "model-f",
    "model-g",
    "model-h",
    "model-i",
    "model-j",
    "model-k",
    "model-l"
  ]
}
```

Primary/secondary/fallback are recommendations.

They are **not access restrictions**.

Hermes may override the recommendation when task context warrants it.

---

# 10. Fast Routing API

Expose a compact interface.

Example:

```http
POST /route
```

Request:

```json
{
  "task": "Extract and interpret text from this screenshot",
  "modalities": ["image"],
  "capabilities": ["ocr", "visual_reasoning"],
  "complexity": "medium"
}
```

Response:

```json
{
  "primary": "model-a",
  "secondary": ["model-b", "model-c"],
  "fallback": ["model-d", "model-e"],
  "confidence": 0.94
}
```

Optional evidence can be included when requested.

Avoid returning the entire registry by default.

---

# 11. Routing Cache

Use a task-signature cache.

```text
task signature
    ->
ranked candidates
```

Example:

```text
vision + OCR + screenshot
    ->
model-a, model-b, model-c...
```

Invalidate/recalculate when relevant state changes:

```text
model health
metadata version
benchmark snapshot
observed-performance window
provider availability
```

---

# 12. Runtime Failure Classification

Do not treat every failure as model-quality failure.

Distinguish:

```text
MODEL_QUALITY_FAILURE
PROVIDER_TIMEOUT
RATE_LIMIT
INVALID_REQUEST
CONTEXT_OVERFLOW
TOOL_FAILURE
NETWORK_FAILURE
SERVICE_UNAVAILABLE
```

Only quality failures should strongly affect task-specific model reputation.

Infrastructure failures should primarily affect health/availability.

---

# 13. Tools, Models and Agents Are Different

Do not put everything into one model list.

Represent:

```text
MODEL
  Model A

TOOL
  Camofox
  OpenWork

AGENT
  Hermes Research Bot
```

The router may maintain capability metadata for tools/agents, but it should not implement their runtimes.

For example:

```yaml
camofox:
  type: tool
  capabilities:
    - browser
    - web_navigation

research_bot:
  type: agent
  capabilities:
    - web_research
    - source_verification
    - synthesis
```

---

# 14. Web Research

Do not force web research into normal model benchmarks.

Web quality is a workflow property:

```text
model
+
browser/tool
+
search strategy
+
source selection
+
verification
+
synthesis
```

Record workflow outcomes instead:

```yaml
workflow:
  task_type: technical_research
  model: model-x
  tools:
    - camofox

outcome:
  sources_found: 14
  sources_verified: 12
  quality_score: 0.91
  latency_ms: 38000
```

The router can provide this evidence when ranking research-capable execution paths.

---

# 15. Memory Boundary

OmniRoute should be **memory-aware**, but should not become Hermes' long-term semantic memory.

Expose interfaces such as:

```text
recordOutcome(...)
getModelHistory(...)
getTaskHistory(...)
```

Store structured routing statistics.

Let Hermes retain richer semantic memories and agent context.

---

# 16. What NOT to Build in OmniRoute

Do NOT build:

```text
agent loop
planner
Bot runtime
Bot profiles
Bot-to-Bot messaging
long-term agent memory
LLM evaluator
swarm orchestration
tool execution framework
```

Hermes already provides the relevant agent infrastructure.

OmniRoute should remain:

```text
fast
deterministic
data-driven
provider-agnostic
```

---

# 17. Model Invocation

OmniRoute may remain responsible for the actual provider/model transport if that is already how the fork works:

```text
provider selection
authentication
request translation
timeouts
retries
health
fallback
```

But do not add agent-level planning to this layer.

---

# 18. Intelligent Routing Example

Task:

> Read this screenshot and explain the UI problem.

Task profile:

```text
image
OCR
visual reasoning
UI understanding
medium complexity
```

Candidate ranking:

```text
Model A
OCR: 96
UI: 91
history: 95

Model B
OCR: 94
UI: 94
history: 92

Model C
OCR: 92
UI: 90
history: 93
```

The router may recommend:

```text
primary: Model B
secondary: Model A, Model C
```

because the task is UI reasoning rather than pure OCR.

---

# 19. Implementation Order

## Phase 1
Finalize metadata schema.

## Phase 2
Build capability indexes.

## Phase 3
Implement intelligent scoring.

## Phase 4
Return complete ranked candidates.

## Phase 5
Add primary/secondary/fallback representation.

## Phase 6
Add routing cache.

## Phase 7
Add runtime outcome collection.

## Phase 8
Add task-specific historical performance.

## Phase 9
Add tool/agent capability representation.

## Phase 10
Expose compact `/route`.

## Phase 11
Integrate Hermes.

---

# 20. Final Router Contract

OmniRoute answers:

> **Who can perform this model task, what evidence supports that choice, and what are the alternatives if it fails?**

It should NOT answer:

> Should Hermes delegate?

> Should Hermes spawn a swarm?

> How should multiple agents collaborate?

Those are Hermes decisions.

Keep the router small and fast.
