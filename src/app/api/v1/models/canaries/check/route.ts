import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";

/**
 * POST /api/v1/models/canaries/check — run ONE canary round now (harness
 * B8): probe each provider behind the tag index's current candidates for
 * HTTP reachability (any status answer = alive; DNS/refused/timeout =
 * failure), apply the conservative dead rules (2 consecutive failures;
 * stale verdicts stop filtering), and return the round summary plus the
 * resulting skip list. Rankings consult the state on every retrieval —
 * this endpoint is the operator's manual trigger (cron/canary loops can
 * call it on a schedule; no background timer runs uninvited).
 *
 *   ?limit=N   bound the round (default 12, max 40) — round-robin over
 *              the index's per-category heads so each round covers
 *              different providers instead of re-probing the same head.
 */
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

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(Math.floor(Number(searchParams.get("limit") ?? 12)) || 12, 1), 40);

  try {
    const [{ getModelTagIndex }, canary, { REGISTRY }] = await Promise.all([
      import("@omniroute/open-sse/services/modelTags/liveIndex.ts"),
      import("@omniroute/open-sse/services/modelTags/canary.ts"),
      import("@omniroute/open-sse/config/providerRegistry.ts"),
    ]);
    const index = getModelTagIndex();

    // Round-robin candidate selection: one model per provider per round,
    // cycling providers, so successive rounds widen coverage.
    const byProvider = [...index.byProvider.keys()];
    const seenProviders = new Set<string>();
    const candidates: Array<{ id: string; provider: string }> = [];
    for (const entry of index.entries) {
      if (candidates.length >= limit) break;
      if (seenProviders.has(entry.provider)) continue;
      seenProviders.add(entry.provider);
      candidates.push({ id: entry.id, provider: entry.provider });
    }
    if (candidates.length < limit) {
      for (const entry of index.entries) {
        if (candidates.length >= limit) break;
        if (candidates.some((candidate) => candidate.id === entry.id)) continue;
        candidates.push({ id: entry.id, provider: entry.provider });
      }
    }

    const probe = canary.makeHttpCanaryProbe((provider) => {
      const entry = REGISTRY[provider];
      return entry?.baseUrl ?? entry?.baseUrls?.[0] ?? null;
    });
    const summary = await canary.runCanaryRound(candidates, probe);

    return NextResponse.json({
      object: "canary_round",
      ...summary,
      dead_now: canary.deadModelIds(),
      note:
        byProvider.length > candidates.length
          ? `covered ${candidates.length} of ${byProvider.length} providers — call again to rotate`
          : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: { message: `canary round failed: ${error instanceof Error ? error.message : "unknown"}` } },
      { status: 500 }
    );
  }
}
