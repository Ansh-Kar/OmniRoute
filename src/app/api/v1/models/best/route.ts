import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  findModelsByTags,
  getModelTagIndex,
  isTaskType,
  TASK_TYPE_TO_QUERY,
  isModelCategory,
  isBenchmarkAxis,
  type ModelTagEntry,
} from "@omniroute/open-sse/services/modelTags/index.ts";

/**
 * GET /api/v1/models/best?task=code — the harness allocator query (Layer 3,
 * B1). "Who is best for THIS kind of work, right now?"
 *
 * `task` uses the classifier vocabulary (code|research|math|vision|search|
 * chat|image_gen) and maps through TASK_TYPE_TO_QUERY — the SAME mapping the
 * classifier's output and the capability aliases use, so "classified as
 * code", "best for code" and "route as code" can never drift apart. Ranking
 * is axis-aware: code sorts by SWE-bench, math by MATH-500, reasoning by
 * GPQA, chat by LMArena ELO.
 *
 *   /api/v1/models/best?task=code&limit=6
 *   /api/v1/models/best?task=math&minBenchmark=80
 *   /api/v1/models/best?category=coder&axis=humaneval   (raw form)
 */
function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    const task = searchParams.get("task");
    const category = searchParams.get("category");
    const axisParam = searchParams.get("axis");

    if (task !== null && task !== "" && !isTaskType(task)) {
      return NextResponse.json(
        { error: { message: `Invalid task "${task}"` } },
        { status: 400 }
      );
    }
    if (axisParam !== null && axisParam !== "" && !isBenchmarkAxis(axisParam)) {
      return NextResponse.json(
        { error: { message: `Invalid axis "${axisParam}"` } },
        { status: 400 }
      );
    }

    const index = getModelTagIndex();
    const limit = Math.min(Math.max(Math.floor(numberParam(searchParams.get("limit")) ?? 6), 1), 40);
    const minBenchmark = numberParam(searchParams.get("minBenchmark"));

    const spec = task ? TASK_TYPE_TO_QUERY[task] : null;
    const queryCategory = spec ? spec.category : (category ?? undefined);
    if (!spec && !queryCategory) {
      return NextResponse.json(
        { error: { message: "Pass ?task= (classifier vocabulary) or ?category= (raw category)" } },
        { status: 400 }
      );
    }
    if (!spec && queryCategory && !isModelCategory(queryCategory)) {
      return NextResponse.json(
        { error: { message: `Invalid category "${queryCategory}"` } },
        { status: 400 }
      );
    }

    // Axis precedence: explicit ?axis= wins, else the task type's own axis.
    // (Seed table guarantees data for the primary axis of every task type.)
    const axis =
      axisParam && axisParam !== ""
        ? axisParam
        : (spec?.axes[0] ?? null);

    const candidates = findModelsByTags(index, {
      category: queryCategory as Parameters<typeof findModelsByTags>[1]["category"],
      minBenchmark,
      requireTools: spec?.requireTools,
      requireVision: spec?.requireVision,
      axis: axis ?? undefined,
      distinctModels: true,
      diverseProviders: true,
      limit,
    });

    // Task fallback (e.g. no search-registry models): same ladder the
    // capability alias uses, so /best and the live alias agree.
    const resolved =
      candidates.length > 0 || !spec?.fallbackCategory
        ? candidates
        : findModelsByTags(index, {
            category: spec.fallbackCategory,
            minBenchmark,
            axis: axis ?? undefined,
            distinctModels: true,
            diverseProviders: true,
            limit,
          });

    const serialize = (entry: ModelTagEntry) => ({
      id: entry.id,
      model: entry.model,
      provider: entry.provider,
      categories: entry.categories,
      axis: axis ? (entry.axes?.[axis] ?? null) : null,
      benchmark: entry.benchmark ?? null,
      contextLength: entry.contextLength ?? null,
      tools: entry.tools,
      vision: entry.vision,
      reasoning: entry.reasoning,
    });

    return NextResponse.json({
      object: "best_models",
      task: task ?? null,
      category: queryCategory,
      axis: axis ?? null,
      count: resolved.length,
      models: resolved.map(serialize),
    });
  } catch (error) {
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : "best-models query failed" } },
      { status: 500 }
    );
  }
}
