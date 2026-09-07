import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { chatDispatchFor } from "@/lib/orchestrator/dispatch";
import { runJob } from "@omniroute/open-sse/services/harness/orchestrator.ts";

/**
 * POST /api/v1/orchestrate/jobs/{job_id}/judge — trigger or advance the
 * consistency pass (harness B3.5, Guide 1 Part 6). Body:
 *   {"kind": "consistency", "spec_key": "canon", "check": "…"}
 * Runs one judge round in the background: verdicts are written to
 * tasks.verdict; failed tasks re-queue with the verdict injected into their
 * prompt (up to policy.max_rounds, after which flaws are accepted and
 * logged). Single-runner semantics: rejected while a run is already active.
 */

const store = new SqliteJobsStore();
const advancing = new Set<string>();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const { jobId } = await params;
  const job = store.getJob(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: "unknown_job", job_id: jobId }, { status: 404 });
  }
  if (job.mode !== "swarm") {
    return NextResponse.json(
      { ok: false, error: "not_a_swarm_job", job_id: jobId },
      { status: 400 }
    );
  }
  if (job.status === "active" || job.status === "judging" || advancing.has(jobId)) {
    return NextResponse.json(
      { ok: false, error: "job_still_running", job_id: jobId },
      { status: 409 }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  // Re-open the job for one more judge cycle: requeue nothing, just resume
  // the judge loop (the runner re-runs waves only if the judge fails parts).
  advancing.add(jobId);
  store.setJobStatus(jobId, "active", null);
  void runJob(jobId, {
    store,
    dispatch: chatDispatchFor(request),
    judgeCheck: typeof body.check === "string" && body.check.trim() ? body.check.trim() : undefined,
  })
    .catch(() => {
      try {
        store.setJobStatus(jobId, "failed", "judge advance crashed");
      } catch {
        // Store gone — nothing more to do.
      }
    })
    .finally(() => advancing.delete(jobId));
  return NextResponse.json(
    { ok: true, job_id: jobId, status: "active", check: typeof body.check === "string" ? body.check : null },
    { status: 202 }
  );
}
