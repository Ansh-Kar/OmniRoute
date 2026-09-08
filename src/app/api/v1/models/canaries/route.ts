import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";

/**
 * GET /api/v1/models/canaries — the liveness-canary snapshot (harness B8,
 * roadmap §6): per-model {alive, lastCheckAt, latencyMs, failures, error}
 * plus the fresh dead list that rankings currently skip. Read-only,
 * process-local — the state exists only after canary rounds have run
 * (POST /check or an operator-driven runner); an empty snapshot means
 * "no canary data", never "everything is dead".
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request: Request) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const { getCanarySnapshot, deadModelIds, CANARY_DEAD_THRESHOLD, CANARY_FRESHNESS_MS } = await import(
    "@omniroute/open-sse/services/modelTags/canary.ts"
  );
  const snapshot = getCanarySnapshot();
  const dead = deadModelIds();
  return NextResponse.json({
    object: "canary_snapshot",
    config: {
      dead_threshold: CANARY_DEAD_THRESHOLD,
      freshness_ms: CANARY_FRESHNESS_MS,
    },
    tracked: Object.keys(snapshot).length,
    dead_now: dead,
    models: snapshot,
  });
}
