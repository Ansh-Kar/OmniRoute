import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { jobToApi } from "@omniroute/open-sse/services/harness/orchestrator.ts";

/**
 * GET /api/v1/orchestrate/wait?job_ids=a,b,c — B10, the multi-job wake
 * (OpenResearch's `orx exp wait --project`): long-polls until the FIRST job
 * among the given ids reaches a terminal state (done|failed) since the call
 * started, then returns that job's full view plus a state map of the rest.
 *
 * The spawn companion: launch helper jobs, then loop on this endpoint —
 * one wake per completed helper, reconcile everything else from the map.
 *
 *   GET /v1/orchestrate/wait?job_ids=job_a,job_b&timeout=30
 *   → 200 {"ok": true, "woken": "job_b", "job": {…full jobToApi…},
 *          "states": {"job_a": "active", "job_b": "failed"},
 *          "drained": false}
 *   → 200 {"ok": true, "woken": null, "job": null,
 *          "states": {"job_a": "active", "job_b": "failed"},
 *          "drained": true}    every job already terminal at call start
 *
 * `drained` (nothing left to wait for) is the exit condition. Unknown ids are
 * reported as "unknown" in the states map, not 404 — a helper list that
 * outlives store retention should drain, not wedge the caller.
 * 500ms ticks, timeout capped at 60s; timeout=0 → immediate snapshot.
 */
const store = new SqliteJobsStore();

const TICK_MS = 500;
const MAX_TIMEOUT_S = 60;

export async function GET(request: NextRequest) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const url = new URL(request.url);
  const timeoutSeconds = clampTimeout(url.searchParams.get("timeout"));
  const jobIds = (url.searchParams.get("job_ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (jobIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", details: ["job_ids must be a comma-separated list of job ids"] },
      { status: 400 }
    );
  }

  const deadlineMs = Date.now() + timeoutSeconds * 1000;

  const readStates = (): { states: Record<string, string>; firstTerminal: string | null } => {
    const states: Record<string, string> = {};
    let firstTerminal: string | null = null;
    for (const id of jobIds) {
      const job = store.getJob(id);
      if (!job) {
        states[id] = "unknown";
      } else {
        states[id] = job.status;
        if (firstTerminal === null && (job.status === "done" || job.status === "failed")) {
          firstTerminal = id;
        }
      }
    }
    return { states, firstTerminal };
  };

  // Baseline: jobs already terminal when the call started don't wake — only
  // NEW arrivals do (same discipline as wait-first).
  const { firstTerminal: baselineTerminal } = readStates();

  for (;;) {
    const { states, firstTerminal } = readStates();
    const anyLive = Object.values(states).some((state) => state === "active" || state === "judging");
    if (firstTerminal !== null && firstTerminal !== baselineTerminal) {
      const job = store.getJob(firstTerminal);
      return NextResponse.json(
        { ok: true, woken: firstTerminal, job: job ? jobToApi(job) : null, states, drained: !anyLive },
        { status: 200 }
      );
    }
    if (!anyLive || Date.now() >= deadlineMs) {
      const job = firstTerminal !== null ? store.getJob(firstTerminal) : null;
      return NextResponse.json(
        { ok: true, woken: firstTerminal, job: job ? jobToApi(job) : null, states, drained: !anyLive },
        { status: 200 }
      );
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
