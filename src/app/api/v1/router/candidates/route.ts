import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { getModelTagIndex } from "@omniroute/open-sse/services/modelTags/index.ts";
import { classifyRequest } from "@omniroute/open-sse/services/harness/classifier.ts";
import { makeSelfFetchEmbedder } from "@/lib/harness/embedder";
import {
  buildModelDescriptors,
  ensureRegistryFresh,
  filterCandidates,
  rankCandidates,
  rankedToApi,
  REGISTRY_STALENESS_GUIDANCE,
  registryVersionInfo,
  selfAssess,
  taskProfile,
  type CandidateFilter,
} from "@omniroute/open-sse/services/harness/capabilityRegistry.ts";

/**
 * GET/POST /api/v1/router/candidates — B12, the layered capability router's
 * Hermes-facing surface:
 *
 *   Task → Capability filter (hard elimination) → Ranking (unified score)
 *   → PRIMARY / SECONDARY / FALLBACK tiers, ALL candidates retained.
 *
 * The brain gets the full filtered list with per-dimension metadata
 * (capabilities, specializations, benchmarks, operational, reliability) so
 * it can exercise contextual judgment — "Qwen-VL normally wins OCR, but
 * this image is a UI screenshot and Model C has better UI understanding" —
 * while the tiers say what the deterministic router would try first.
 *
 *   POST {"prompt": "read the error from this screenshot", "modality": "image",
 *         "tool_calling": true, "caller_model": "gpt-4o", "top": 3}
 *   → 200 {task: {type, modality}, filter: {eliminated}, tiers: {primary,
 *          secondary, fallback}, candidates: [...ranked, with breakdowns...],
 *          self: {rank, score, would_win, status}}
 *
 * `self` is the equal-scoring rule: the caller's own model is ranked by the
 * IDENTICAL unified score — no bonus, no penalty. would_win=true means it
 * legitimately won; status "filtered"/"unregistered" says why it's absent.
 * Ranking multiplies EMPIRICAL per-(model × category) success from the jobs
 * store (closed loop), not just benchmarks.
 */
const store = new SqliteJobsStore();

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

async function handle(request: NextRequest, body: Record<string, unknown> | null) {
  const params = body ?? Object.fromEntries(new URL(request.url).searchParams.entries());

  // Prompt → classify (task type + implied modality); explicit params win.
  let taskType: string | undefined;
  let taskModality: string | undefined;
  let complexity: "fast" | "deep" | null = null;
  if (typeof params.prompt === "string" && params.prompt.trim()) {
    // B14: the same classifier ladder as /v1/harness/classify — stage 1
    // heuristics, then (low-confidence only) one embeddings call against
    // exemplar centroids via the provider /v1/embeddings surface. No model
    // stage here: the router path stays non-generative. Opt out with
    // use_embeddings=false; pin a model with embedding_model.
    const classification = await classifyRequest(
      { messages: [{ role: "user", content: params.prompt }] },
      {
        embed:
          params.use_embeddings === false
            ? undefined
            : makeSelfFetchEmbedder({
                incoming: request,
                model: typeof params.embedding_model === "string" && params.embedding_model.trim() ? params.embedding_model.trim() : undefined,
              }),
      }
    );
    taskType = classification.type;
    complexity = classification.complexity;
    if (classification.modalities.includes("vision")) taskModality = "image";
  }
  const requestedModality = typeof params.modality === "string" ? params.modality : undefined;
  const specialization = typeof params.specialization === "string" && params.specialization.trim() ? params.specialization.trim() : undefined;
  const category = typeof params.category === "string" && params.category.trim() ? params.category.trim() : taskType;
  const capability = typeof params.capability === "string" && params.capability.trim() ? params.capability.trim() : undefined;
  const toolCalling = params.tool_calling === true || params.tool_calling === "true" ? true : undefined;
  const minContext = Number.isFinite(Number(params.min_context)) && Number(params.min_context) > 0 ? Math.floor(Number(params.min_context)) : undefined;
  const top = Number.isFinite(Number(params.top)) && Number(params.top) > 0 ? Math.min(16, Math.floor(Number(params.top))) : 3;
  const callerModel = typeof params.caller_model === "string" && params.caller_model.trim() ? params.caller_model.trim() : null;

  const filter: CandidateFilter = {
    modality: (requestedModality ?? taskModality) as CandidateFilter["modality"],
    capability,
    tool_calling: toolCalling,
    min_context: minContext,
  };
  // Filter only with rules that were actually set (undefined = no rule).
  const activeFilter: CandidateFilter = {};
  if (filter.modality !== undefined) activeFilter.modality = filter.modality;
  if (filter.capability !== undefined) activeFilter.capability = filter.capability;
  if (filter.tool_calling !== undefined) activeFilter.tool_calling = filter.tool_calling;
  if (filter.min_context !== undefined) activeFilter.min_context = filter.min_context;

  // B13: refresh-on-stale (> 6h since the last rebuild — deprecated models
  // drop out with the rebuild) and stamp the response so Hermes never
  // decides on unknowingly stale data.
  ensureRegistryFresh();

  const index = getModelTagIndex();
  const descriptors = buildModelDescriptors({
    entries: index.entries,
    stats: store.aggregateModelStats(),
    statsByCategory: store.aggregateModelStatsByCategory(),
  });
  const { candidates, eliminated } = filterCandidates(descriptors, activeFilter);
  const ranked = rankCandidates(
    candidates,
    { specialization, category: category ?? undefined },
    top
  );
  const eliminatedDescriptors = descriptors.filter((d) => !candidates.includes(d));
  const self = callerModel ? selfAssess(callerModel, ranked, eliminatedDescriptors) : null;
  const profile = taskProfile(
    ranked,
    { domain: specialization ?? category ?? taskType ?? null, complexity, input: (requestedModality ?? taskModality) ?? (taskType === "image_gen" ? "image" : null) },
    self
  );

  return NextResponse.json(
    {
      ok: true,
      advisory: "routing suggestions are advisory — the judgment stays with you",
      guidance: REGISTRY_STALENESS_GUIDANCE,
      registry: registryVersionInfo(),
      profile,
      task: { type: taskType ?? null, modality: (requestedModality ?? taskModality) ?? null, specialization: specialization ?? null, category: category ?? null },
      filter: { ...activeFilter, pool: descriptors.length, eliminated, candidates: candidates.length },
      tiers: {
        primary: ranked.filter((candidate) => candidate.tier === "primary").map((candidate) => candidate.descriptor.id),
        secondary: ranked.filter((candidate) => candidate.tier === "secondary").map((candidate) => candidate.descriptor.id),
        fallback: ranked.filter((candidate) => candidate.tier === "fallback").map((candidate) => candidate.descriptor.id),
      },
      candidates: ranked.map(rankedToApi),
      self,
    },
    { status: 200 }
  );
}

export async function GET(request: NextRequest) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;
  return handle(request, null);
}

export async function POST(request: NextRequest) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request", details: ["Invalid JSON body"] }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "invalid_request", details: ["Body must be an object"] }, { status: 400 });
  }
  return handle(request, raw as Record<string, unknown>);
}
