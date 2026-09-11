# Guide: Hermes Agent Driving the OpenDev Swarm

> **Architecture Overview**: Hermes acts as the **Autonomous Brain & Project Manager**.
> OmniRoute acts as the **Intelligence & Model Routing Gateway**.
> OpenDev acts as the **Local Git Worktree & Test Execution Engine**.
>
> **B10 (OpenResearch adaptation)**: Hermes names OBJECTIVES, never models and
> never tags. The gateway infers per-task capability tags from each prompt,
> routes through the capability pipeline, and — when Hermes names itself via
> `caller_model` — refuses to route sub-agent work back to Hermes's own model
> while a viable alternative exists (the bias guard: a same-model ensemble
> inherits the caller's blind spots). Scheduling follows the OpenResearch
> auto-research loop shape: per-completion wakes, freed slots refilled
> immediately, work delegated to self-contained helper jobs.

---

## 1. The Interaction Protocol

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HERMES AGENT (The Brain)                          │
│                                                                             │
│  1. Receives user requirement: "Build a JWT authentication module."         │
│  2. Decomposes the objective into task waves (or lets the gateway run it    │
│     as a single task). No model picking, no tag picking — name the work.    │
│  3. Names itself: caller_model — the gateway avoids self-routing.           │
│  4. Submits: POST /v1/orchestrate/objectives                                │
└────────────────────────────────────────────┬────────────────────────────────┘
                                             │
┌────────────────────────────────────────────▼────────────────────────────────┐
│                    OMNIROUTE GATEWAY + OPENDEV DAEMON                       │
│                                                                             │
│  Tags inferred per prompt (code/research/…) · bias guard active ·           │
│  policy.scheduling: stream — freed slots refill per completion.             │
│                                                                             │
│  Wave/Stream:                                                               │
│    • Task 1 (Backend Dev): Worktree A (model ≠ Hermes's)                    │
│    • Task 2 (Frontend Dev): Worktree B (model ≠ Hermes's)                   │
│    Both code simultaneously against locked Blackboard schemas.              │
│    The moment Task 1 lands, Task 3 starts in its slot — no barrier.         │
│                                                                             │
│  Verification:                                                              │
│    • QA task runs the detached test supervisor (npm test / pytest)          │
│    • Failures requeue with extracted diagnostics (max_rounds cap)           │
│                                                                             │
│  Delegation: POST /v1/orchestrate/spawn — self-contained helper jobs,       │
│  no nesting, max_children in-flight cap, wake via /v1/orchestrate/wait.     │
└────────────────────────────────────────────┬────────────────────────────────┘
                                             │
┌────────────────────────────────────────────▼────────────────────────────────┐
│                      FINAL VERIFICATION & PR MERGE                          │
│                                                                             │
│  All tests pass ──► Git branches merged to main ──► Pull Request generated. │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Hermes Orchestration Skill Template

In Hermes (`~/.hermes/skills/opendev/SKILL.md`):

```markdown
---
name: opendev-swarm
description: "Decompose objectives into parallel task waves, allocate worktrees via OpenDev, enforce locked Blackboard schemas, supervise test suites to completion, and delegate independent work to helper jobs."
---

# OpenDev Swarm Orchestration

When asked to implement a multi-file feature or complete a complex software task:

1. Submit the objective (tags are OPTIONAL — the gateway infers them; models
   are NEVER chosen here):

```json
{
  "objective": "<High-level feature description>",
  "caller_model": "<the model YOU run on — enables the bias guard>",
  "subtasks": [
    { "id": "t1-backend", "prompt": "<Specific backend task prompt>", "depends_on": [] },
    { "id": "t2-frontend", "prompt": "<Specific frontend task prompt>", "depends_on": [] },
    { "id": "t3-qa", "prompt": "<Integration test creation & verification>", "depends_on": ["t1-backend", "t2-frontend"] }
  ],
  "blackboard": {
    "canon": "<Architecture RFC and conventions>",
    "api_spec": "<Typed route interfaces>",
    "schema": "<Database schema>",
    "_locked": ["canon", "api_spec", "schema"]
  },
  "policy": {
    "execution_target": "opendev",
    "verify_supervisor": true,
    "scheduling": "stream",
    "max_rounds": 3
  }
}
```

2. Submit:
```bash
curl -s http://localhost:20128/v1/orchestrate/objectives -d @objective.json
```

3. Drive the per-completion loop (NOT a wait-for-all barrier):

```
loop:
  GET /v1/orchestrate/jobs/<jobId>/wait-first?timeout=30   # wakes on the FIRST
                                                          # task completion
  # The wake is a SIGNAL, not the source of truth: re-read the full task
  # list in the response every wake; act on every newly-terminal task
  # (completed_since), not just the one that woke you.
  #   - read its result; decide: refill the slot (POST …/jobs/<id>/tasks),
  #     promote, or stop
  # re-issue wait-first each tick
  # exit when drained: true (job terminal)
```

4. Delegate independent work with a SELF-CONTAINED brief (the helper sees
   nothing else — include project, constraints, compute authorization,
   expected output, definition of done):

```bash
curl -s http://localhost:20128/v1/orchestrate/spawn -d '{
  "parent_job_id": "<jobId>",
  "brief": "Survey the auth codebase and report the current token flow.
            Read-only: do not launch experiment runs. Output: a 10-line summary.",
  "caller_model": "<your model>"
}'
# Wake when ANY helper finishes:
curl -s "http://localhost:20128/v1/orchestrate/wait?job_ids=<a>,<b>&timeout=30"
```

Rules: a helper cannot spawn its own helper (nesting is refused); at most
`max_children` (default 4) helpers in flight; never hand a helper a branch
this session owns.
```
