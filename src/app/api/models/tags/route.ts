import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  buildFusionPanelFromTags,
  findModelsByTags,
  getModelTagIndex,
  isModelCategory,
  type ModelTagQuery,
} from "@omniroute/open-sse/services/modelTags/index.ts";

/**
 * GET /api/models/tags — model retrieval by provider + category + benchmark.
 *
 * Fork(parallel-execution): the HTTP surface of the model tag index
 * (open-sse/services/modelTags). Answers "which models can do X, ranked by
 * quality, across which providers" without client-side catalog filtering:
 *
 *   /api/models/tags?category=coder&minBenchmark=80&diverse=true&limit=4
 *   /api/models/tags?category=vision&requireVision=true
 *   /api/models/tags?panel=true&category=chat&size=4   ← fusion panel preview
 *
 * `panel=true` runs the exact resolution `config.panelFromTags` uses at
 * dispatch, so an operator can preview a tag panel before saving the combo.
 */

function csvParam(value: string | null): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");

    if (category !== null && category !== "" && !isModelCategory(category)) {
      return NextResponse.json(
        {
          error: {
            message: `Invalid category "${category}"`,
            details: [{ field: "category", message: "Must be a known model category" }],
          },
        },
        { status: 400 }
      );
    }

    const minBenchmark = numberParam(searchParams.get("minBenchmark"));
    if (minBenchmark !== undefined && (minBenchmark < 0 || minBenchmark > 100)) {
      return NextResponse.json(
        {
          error: {
            message: "minBenchmark must be between 0 and 100",
            details: [{ field: "minBenchmark", message: "Range: 0..100" }],
          },
        },
        { status: 400 }
      );
    }

    const query: ModelTagQuery = {
      category: category ? (category as ModelTagQuery["category"]) : undefined,
      provider: searchParams.get("provider") ?? undefined,
      providers: csvParam(searchParams.get("providers")),
      excludeProviders: csvParam(searchParams.get("excludeProviders")),
      minBenchmark,
      requireTools: boolParam(searchParams.get("requireTools")) || undefined,
      requireVision: boolParam(searchParams.get("requireVision")) || undefined,
      minContextLength: numberParam(searchParams.get("minContextLength")),
      limit: numberParam(searchParams.get("limit")),
      diverseProviders: boolParam(searchParams.get("diverse")) || undefined,
      distinctModels: boolParam(searchParams.get("distinct")) || undefined,
    };

    const index = getModelTagIndex();

    // Panel mode: the exact resolution a fusion combo's panelFromTags runs.
    if (boolParam(searchParams.get("panel"))) {
      if (!query.category) {
        return NextResponse.json(
          {
            error: {
              message: "panel=true requires a category",
              details: [{ field: "category", message: "Required in panel mode" }],
            },
          },
          { status: 400 }
        );
      }
      const size = numberParam(searchParams.get("size"));
      const perProvider = numberParam(searchParams.get("perProvider"));
      const resolution = buildFusionPanelFromTags(index, {
        category: query.category,
        size: size !== undefined ? size : 4,
        minBenchmark: query.minBenchmark,
        perProvider,
        providers: query.providers,
        excludeProviders: query.excludeProviders,
        requireTools: query.requireTools,
        requireVision: query.requireVision,
      });
      return NextResponse.json({
        object: "fusion_panel",
        requestedSize: resolution.requestedSize,
        truncated: resolution.truncated,
        models: resolution.models,
        data: resolution.entries,
      });
    }

    const entries = findModelsByTags(index, query);
    return NextResponse.json({
      object: "list",
      data: entries,
    });
  } catch (error) {
    console.error("Error querying model tags:", error);
    return NextResponse.json(
      { error: { message: "Failed to query model tags" } },
      { status: 500 }
    );
  }
}
