import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { jobToApi } from "@omniroute/open-sse/services/harness/orchestrator.ts";
import { normalizeAppendTasks, taskRowsFromSpecs } from "@/lib/orchestrator/dispatch";

/**
 * POST /api/v1/orchestrate/jobs/{job_id}/tasks — B10 refill (OpenResearch's
 * "refill the freed slot"): append tasks to a RUNNING job. The runner (wave
 * or stream scheduling) picks them up on its next admission pass — under
 * stream scheduling a freed slot is refilled within one completion; under
 * wave scheduling they fire in the next wave. depends_on may reference tasks
 * already on the job; ids generate when absent; tags infer when absent.
 *
 *   POST …/jobs/job_x/tasks
 *   {"tasks": [{"prompt": "Now write the integration test for the winner",
 *               "depends_on": ["t1"]}]}
 *   → 202 {"ok": true, "job_id": "job_x", "status": "active",
 *          "appended": 1, "inferred_tags": {"t5": "code"}}
 *   → 409 {"error": "job_terminal"}   nothing is running to pick them up —
 *                                     spawn a new job (or a helper) instead
 *
 * Idempotency-Key replays return the current job view (appends are additive;
 * replay protection is per-request, mirroring the plan route's contract).
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const { jobId } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request", details: ["Invalid JSON body"] }, { status: 400 });
  }

  const job = store.getJob(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: "unknown_job", job_id: jobId }, { status: 404 });
  }

  const normalized = normalizeAppendTasks(raw as { tasks?: unknown }, job);
  if (!normalized.ok) {
    return NextResponse.json({ ok: false, error: "invalid_request", details: normalized.errors }, { status: 400 });
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    const existing = store.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return NextResponse.json({ ...jobToApi(existing), replayed: true }, { status: 200 });
    }
  }

  const rows = taskRowsFromSpecs(normalized.specs, jobId);
  const appended = store.appendTasks(jobId, rows);
  if (appended === null) {
    return NextResponse.json({ ok: false, error: "unknown_job", job_id: jobId }, { status: 404 });
  }
  if (appended === "job_terminal") {
    return NextResponse.json(
      {
        ok: false,
        error: "job_terminal",
        details: ["the job is no longer running; spawn a helper job or submit a new objective instead"],
      },
      { status: 409 }
    );
  }
  if (appended === "duplicate_id") {
    return NextResponse.json(
      { ok: false, error: "duplicate_id", details: ["a task id in the payload already exists on the job"] },
      { status: 409 }
    );
  }

  // Inferred tags are auditable from the log, same as creation-time ones.
  for (const inferred of normalized.inferred) {
    store.appendLog(
      { jobId, taskId: inferred.id, event: "tag_inferred", detail: `"${inferred.tag}" — ${inferred.reason}` },
      Date.now()
    );
  }
  store.appendLog({ jobId, taskId: null, event: "tasks_appended", detail: `${rows.length} task(s) appended` }, Date.now());

  return NextResponse.json(
    {
      ok: true,
      job_id: jobId,
      status: appended.status,
      appended: rows.length,
      inferred_tags: Object.fromEntries(normalized.inferred.map((entry) => [entry.id, entry.tag])),
    },
    { status: 202 }
  );
}
