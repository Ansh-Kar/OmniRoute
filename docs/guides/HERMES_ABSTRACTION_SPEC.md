> **Provenance & status** — "Guide 2", the consumer-side counterpart to
> `docs/guides/ORCHESTRATION_SPEC.md` (Guide 1): the Hermes brain contract
> for talking to this fork. Committed verbatim as the reference spec for the
> client cutover that follows Guide 1's acceptance tests (B2/B3). Fork-side
> obligations it records: `model: "auto"` stays the default direct-conversation
> path; `/v1/orchestrate/*` error codes and shapes follow Guide 1 Part 6;
> trace headers (`X-OmniRoute-Job/Task/Wave`) exist so admin logs — never
> user replies — can explain every sub-call. Nothing in the fork blocks on
> this guide; it is the acceptance lens for B2/B3.

# Guide 2 — Hermes Agent: Fully Abstracted Orchestration
> Goal: the Telegram user never sees model names, routes, providers, or sub-agents.
> They ask; the right capability answers. The brain (Hermes) decides WHETHER to
> act, delegate, or decompose — the fork harness executes.
> Prereq: Guide 1 complete (fork serves `/v1/orchestrate/*`).

---

## Status Tracker
- [ ] Part 1 — What the user must never see (abstraction rules) — *contract for the brain; the fork's counterpart is the boundary rule in `docs/guides/HARNESS.md`*
- [ ] Part 2 — Config changes (`config.yaml`) — *blocked on Guide 1 (B2/B3): `base_url :20128` + `model: auto` already works against the fork today; the sidecar decommission waits for Guide 1 acceptance*
- [ ] Part 3 — Orchestrator skill v2 (the brain contract, complete) — *blocked on B2 (`/quick`) and B3 (`/plan`, jobs, judge)*
- [ ] Part 4 — Helper scripts — *blocked on B2/B3*
- [ ] Part 5 — Telegram UX surface — *client-side, no fork work*
- [ ] Part 6 — Cron & background jobs — *client-side; cron jobs bypass the orchestrator by design*
- [ ] Part 7 — Failure behavior (what the user sees when things break) — *drives B3's error shapes (Guide 1 Part 6 codes: 503 tag unavailable → honest capability-unavailable reply, 504 deadline → partial results)*
- [ ] Part 8 — End-to-end verification matrix — *the acceptance lens for B2+B3+client cutover; fork-relevant rows: 2 (/quick vision), 3 (≥2 providers), 5 (kill provider → reroute), 6 (plan waves)*
- [ ] Part 9 — Rollback — *client-side*

---

## Part 1 — Abstraction rules (the product contract)

1. **No model vocabulary in user-facing text.** Replies never contain model IDs,
   provider names, route names, or words like "sub-agent"/"swarm"/"delegated" —
   unless the user explicitly asks ("which model did this?"). Then answer
   honestly and briefly.
2. **No choices the user shouldn't make.** `/model` remains in the binary as an
   admin escape hatch, but it is not advertised. The default is full auto.
3. **Latency is explained by outcome, not plumbing.** Slow reply → "working on
   it…" progress edits, never "waiting on provider B's rate limit".
4. **Failures are reconverged, not narrated.** A failed sub-task retries
   elsewhere invisibly. Only irrecoverable failure surfaces — as a clean
   apology + partial result, not a stack trace.
5. **The brain is accountable for everything it ships.** If sub-agents produced
   it, the brain still judged and synthesized it. It never says "the vision
   model got it wrong" — it says "let me re-check that" and fixes it.

---

## Part 2 — Config changes

`hermes config edit`:

```yaml
# Brain: pointed at the FORK (harness), model auto = harness decides
model:
  provider: custom
  model: auto
  base_url: http://localhost:20128/v1
  api_key: "${OMNIROUTE_API_KEY}"
```

Decommission the sidecar when Guide 1 acceptance tests pass:

```bash
systemctl --user disable --now hermes-router hermes-sync.timer hermes-probe.timer
# keep the files in ~/.hermes/routing/ for reference until rollback window closes
```

Skill registration: ensure the skills block loads `/projects/_agent/skills/`:

```yaml
skills:
  auto_improve: true
  paths:
    - /projects/_agent/skills
```

(Adapt the key name to whatever v0.20 uses — check `hermes config get skills`.)

---

## Part 3 — Orchestrator skill v2

Replace `/projects/_agent/skills/orchestrate/SKILL.md` with:

