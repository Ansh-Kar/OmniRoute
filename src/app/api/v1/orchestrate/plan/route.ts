import { NextResponse } from "next/server";
import { providerBreakerOpen } from "@/lib/harness/breakerFeed";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import {
  chatDispatchFor,
  jobFromPlan,
  validatePlan,
} from "@/lib/orchestrator/dispatch";
import { jobToApi, runJob } from "@omniroute/open-sse/services/harness/orchestrator.ts";

/**
 * POST /api/v1/orchestrate/plan — batch execution, asynchronous (harness B3,
 * Guide 1 Part 6). The brain (Guide 2) decomposes a goal into tagged,
 * dependency-ordered tasks; the orchestrator runs them as parallel waves
 * through the existing routing path and keeps every transition in the job
 * log. 202 immediately; poll GET /v1/orchestrate/jobs/{id}?wait=30.
 *
 *   {"goal": "…", "mode": "parallel",
 *    "tasks": [{"id": "t1", "tag": "code", "prompt": "…", "depends_on": []}],
 *    "policy": {"max_attempts": 3, "deadline_s": 600, "budget": "any"}}
 *   → 202 {"ok": true, "job_id": "job_…", "status": "active", "accepted": 1}
 *
 * Admission validation (guide: replaces validate_plan.py): unknown tags,
 * duplicate ids, dangling depends_on, cycles, empty tasks → 400 with
 * per-task errors — the brain re-emits the plan once, corrected.
 * Idempotency-Key replays return the ORIGINAL job without re-executing.
 * mode "swarm" (B3.5): prompts are wrapped with the shared blackboard
 * context, worker summaries merge back (locked keys protected), bounded
 * @ask questions are relayed, and a judge pass re-queues inconsistent
 * parts with feedback up to policy.max_rounds — then accepts with flaws.
 */

const store = new SqliteJobsStore();

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request: Request) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, errors: ["Invalid JSON body"] }, { status: 400 });
  }

  const validation = validatePlan(raw as Record<string, unknown>);
  if (!validation.ok) {
    return NextResponse.json({ ok: false, errors: validation.errors }, { status: 400 });
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    const existing = store.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      // Guide Part 6: replay returns the original job/result, never re-executes.
      return NextResponse.json({ ...jobToApi(existing), replayed: true }, { status: 200 });
    }
  }

  const job = jobFromPlan(validation, idempotencyKey);
  const created = store.createJob(job, idempotencyKey);
  if (created === "conflict") {
    const existing = idempotencyKey ? store.findByIdempotencyKey(idempotencyKey) : null;
    return NextResponse.json(
      existing ? { ...jobToApi(existing), replayed: true } : { ok: false, errors: ["idempotency conflict"] },
      { status: 200 }
    );
  }

  // Fire the wave loop in the background; the 202 returns immediately.
  void runJob(job.jobId, {
    store,
    dispatch: chatDispatchFor(request, job.jobId),
    // B9 breaker feed: the allocator's 0.2 multiplier now reads the same
    // provider-keyed breaker registry the chat pipeline consults.
    breakerOpen: providerBreakerOpen,
  }).catch(() => {
    try {
      store.setJobStatus(job.jobId, "failed", "runner crashed");
    } catch {
      // Store gone (test teardown) — nothing more to do.
    }
  });

  return NextResponse.json(
    { ok: true, job_id: job.jobId, status: "active", accepted: job.tasks.length },
    { status: 202 }
  );
}
