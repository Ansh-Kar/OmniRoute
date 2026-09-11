import { NextResponse } from "next/server";
import { providerBreakerOpen } from "@/lib/harness/breakerFeed";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { chatDispatchFor, jobFromPlan } from "@/lib/orchestrator/dispatch";
import {
  jobToApi,
  runJob,
  spawnToPlanBody,
  validatePlan,
  type OrchestrateSpawnBody,
} from "@omniroute/open-sse/services/harness/orchestrator.ts";

/**
 * POST /api/v1/orchestrate/spawn — B10, the `orx agent spawn` analog:
 * delegate an independent task to a helper JOB. The helper gets a
 * self-contained brief (it cannot see the parent's tasks or results — only
 * the explicit `context` object, copied verbatim), runs as its own job with
 * its own runner, and the caller wakes on completion via
 * GET /v1/orchestrate/wait?job_ids=…
 *
 *   {"parent_job_id": "job_…", "brief": "Survey the auth codebase and report
 *    the current token flow. Constraint: read-only. Output: a 10-line
 *    summary.", "caller_model": "gpt-4o"}
 *   → 202 {"ok": true, "job_id": "job_…", "parent_job_id": "job_…",
 *          "status": "active", "in_flight": 1}
 *   → 409 {"error": "spawn_nesting"}     a helper cannot spawn (depth 1)
 *   → 429 {"error": "spawn_cap", …}      parent at policy.max_children active helpers
 *
 * The bias guard PROPAGATES: the child inherits the parent's caller_model
 * (unless overridden), so a delegated helper also avoids the caller's model.
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
  const body = raw as OrchestrateSpawnBody;

  const parentJobId = typeof body.parent_job_id === "string" ? body.parent_job_id : "";
  if (!parentJobId) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", details: ["parent_job_id must be a non-empty string"] },
      { status: 400 }
    );
  }
  const parent = store.getJob(parentJobId);
  if (!parent) {
    return NextResponse.json({ ok: false, error: "unknown_parent", parent_job_id: parentJobId }, { status: 404 });
  }
  // No nesting — orx's "a spawned session cannot spawn another helper".
  if (parent.parentJobId !== null) {
    return NextResponse.json(
      {
        ok: false,
        error: "spawn_nesting",
        details: ["a helper job cannot spawn its own helper (depth 1); wait for the parent or spawn from a top-level job"],
      },
      { status: 409 }
    );
  }
  // In-flight cap — orx's "the CLI enforces the number of helpers a session
  // may have in flight". ACTIVE children count; terminal ones free the slot.
  const children = store.listChildJobs(parentJobId);
  const activeChildren = children.filter((child) => child.status === "active" || child.status === "judging");
  const maxChildren = parent.policy.max_children ?? 4;
  if (activeChildren.length >= maxChildren) {
    return NextResponse.json(
      {
        ok: false,
        error: "spawn_cap",
        details: [`parent has ${activeChildren.length} active helper job(s); cap is ${maxChildren} (policy.max_children)`],
        active_children: activeChildren.map((child) => child.jobId),
      },
      { status: 429 }
    );
  }

  const { plan, errors: shapeErrors } = spawnToPlanBody(body, parent);
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

  const job = jobFromPlan(validation, idempotencyKey, parentJobId);
  const created = store.createJob(job, idempotencyKey);
  if (created === "conflict") {
    const existing = idempotencyKey ? store.findByIdempotencyKey(idempotencyKey) : null;
    return NextResponse.json(
      existing ? { ...jobToApi(existing), replayed: true } : { ok: false, errors: ["idempotency conflict"] },
      { status: 200 }
    );
  }

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
      parent_job_id: parentJobId,
      status: "active",
      in_flight: activeChildren.length + 1,
      cap: maxChildren,
      caller_model: job.callerModel,
    },
    { status: 202 }
  );
}