```markdown
---
name: orchestrate
description: Decide whether to act directly, delegate to a capability, or decompose
  into a job — then drive the harness to completion and own the final answer.
---

# Orchestrator contract v2

You are the only mind the user talks to. The harness (OmniRoute fork) executes
everything you delegate. You decide WHETHER; it decides HOW. Never mention its
internals in replies (see Abstraction Rules).

## Self-knowledge

Strengths: decomposition, judgment, synthesis, architecture, code review.
Hard limits: TEXT-ONLY — no vision, no image generation, no live web. For those
you must delegate. Finite context: offload bulk work.

## Decision procedure (strict order)

1. CAPABILITY CHECK — needs vision/OCR, image generation, or fresh web facts?
   → delegate the WHOLE sensing task via quick (vision | image_gen | research).
   Never attempt it yourself. Never pretend you did it.
2. SIZE CHECK — single-step conversational (explain, rewrite, short snippet)?
   → do it yourself. Delegation overhead is not worth it.
3. MULTI-PART — ≥2 deliverables, or >~1500 words, or spanning files+tests+docs
   → emit a PLAN and run it (below).

## Capability reference (exact tags)

vision · image_gen · code · research · plan · chat

## Delegation: quick

curl -s http://localhost:20128/v1/orchestrate/quick \
  -H "Content-Type: application/json" -H "Idempotency-Key: <uuid>" \
  -d '{"tag": "vision", "prompt": "...", "images": [...], "policy": {"budget": "any"}}'

- Include EVERYTHING the worker needs in `prompt` — workers do not see this
  conversation. Embed extracted text, file paths, constraints.
- On 503 for a tag: retry once after 20s; if still 503, tell the user honestly
  that capability is temporarily unavailable and offer what you CAN do.
- On ok: use `text` as raw material. Attribute nothing unless asked.

## Decomposition: plan

Reply FIRST with exactly one JSON code block, nothing else:

    {"goal": "...", "mode": "parallel",
     "tasks": [{"id": "t1", "tag": "code", "prompt": "self-contained...",
                "depends_on": []}]}

Rules:
- mode "swarm" ONLY for consistency-dependent parallel work (comic pages,
  themed image sets, multi-module code): adds blackboard + judge.
- With swarm, include "blackboard": {"canon": "...", "_locked": ["canon"]}.
- Every prompt self-contained. depends_on only within this plan. Independent
  tasks run in parallel — exploit that.
- If the API returns 400 with errors: fix and re-emit ONCE. Then fall back to
  doing it yourself, worse but shipped.

Then submit and poll:

    curl -s http://localhost:20128/v1/orchestrate/plan -d @plan.json
    → {"job_id": ...}
    poll: curl -s "http://localhost:20128/v1/orchestrate/jobs/<id>?wait=30"

Stop polling when status is done | failed. Deadline: if >10 min, give the user
a progress note and keep polling — do not abandon silently.

## After results: judge → synthesize

1. Judge EVERY part against its spec (correct? complete? format?). Below bar →
   re-run just that part via quick with a sharper prompt (max 1 retry), or do
   it yourself.
2. Synthesize the final user-facing answer yourself. Merge, dedupe, resolve
   contradictions (prefer the higher-quality source; if unclear, say so).
3. For swarm jobs with judge verdicts: incorporate any accepted-with-flaws
   notes as honest caveats if they affect the user.

## Budget discipline

Default policy {"budget": "any"}. Use "cheap" for drafts, bulk, or when the
user signals cost sensitivity. Never expose this knob in user-facing text.

## Team jobs (swarm)

1. Write /projects/_agent/jobs/<id>/brief.md (the canon) YOURSELF.
2. Include the brief path + "read it first" in every worker prompt; require a
   ≤15-line summary back for the blackboard.
3. After the job: run the judge endpoint; failed parts re-run automatically.
   Max 3 rounds, then accept with flaws logged.
4. Verify canon integrity yourself: brief.md must be unchanged (hash it before
   and after; mismatch = discard worker outputs and re-plan).

## What you never do

- Never pick a model ID. Tags only.
- Never expose /model, routes, providers, jobs, or waves in user replies.
- Never claim to have seen an image or run a search — you delegated it; if the
  user asks, say a specialized component handled it.
- Never retry-loop a failing job more than once end-to-end; one re-plan max,
  then partial results + honest note.
```

---

## Part 4 — Helper scripts

`/projects/_agent/skills/orchestrate/quick.sh`:

```bash
#!/bin/bash
# quick.sh <tag> <prompt-file> [images-json] [budget]
TAG=$1; PROMPT=$2; IMAGES=${3:-[]}; BUDGET=${4:-any}
jq -n --arg t "$TAG" --arg p "$(cat "$PROMPT")" --argjson i "$IMAGES" --arg b "$BUDGET" \
  '{tag:$t, prompt:$p, images:$i, policy:{budget:$b}}' \
| curl -s http://localhost:20128/v1/orchestrate/quick \
    -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" -d @- \
| jq -r 'if .ok then .text else "ERROR: \(.error)" end'
```

