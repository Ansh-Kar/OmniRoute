import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { jobToApi } from "@omniroute/open-sse/services/harness/orchestrator.ts";

/**
 * GET /api/v1/orchestrate/jobs/{job_id} — job status (harness B3, Guide 1
 * Part 6): status active|judging|done|failed, per-wave task lists, per-task
 * state/model/latency/attempts, and the tail of the job log (the audit
 * trail). `?wait=30` long-polls (500ms ticks, capped at 60s) so the brain
 * can cut chatter per the guide's polling guidance. 404 for unknown jobs —
 * the brain falls back to self-execution.
 */

const store = new SqliteJobsStore();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const { jobId } = await params;
  const waitSeconds = clampWait(new URL(request.url).searchParams.get("wait"));

  for (;;) {
    const job = store.getJob(jobId);
    if (!job) {
      return NextResponse.json(
        { ok: false, error: "unknown_job", job_id: jobId },
        { status: 404 }
      );
    }
    if (job.status === "done" || job.status === "failed" || waitSeconds === 0) {
      return NextResponse.json(jobToApi(job), { status: 200 });
    }
    // Long-poll: wait for a terminal status or the wait budget to expire.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function clampWait(value: string | null): number {
  if (value === null) return 0;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 60);
}
