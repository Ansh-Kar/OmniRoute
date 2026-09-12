# Hermes — Revised Intelligent Agent Integration Guide

## Objective

Use Hermes' existing agent, tool, profile/Bot and delegation capabilities rather than building a second orchestration framework.

The new behavior should be:

> **If Hermes can do the task well enough, do it. If a specialist provides meaningful advantage, use OmniRoute. If the task is long, specialized, parallelizable or sustained, delegate to a Hermes Bot/agent.**

---

# 1. Target Architecture

```text
                         USER
                           |
                           v
                        HERMES
                           |
                understand task
                           |
             +-------------+-------------+
             |                           |
        self / tool                  model work
             |                           |
             |                           v
             |                       OmniRoute
             |                           |
             |                       best model
             |                           |
             +-------------+-------------+
                           |
                    complex / long?
                           |
                          YES
                           |
                           v
                     Hermes Bot
                           |
                    tools + model
                           |
                           v
                        result
                           |
                           v
                         Hermes
```

Hermes is the executive layer.

OmniRoute is the model-selection/federation layer.

Hermes Bots are the specialist-agent layer.

---

# 2. Do NOT Rewrite Hermes' Agent Loop

Do not build a second planner or custom orchestration engine inside the fork unless a concrete Hermes limitation requires it.

Use existing Hermes mechanisms for:

```text
tool calling
profiles
Bot Mode
delegation
agent messaging
memory
browser tools
skills
scheduling
```

The goal is a thin integration.

---

# 3. Self-Execution First

For each task, Hermes should first ask:

```text
Can I solve this reliably?
Is the task simple enough?
Would delegation materially improve the result?
Is the improvement worth the latency/token/context overhead?
```

If yes:

```text
SELF EXECUTE
```

Do not route every task through another model.

---

# 4. Specialist Delegation

If specialist advantage is meaningful:

```text
Hermes
  ->
OmniRoute /route
  ->
candidate evidence
  ->
Hermes selects execution path
  ->
model
```

Hermes should receive enough information to make a decision without receiving the entire model registry.

---

# 5. Avoid Model-Selection LLM Calls

Do NOT implement:

```text
Hermes
  ->
LLM Router
  ->
"Which model should I use?"
  ->
specialist
```

That wastes tokens and latency.

Use:

```text
Hermes
  ->
cheap /route call
  ->
ranked candidates
  ->
decision
  ->
model
```

The routing algorithm should be ordinary code.

---

# 6. Do Not Hard-Code Provider Preferences

Avoid instructions such as:

```text
Always use Qwen for OCR.
Always use Provider X for coding.
```

Hermes should not carry a hidden provider preference.

Ask OmniRoute for current evidence.

Provider/model identity can remain visible where necessary for execution and debugging, but it should not become a biasing instruction.

---

# 7. Candidate Visibility

When Hermes deliberately requests model routing, allow it to see the full capable candidate pool.

Example:

```text
PRIMARY
Model A

SECONDARY
Model B
Model C

FALLBACK
Model D
Model E
...
Model L
```

Do not restrict Hermes to three candidates merely because the router selected three.

The ranking is evidence, not an access policy.

---

# 8. Hermes' Self Model Should Not Receive a Hidden Advantage

Treat self-execution as one option.

Conceptually:

```text
SELF
Model A
Model B
Model C
...
```

Do not automatically declare Hermes best.

But also do not force Hermes to delegate simply to avoid bias.

The correct decision is:

```text
expected quality
+
latency
+
cost
+
reliability
+
delegation overhead
```

---

# 9. Tools vs Models vs Agents

Hermes should understand three distinct execution types.

### Tool

Example:

```text
Camofox
```

Use for direct operations.

### Model

Example:

```text
Qwen-VL
```

Use for specialized model inference.

### Agent/Bot

Example:

```text
Research Bot
```

Use for sustained or complex work.

---

# 10. Camofox / Browser Policy

Keep Camofox available directly to the main Hermes agent.

For:

> Check the latest documentation for X.

Prefer:

```text
Hermes -> Camofox -> webpage -> Hermes
```

No specialist agent is necessary.

For:

> Research 20 projects, verify primary sources, compare architectures and synthesize the findings.

Prefer:

```text
Hermes
  ->
Research Bot
  ->
Camofox/OpenWork
  ->
research + verification
  ->
Hermes synthesis
```

The browser is a tool; research is an agent-level workload.

---

# 11. Bot Mode

Use existing Hermes profiles/Bots as persistent specialists.

Example:

```text
@research
@coder
@vision
@reviewer
```

Each can have its own:

```text
model
memory
skills
tools
configuration
```

Do not reproduce this functionality inside OmniRoute.

---

# 12. Agent Messaging

Use Hermes' existing agent communication facilities for specialist collaboration.

Do not invent another messaging protocol unless the existing interface cannot satisfy a required use case.

The desired structure is:

```text
Hermes
  ->
specialist Bot
  ->
result
  ->
Hermes
```

For long-running work:

```text
Hermes
  ->
Bot
  ->
asynchronous work
  ->
result
```

---

# 13. Delegation Levels

Keep the escalation hierarchy simple.

```text
LEVEL 0
Hermes self-executes

LEVEL 1
One specialist model

LEVEL 2
Primary + fallback

LEVEL 3
Parallel specialists

LEVEL 4
Agent swarm
```

