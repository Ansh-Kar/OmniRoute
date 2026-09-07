import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  getModelTagIndex,
  isBenchmarkAxis,
  isModelCategory,
  type ModelTagEntry,
} from "@omniroute/open-sse/services/modelTags/index.ts";

/**
 * GET /api/v1/models/catalog — the harness capability catalog (Layer 3, B1).
 *
 * Agent-facing (API-key policy, not management auth) retrieval over the model
 * tag index: every catalog model with its categories, composite benchmark,
 * per-axis benchmark scores (SWE-bench / HumanEval / MATH-500 / GPQA / MMLU /
 * LMArena), capability flags and context length. Filters mirror
 * /api/models/tags; the difference is the audience (agents, API keys) and the
 * axis-aware data.
 *
 *   /api/v1/models/catalog?category=coder&axis=swe_bench&limit=50
 *   /api/v1/models/catalog?requireTools=true&minBenchmark=80
 */
function csvParam(value: string | null): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolParam(value: string | null): boolean {
  return value === "true" || value === "1";
}

function serializeEntry(entry: ModelTagEntry) {
  return {
    id: entry.id,
    model: entry.model,
    provider: entry.provider,
    categories: entry.categories,
    benchmark: entry.benchmark ?? null,
    benchmarkOverlays: entry.benchmarkOverlays ?? null,
    axes: entry.axes ?? null,
    contextLength: entry.contextLength ?? null,
    tools: entry.tools,
    vision: entry.vision,
    reasoning: entry.reasoning,
  };
}

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

  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    if (category !== null && category !== "" && !isModelCategory(category)) {
      return NextResponse.json(
        { error: { message: `Invalid category "${category}"` } },
        { status: 400 }
      );
    }
    const axis = searchParams.get("axis");
    if (axis !== null && axis !== "" && !isBenchmarkAxis(axis)) {
      return NextResponse.json(
        { error: { message: `Invalid axis "${axis}"` } },
        { status: 400 }
      );
    }

    const index = getModelTagIndex();
    const limit = Math.min(Math.max(Math.floor(numberParam(searchParams.get("limit")) ?? 100), 1), 500);
    const offset = Math.max(Math.floor(numberParam(searchParams.get("offset")) ?? 0), 0);

    const pool = category ? (index.byCategory.get(category) ?? []) : index.entries;
    const providers = csvParam(searchParams.get("providers"));
    const minBenchmark = numberParam(searchParams.get("minBenchmark"));
    const requireTools = boolParam(searchParams.get("requireTools"));
    const requireVision = boolParam(searchParams.get("requireVision"));

    const scoreOf = (entry: ModelTagEntry): number | null => {
      if (axis) return entry.axes?.[axis]?.score ?? null;
      if (category) return entry.benchmarkOverlays?.[category]?.score ?? entry.benchmark?.score ?? null;
      return entry.benchmark?.score ?? null;
    };

    const filtered = pool.filter((entry) => {
      if (providers && !providers.includes(entry.provider)) return false;
      if (requireTools && !entry.tools) return false;
      if (requireVision && !entry.vision) return false;
      if (minBenchmark !== undefined && minBenchmark > 0) {
        const score = scoreOf(entry);
        if (score === null || score < minBenchmark) return false;
      }
      return true;
    });

    // Same ordering semantics as findModelsByTags: score desc, unscored last,
    // then context desc, then stable id order.
    filtered.sort((a, b) => {
      const scoreA = scoreOf(a);
      const scoreB = scoreOf(b);
      if (scoreA !== scoreB) {
        if (scoreA === null) return 1;
        if (scoreB === null) return -1;
        return scoreB - scoreA;
      }
      if (scoreA === null) return (b.contextLength ?? 0) - (a.contextLength ?? 0) || (a.id < b.id ? -1 : 1);
      return (b.contextLength ?? 0) - (a.contextLength ?? 0) || (a.id < b.id ? -1 : 1);
    });

    const page = filtered.slice(offset, offset + limit);
    return NextResponse.json({
      object: "model_catalog",
      total: filtered.length,
      count: page.length,
      offset,
      filters: {
        category: category ?? null,
        axis: axis ?? null,
        providers: providers ?? null,
        minBenchmark: minBenchmark ?? null,
        requireTools,
        requireVision,
      },
      models: page.map(serializeEntry),
    });
  } catch (error) {
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : "catalog query failed" } },
      { status: 500 }
    );
  }
}