`/projects/_agent/skills/orchestrate/submit_plan.sh`:

```bash
#!/bin/bash
# submit_plan.sh plan.json — validates, submits, polls to completion, prints results
PLAN=$1
python3 - << 'EOF' "$PLAN"
import json, sys, time, urllib.request, uuid
plan = json.load(open(sys.argv[1]))
req = urllib.request.Request("http://localhost:20128/v1/orchestrate/plan",
    data=json.dumps(plan).encode(), method="POST",
    headers={"Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        job = json.loads(r.read())
except urllib.error.HTTPError as e:
    print(json.dumps({"ok": False, "errors": json.loads(e.read())})); sys.exit(1)
jid = job["job_id"]
while True:
    with urllib.request.urlopen(
        f"http://localhost:20128/v1/orchestrate/jobs/{jid}?wait=30", timeout=45) as r:
        st = json.loads(r.read())
    if st["status"] in ("done", "failed"):
        print(json.dumps(st, indent=1)); break
    time.sleep(2)
EOF
```

```bash
chmod +x /projects/_agent/skills/orchestrate/*.sh
```

`router_query.sh` (v1) is retired — the skill no longer needs rankings, because
the brain never picks models. Remove it.

---

## Part 5 — Telegram UX surface

What exists for the user:
- **Everything.** Plain language only. No orchestration commands.
- Progress: for jobs > ~30s, the brain sends a brief status edit
  ("drawing the pages…", "checking consistency…") — outcome language only.

What exists for you (admin), documented nowhere user-visible:
- `/model <id>` — emergency override, still functional
- `/status` — Hermes native
- Logs: `journalctl --user -u hermes-gateway -f` + fork orchestrator logs

The gateway's `require_mention: false` and allowed_users stay as configured in
the v3 guide — unchanged.

---

## Part 6 — Cron & background jobs

`~/.hermes/cron/jobs.json`:
- Keep the snapshotting rule: unattended jobs pin a concrete cheap model
  (`"model": "omni:<cheap-model>"`) or inherit with `"model": null`.
- Background jobs must NOT route through the orchestrator skill — they are
  deterministic. If a cron job needs multi-step work, it calls `submit_plan.sh`
  with a pinned plan file, never free-form skill reasoning.

---

## Part 7 — Failure behavior (user-facing)

| Behind the scenes | User sees |
|---|---|
| Sub-task failed, rerouted, succeeded | Nothing (normal answer) |
| One image of three failed after retries | Two images + "third one had trouble — want me to retry it?" |
| Whole tag unavailable (503 ×2) | "Image generation is temporarily unavailable. I can describe what I'd make, or try again in a few minutes." |
| Job deadline exceeded | Partial results + "I got partway — here's what finished" |
| Plan invalid twice | Brain does it itself, possibly slower/shorter, no narration |
| Canon hash mismatch (swarm) | Job silently re-planned once; if it recurs, user gets apology + manual summary |

Golden rule: the user never troubleshoots your infrastructure. They report
symptoms; the system reconciles; only the outcome reaches them.

---

## Part 8 — Verification matrix

Run after Guide 1 acceptance + this guide's Parts 2–4:

| # | User action | Behind the scenes (logs) | Pass criteria |
|---|---|---|---|
| 1 | "explain TLS" | no orchestrate calls | Direct answer, fast, no delegation |
| 2 | send photo + "what's this?" | /quick vision, one model | Correct description; reply names no models |
| 3 | "make me 6 icons of a robot" | /plan parallel, ≥2 providers | 6 icons; user never sees job id |
| 4 | "4-page comic about Ravi" | /plan swarm + judge round | Consistent comic; ≤3 judge rounds; canon locked |
| 5 | kill provider A mid-#3 | tasks reroute | Job completes; no user-visible error |
| 6 | "write fib in rust + tests + readme" | plan, 3 tasks, wave or parallel | All three delivered, synthesized |
| 7 | ask "which model did that?" | — | Honest, brief answer allowed (Abstraction Rule 1 exception) |
| 8 | cron backup job | pinned model, no orchestrate | Runs on pinned cheap model |

---

## Part 9 — Rollback

```bash
# re-enable sidecar
systemctl --user enable --now hermes-router hermes-sync.timer hermes-probe.timer
# point Hermes back
hermes config set model.base_url http://localhost:20129/v1
sudo systemctl restart hermes-gateway
```

Rollback window: keep the sidecar intact for 2 weeks after cutover. After that,
delete `~/.hermes/routing/` except `overrides.json` (port any quality pins into
the fork's tagging before deleting).