Most requests should finish at Level 0 or Level 1.

Swarm execution should be exceptional.

---

# 14. When to Use a Bot

Delegate to a Bot when the task is:

```text
long
specialized
multi-step
parallelizable
sustained
out-of-domain
research-heavy
```

Do NOT spawn a Bot for:

```text
simple OCR
simple summarization
quick web lookup
short code transformation
simple reasoning
```

when Hermes or a direct tool can handle them efficiently.

---

# 15. Parallel Work

Parallelize only independent subtasks.

Example:

```text
                 Hermes
                    |
          +---------+---------+
          |         |         |
       Vision      Code    Research
        Bot        Bot       Bot
          |         |         |
          +---------+---------+
                    |
                  Hermes
                    |
                 synthesis
```

Do not parallelize sequential dependencies.

---

# 16. Evaluation

Evaluate delegated results when practical.

Prefer deterministic checks:

```text
OCR -> required text extracted?
JSON -> schema valid?
Code -> tests pass?
Browser -> requested page/action succeeded?
Research -> required sources present?
```

Use an evaluator model only when deterministic validation is insufficient.

Do not create an evaluator call for every trivial task.

---

# 17. Outcome Feedback

After an execution:

```text
task
  ->
execution
  ->
result
  ->
evaluation
  ->
outcome
```

Record useful structured information:

```text
model
task type
success
latency
failure category
quality/evaluation
```

Send the structured outcome to OmniRoute's statistics/memory interface.

---

# 18. Failure Handling

Distinguish:

```text
quality failure
provider timeout
rate limit
invalid request
context overflow
tool failure
network failure
service unavailable
```

Do not conclude:

> Model X is bad at OCR.

because:

> Provider X timed out.

Infrastructure failures should affect availability/health, not task-quality reputation.

---

# 19. Fast Path

The normal request should be cheap:

```text
Hermes
  |
  +--> simple -> self
  |
  +--> tool -> direct tool
  |
  +--> specialist -> /route -> one model
  |
  +--> complex -> Bot
```

Avoid:

```text
Hermes
 -> router model
 -> evaluator
 -> planner
 -> specialist
```

for ordinary requests.

---

# 20. Suggested Hermes Policy

Add a small system/profile instruction rather than changing the core agent architecture.

Recommended policy:

```text
EXECUTION POLICY

Prefer self-execution for simple tasks you can solve reliably.

Use available tools directly for short operations that tools can
perform efficiently.

When a task requires a specialist model capability, consult
OmniRoute's intelligent routing information.

Do not delegate merely because another model has a slightly higher
benchmark. Consider expected quality, latency, cost, reliability
and delegation overhead.

For long, specialized, parallelizable, sustained or out-of-domain
work, delegate to an appropriate Hermes Bot.

For independent subtasks, parallelize only when the expected benefit
exceeds orchestration overhead.

Evaluate delegated results when practical.

Record meaningful execution outcomes so future model routing can
learn from actual workflows.
```

---

# 21. What NOT to Change in Hermes

Avoid changing:

```text
core agent loop
existing tool framework
Bot runtime
Bot profile architecture
existing memory system
existing peer/agent messaging
existing browser integration
existing provider abstraction
```

unless testing reveals an actual integration limitation.

The fork should add the smallest possible integration surface.

---

# 22. Recommended Integration Surface

Ideally Hermes only needs:

```text
1. OmniRoute client/provider integration
2. Optional /route capability query
3. Small execution-policy instruction
4. Structured outcome callback
```

Everything else should use existing Hermes functionality.

---

# 23. Example: OCR

User:

> Extract the text from this screenshot.

Hermes determines:

```text
simple
image input
OCR required
```

Possible path:

```text
Hermes
  ->
OmniRoute /route
  ->
Model A
  ->
result
```

No Bot.

---

# 24. Example: UI Debugging

User:

> Read this screenshot and explain why the UI is broken.

Hermes determines:

```text
OCR
+
vision
+
UI reasoning
```

OmniRoute:

```text
Model A  OCR 96 | UI 91 | history 95
Model B  OCR 94 | UI 94 | history 92
Model C  OCR 92 | UI 90 | history 93
```

Hermes selects Model B because UI reasoning is more relevant than raw OCR.

```text
Hermes -> Model B -> Hermes
```

---

# 25. Example: Web Lookup

User:

> Check the current Hermes documentation.

Use:

```text
Hermes -> Camofox -> web -> Hermes
```

No model swarm.

---

# 26. Example: Deep Research

User:

> Compare 20 model-routing frameworks, verify their current
> documentation, collect primary sources and recommend an architecture.

Use:

```text
Hermes
  ->
Research Bot
  ->
Camofox/OpenWork
  ->
source collection
  ->
verification
  ->
synthesis
  ->
Hermes
```

OmniRoute may select the Research Bot's underlying model if needed, but it does not orchestrate the research itself.

---

# 27. Final Boundary

Hermes answers:

> **What should happen, should I do it myself, should I use a tool, should I delegate, and how should I combine the results?**

OmniRoute answers:

> **Which model is best suited for this model task, what evidence supports that choice, and what alternatives are available?**

Hermes Bots answer:

> **How do I execute a sustained specialized workflow?**

Keep these boundaries clean.

The objective is not maximum delegation.

The objective is **minimum unnecessary delegation with maximum useful specialization**.
