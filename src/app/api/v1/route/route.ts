import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { SqliteJobsStore } from "@/lib/db/orchestrateJobs";
import { getModelTagIndex } from "@omniroute/open-sse/services/modelTags/index.ts";
import { classifyRequest } from "@omniroute/open-sse/services/harness/classifier.ts";
import { makeSelfFetchEmbedder } from "@/lib/harness/embedder";
import {
  buildModelDescriptors,
  candidateMatrixLines,
  filterCandidates,
  rankCandidates,
  ensureRegistryFresh,
} from "@omniroute/open-sse/services/harness/capabilityRegistry.ts";

/**
 * POST /api/v1/route — the routing guide §10 "Fast Routing API" (B16,
 * Phase 10): a COMPACT interface. {task, modalities, capabilities,
 * complexity} → {primary, secondary[], fallback[], confidence} (+ the
 * compact matrix when ?evidence=true). Deliberately thin: the same
 * capability filter + unified ranking as /v1/router/candidates, none of
 * the verbosity — "avoid returning the entire registry by default."
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

export async function POST(request: NextRequest) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: { message: "Body must be an object" } }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;
  const task = typeof body.task === "string" ? body.task : null;
  if (!task || !task.trim()) {
    return NextResponse.json({ error: { message: "Body needs a task (string)" } }, { status: 400 });
  }

  const wantsEvidence = new URL(request.url).searchParams.get("evidence") === "true" || body.evidence === true;

  // Classify (full ladder; explicit capabilities win).
  const classification = await classifyRequest(
    { messages: [{ role: "user", content: task }] },
    { embed: body.use_embeddings === false ? undefined : makeSelfFetchEmbedder({ incoming: request }) }
  );
  const explicitCapabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [];
  const modality = Array.isArray(body.modalities) && body.modalities.some((m) => m === "image") ? "image" : classification.modalities.includes("vision") ? "image" : undefined;
  const category = typeof body.task_type === "string" && body.task_type.trim() ? body.task_type.trim() : classification.type;

  ensureRegistryFresh();
  const index = getModelTagIndex();
  const descriptors = buildModelDescriptors({
    entries: index.entries,
    stats: store.aggregateModelStats(),
    statsByCategory: store.aggregateModelStatsByCategory(),
  });
  const filter: Record<string, unknown> = {};
  if (modality) filter.modality = modality;
  if (explicitCapabilities.length > 0) filter.capability = explicitCapabilities[0];
  if (typeof body.min_context === "number" && body.min_context > 0) filter.min_context = body.min_context;
  const { candidates } = filterCandidates(descriptors, filter);
  const ranked = rankCandidates(candidates, { category }, 16);

  const primary = ranked.find((candidate) => candidate.tier === "primary") ?? null;
  const response: Record<string, unknown> = {
    primary: primary?.descriptor.id ?? null,
    secondary: ranked.filter((candidate) => candidate.tier === "secondary").map((candidate) => candidate.descriptor.id),
    fallback: ranked.filter((candidate) => candidate.tier === "fallback").map((candidate) => candidate.descriptor.id),
    // Confidence: the primary's unified score (0–1) — capability match ×
    // benchmark × history × reliability, penalized by cost/latency.
    confidence: primary ? Number(primary.score.toFixed(2)) : 0,
    task: { type: classification.type, complexity: classification.complexity, modality: modality ?? null },
  };
  if (wantsEvidence) {
    response.evidence = {
      matrix: candidateMatrixLines(ranked, { category }),
      self: null,
      note: "full per-dimension breakdowns: /v1/router/candidates",
    };
  }
  return NextResponse.json(response, { status: 200 });
}
