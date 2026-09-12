import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { refreshRegistry } from "@omniroute/open-sse/services/harness/capabilityRegistry.ts";
import { getModelTagIndex } from "@omniroute/open-sse/services/modelTags/index.ts";

/**
 * POST /api/v1/router/refresh — B13: force a registry refresh NOW. Resets
 * the tag-index cache and rebuilds from the live provider/model registry:
 * new models appear, DEPRECATED MODELS ARE DELETED (the rebuild contains
 * only what exists now — stale entries never linger), and the registry
 * version is re-stamped. The candidates route also self-refreshes when
 * stale (> 6h); this is the manual override (cron/worker friendly).
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request: NextRequest) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const version = refreshRegistry();
  const index = getModelTagIndex();
  return NextResponse.json(
    {
      ok: true,
      registry: version,
      models: index.entries.length,
      providers: index.byProvider.size,
      note: "rebuilt from the live provider registry; deprecated models removed",
    },
    { status: 200 }
  );
}
