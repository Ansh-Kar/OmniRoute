import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";

/**
 * GET /api/v1/orchestrate/jobs/{job_id}/blackboard — current snapshot plus
 * the history of appends (who wrote what; harness B3.5, Guide 1 Part 6).
 * The snapshot is harness-written only: worker summaries and mailbox
 * answers; locked keys are marked in _locked and never worker-touched.
 */

const store = new SqliteJobsStore();

export async function GET(
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

  const history = job.log
    .filter((entry) => entry.event === "blackboard_append" || entry.event === "mailbox_relayed")
    .map((entry) => ({
      timestamp: entry.timestamp,
      task_id: entry.taskId,
      kind: entry.event === "blackboard_append" ? "summary" : "mailbox",
      detail: entry.detail,
    }));

  return NextResponse.json({
    job_id: jobId,
    blackboard: job.blackboard ?? {},
    history,
  });
}
