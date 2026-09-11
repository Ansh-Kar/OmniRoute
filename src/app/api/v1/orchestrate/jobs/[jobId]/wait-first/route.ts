import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { jobToApi } from "@omniroute/open-sse/services/harness/orchestrator.ts";

/**
 * GET /api/v1/orchestrate/jobs/{job_id}/wait-first — B10, the per-completion
 * wake (OpenResearch's `orx exp wait`): long-polls until the FIRST task
 * reaches a terminal state SINCE THE CALL STARTED (or the whole job goes
 * terminal, or the wait budget expires), then returns the FULL job view.
 *
 * The wake is a signal, NOT the source of truth — exactly their loop
 * discipline: a task that finished while you were analyzing the previous one
 * will not be reported by the next call's `completed_since`, so re-read the
 * complete task list every wake and reconcile against what you have handled.
 *
 *   GET …/jobs/job_x/wait-first?timeout=30
 *   → 200 {…full jobToApi…, "completed_since": ["t2"], "drained": false}
 *   → 200 {…, "completed_since": ["t3"], "drained": true}   job terminal
 *
 * `drained` (job terminal) is the loop's exit condition — stop calling.
 * 500ms ticks, timeout capped at 60s; timeout=0 → immediate snapshot.
 */
const store = new SqliteJobsStore();

const TICK_MS = 500;
const MAX_TIMEOUT_S = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const { jobId } = await params;
  const timeoutSeconds = clampTimeout(new URL(request.url).searchParams.get("timeout"));

  const deadlineMs = Date.now() + timeoutSeconds * 1000;

  // Baseline: tasks already terminal when the call started. Only NEW
  // terminal arrivals wake the caller.
  const initial = store.getJob(jobId);
  if (!initial) {
    return NextResponse.json({ ok: false, error: "unknown_job", job_id: jobId }, { status: 404 });
  }
  const baseline = new Set(
    initial.tasks.filter((task) => task.state === "done" || task.state === "failed").map((task) => task.id)
  );

  for (;;) {
    const job = store.getJob(jobId);
    if (!job) {
      return NextResponse.json({ ok: false, error: "unknown_job", job_id: jobId }, { status: 404 });
    }
    const completedSince = job.tasks
      .filter((task) => (task.state === "done" || task.state === "failed") && !baseline.has(task.id))
      .map((task) => task.id);
    const jobTerminal = job.status === "done" || job.status === "failed";
    if (jobTerminal) {
      return NextResponse.json({ ...jobToApi(job), completed_since: completedSince, drained: true }, { status: 200 });
    }
    if (completedSince.length > 0 || Date.now() >= deadlineMs) {
      return NextResponse.json({ ...jobToApi(job), completed_since: completedSince, drained: false }, { status: 200 });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

function clampTimeout(value: string | null): number {
  if (value === null) return 0;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_TIMEOUT_S);
}
