# Guide: Hermes Agent Driving the OpenDev Swarm

> **Architecture Overview**: Hermes acts as the **Autonomous Brain & Project Manager**.
> OmniRoute acts as the **Intelligence & Model Routing Gateway**.
> OpenDev acts as the **Local Git Worktree & Test Execution Engine**.

---

## 1. The Interaction Protocol

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HERMES AGENT (The Brain)                          │
│                                                                             │
│  1. Receives user requirement: "Build a JWT authentication module."         │
│  2. As Lead Architect (tag: 'plan'), decomposes goal into DAG task waves.   │
│  3. Defines locked interface schema (_locked: ['api_spec', 'schema']).      │
│  4. Submits plan to OmniRoute: POST /v1/orchestrate/plan                    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                    OMNIROUTE GATEWAY + OPENDEV DAEMON                       │
│                                                                             │
│  Wave 1:                                                                    │
│    • Task 1 (Backend Dev): Worktree A (Claude 3.7 Sonnet)                   │
│    • Task 2 (Frontend Dev): Worktree B (DeepSeek-V3)                        │
│    Both code simultaneously against locked Blackboard schemas.              │
│                                                                             │
│  Wave 2:                                                                    │
│    • Task 3 (QA Tester): Worktree C (Qwen 2.5 Coder)                        │
│    Runs detached test supervisor (`npm test` / `pytest`).                   │
│                                                                             │
│  Wave 3:                                                                    │
│    • Task 4 (Security Reviewer): Diff analysis & PR synthesis.              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
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
description: "Decompose complex software engineering goals into parallel DAG waves, allocate worktrees via OpenDev, enforce locked Blackboard schemas, and supervise test suites to completion."
---

# OpenDev Swarm Orchestration

When asked to implement a multi-file feature or complete a complex software task:

1. Emit an orchestrated plan targeting OpenDev:
```json
{
  "goal": "<High-level feature description>",
  "mode": "swarm",
  "blackboard": {
    "canon": "<Architecture RFC and conventions>",
    "api_spec": "<Typed route interfaces>",
    "schema": "<Database schema>",
    "_locked": ["canon", "api_spec", "schema"]
  },
  "tasks": [
    {
      "id": "t1-backend",
      "tag": "code",
      "prompt": "<Specific backend task prompt>",
      "depends_on": []
    },
    {
      "id": "t2-frontend",
      "tag": "code",
      "prompt": "<Specific frontend task prompt>",
      "depends_on": []
    },
    {
      "id": "t3-qa",
      "tag": "code",
      "prompt": "<Integration test creation & verification>",
      "depends_on": ["t1-backend", "t2-frontend"]
    }
  ],
  "policy": {
    "execution_target": "opendev",
    "verify_supervisor": true,
    "max_rounds": 3
  }
}
```

2. Submit plan:
```bash
curl -s http://localhost:20128/v1/orchestrate/plan -d @plan.json
```

3. Poll job status until `status == "done"`:
```bash
curl -s "http://localhost:20128/v1/orchestrate/jobs/<jobId>?wait=30"
```
```
