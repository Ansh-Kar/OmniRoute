import { NextResponse } from "next/server";
import { providerBreakerOpen } from "@/lib/harness/breakerFeed";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import {
  chatDispatchFor,
  jobFromPlan,
} from "@/lib/orchestrator/dispatch";
import {
  jobToApi,
  objectiveToPlanBody,
  runJob,
  validatePlan,
  type OrchestrateObjectiveBody,
} from "@omniroute/open-sse/services/harness/orchestrator.ts";

/**
 * POST /api/v1/orchestrate/objectives — B10, the Hermes surface (OpenResearch
 * adaptation). The caller names an OBJECTIVE (what it wants accomplished),
 * not models, not tags: subtasks are optional (absent → the objective is the
 * single task), per-task tags are optional (inferred from each prompt by the
 * classifier's stage-1 heuristics and logged), and `caller_model` names the
 * calling agent so the bias guard can avoid routing sub-agent work to the
 * caller's own model while a tag-viable alternative exists.
 *
 *   {"objective": "Build and verify a JWT auth module",
 *    "subtasks": [{"prompt": "Write the token issuer"},     // tag inferred
 *                 {"prompt": "…", "tag": "code"}],          // explicit wins
 *    "caller_model": "gpt-4o",
 *    "policy": {"scheduling": "stream", "max_rounds": 3}}
 *   → 202 {"ok": true, "job_id": "job_…", "status": "active",
 *          "accepted": 2, "inferred_tags": {"t1": "code"}}
 *
 * Same runner, store, admission semantics, and response shape as
 * /v1/orchestrate/plan — this is the same machine with the caller-facing
 * vocabulary moved from "tagged plan" to "objective + optional decomposition".
 * Idempotency-Key replays return the ORIGINAL job, never re-execute.
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

  // Objective → plan body, then the ONE admission path (validatePlan).
  const { plan, errors: shapeErrors } = objectiveToPlanBody(raw as OrchestrateObjectiveBody);
  if (!plan) {
    return NextResponse.json({ ok: false, errors: shapeErrors }, { status: 400 });
  }
  const validation = validatePlan(plan);
  if (!validation.ok) {
    return NextResponse.json({ ok: false, errors: validation.errors }, { status: 400 });
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    const existing = store.findByIdempotencyKey(idempotencyKey);
    if (existing) {
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

  // Fire the runner in the background; the 202 returns immediately.
  void runJob(job.jobId, {
    store,
    dispatch: chatDispatchFor(request, job.jobId),
    breakerOpen: providerBreakerOpen,
  }).catch(() => {
    try {
      store.setJobStatus(job.jobId, "failed", "runner crashed");
    } catch {
      // Store gone (test teardown) — nothing more to do.
    }
  });

  return NextResponse.json(
    {
      ok: true,
      job_id: job.jobId,
      status: "active",
      accepted: job.tasks.length,
      inferred_tags: Object.fromEntries(validation.inferredTags.map((entry) => [entry.id, entry.tag])),
      caller_model: job.callerModel,
      bias_guard: job.policy.bias_guard,
      scheduling: job.policy.scheduling,
    },
    { status: 202 }
  );
}
