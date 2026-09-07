/**
 * Benchmark axes — the multi-axis quality layer of the model tag index
 * (harness Layer 3, build B1).
 *
 * The composite `benchmark` score (seedBenchmarks.ts) answers "rank models in
 * a category". Axes answer the sharper question the harness needs: "rank
 * models for THIS task type on the evidence that matters" — code on
 * SWE-bench/HumanEval, math on MATH-500, reasoning on GPQA/MMLU, general
 * assistant quality on LMArena ELO.
 *
 * Same discipline as seedBenchmarks (inherited from taskFitness #11503):
 *   - keys name versioned ids that exist in the provider catalog — no family
 *     patterns, no "latest" aliases;
 *   - scores are 0..100 curations, NOT measured results — `basis` says so on
 *     every entry, and operators should override with arena/fitness data via
 *     the runtime `scoreLookup` hook when present;
 *   - an id this table does not know has NO axis score — it sorts after
 *     axis-scored entries and is filtered out by axis-threshold queries.
 *     "No evidence" is never silently converted into a number, and an axis
 *     score is never silently substituted by the composite benchmark.
 *
 * LMArena ELO (~1200–1500 band) is normalized to 0..100 via
 * `(elo - 1200) / 3` so every axis shares one scale; the raw ELO is quoted
 * in the basis note.
 */

import type { ModelCategory } from "./taxonomy.ts";

export const BENCHMARK_AXES = [
  "mmlu",
  "humaneval",
  "swe_bench",
  "math500",
  "gpqa",
  "lmarena_elo",
] as const;

export type BenchmarkAxis = (typeof BENCHMARK_AXES)[number];

const AXIS_SET: ReadonlySet<string> = new Set(BENCHMARK_AXES);

/** Fast membership test for untrusted input (API query params, config). */
export function isBenchmarkAxis(value: unknown): value is BenchmarkAxis {
  return typeof value === "string" && AXIS_SET.has(value);
}

export type AxisSeed = {
  /** Curated 0..100 ballpark for this axis. */
  score: number;
  /** Provenance note surfaced verbatim through the API. */
  basis: string;
};

/**
 * Axis seeds keyed by bare model id (provider-agnostic, like the composite
 * seed table). Extends the same curated flagship set.
 */
export const AXIS_SEEDS: Record<BenchmarkAxis, Record<string, AxisSeed>> = {
  swe_bench: {
    "gpt-5.6": { score: 74, basis: "curated seed — SWE-bench verified ballpark" },
    "claude-opus-5": { score: 72, basis: "curated seed — SWE-bench verified ballpark" },
    "gemini-3.1-pro-preview": { score: 68, basis: "curated seed — SWE-bench verified ballpark" },
    "claude-sonnet-5": { score: 65, basis: "curated seed — SWE-bench verified ballpark" },
    "claude-opus-4.8": { score: 64, basis: "curated seed — SWE-bench verified ballpark" },
    "gpt-5.5-pro": { score: 63, basis: "curated seed — SWE-bench verified ballpark" },
    "deepseek-v4-pro": { score: 62, basis: "curated seed — SWE-bench verified ballpark" },
    "kimi-k2.7-code": { score: 60, basis: "curated seed — SWE-bench verified ballpark" },
    "claude-fable-5-1": { score: 59, basis: "curated seed — SWE-bench verified ballpark" },
    "grok-4.6": { score: 58, basis: "curated seed — SWE-bench verified ballpark" },
    "kimi-k3": { score: 55, basis: "curated seed — SWE-bench verified ballpark" },
    "glm-5.3": { score: 55, basis: "curated seed — SWE-bench verified ballpark" },
    "gemini-3.7-flash": { score: 50, basis: "curated seed — SWE-bench verified ballpark" },
    "deepseek-v4-flash": { score: 47, basis: "curated seed — SWE-bench verified ballpark" },
    "MiniMax-M3": { score: 46, basis: "curated seed — SWE-bench verified ballpark" },
    "devstral-latest": { score: 41, basis: "curated seed — SWE-bench verified ballpark" },
    "codestral-latest": { score: 36, basis: "curated seed — SWE-bench verified ballpark" },
    "qwen2.5-coder-7b": { score: 22, basis: "curated seed — SWE-bench verified ballpark" },
  },
  humaneval: {
    "gpt-5.6": { score: 96, basis: "curated seed — HumanEval ballpark" },
    "claude-opus-5": { score: 95, basis: "curated seed — HumanEval ballpark" },
    "gemini-3.1-pro-preview": { score: 94, basis: "curated seed — HumanEval ballpark" },
    "claude-opus-4.8": { score: 93, basis: "curated seed — HumanEval ballpark" },
    "gpt-5.5-pro": { score: 93, basis: "curated seed — HumanEval ballpark" },
    "claude-fable-5-1": { score: 92, basis: "curated seed — HumanEval ballpark" },
    "claude-sonnet-5": { score: 92, basis: "curated seed — HumanEval ballpark" },
    "deepseek-v4-pro": { score: 90, basis: "curated seed — HumanEval ballpark" },
    "kimi-k2.7-code": { score: 90, basis: "curated seed — HumanEval ballpark" },
    "grok-4.6": { score: 89, basis: "curated seed — HumanEval ballpark" },
    "kimi-k3": { score: 87, basis: "curated seed — HumanEval ballpark" },
    "glm-5.3": { score: 86, basis: "curated seed — HumanEval ballpark" },
    "gemini-3.7-flash": { score: 84, basis: "curated seed — HumanEval ballpark" },
    "deepseek-v4-flash": { score: 83, basis: "curated seed — HumanEval ballpark" },
    "MiniMax-M3": { score: 82, basis: "curated seed — HumanEval ballpark" },
    "codestral-latest": { score: 81, basis: "curated seed — HumanEval ballpark" },
    "devstral-latest": { score: 78, basis: "curated seed — HumanEval ballpark" },
    "qwen2.5-coder-7b": { score: 55, basis: "curated seed — HumanEval ballpark" },
  },
  math500: {
    "gpt-5.6": { score: 96, basis: "curated seed — MATH-500 ballpark" },
    "gemini-3.1-pro-preview": { score: 95, basis: "curated seed — MATH-500 ballpark" },
    "claude-fable-5-1": { score: 94, basis: "curated seed — MATH-500 ballpark" },
    "claude-opus-5": { score: 93, basis: "curated seed — MATH-500 ballpark" },
    "grok-4.6": { score: 92, basis: "curated seed — MATH-500 ballpark" },
    "gpt-5.5-pro": { score: 91, basis: "curated seed — MATH-500 ballpark" },
    "deepseek-v4-pro": { score: 89, basis: "curated seed — MATH-500 ballpark" },
    "kimi-k3": { score: 87, basis: "curated seed — MATH-500 ballpark" },
    "claude-opus-4.8": { score: 86, basis: "curated seed — MATH-500 ballpark" },
    "claude-sonnet-5": { score: 85, basis: "curated seed — MATH-500 ballpark" },
    "glm-5.3": { score: 83, basis: "curated seed — MATH-500 ballpark" },
    "gemini-3.7-flash": { score: 80, basis: "curated seed — MATH-500 ballpark" },
    "deepseek-v4-flash": { score: 78, basis: "curated seed — MATH-500 ballpark" },
    "MiniMax-M3": { score: 76, basis: "curated seed — MATH-500 ballpark" },
    "kimi-k2.7-code": { score: 74, basis: "curated seed — MATH-500 ballpark" },
    "command-a-reasoning-08-2025": { score: 68, basis: "curated seed — MATH-500 ballpark" },
    "qwen2.5-coder-7b": { score: 48, basis: "curated seed — MATH-500 ballpark" },
  },
  gpqa: {
    "gpt-5.6": { score: 84, basis: "curated seed — GPQA Diamond ballpark" },
    "gemini-3.1-pro-preview": { score: 83, basis: "curated seed — GPQA Diamond ballpark" },
    "claude-fable-5-1": { score: 82, basis: "curated seed — GPQA Diamond ballpark" },
    "claude-opus-5": { score: 80, basis: "curated seed — GPQA Diamond ballpark" },
    "grok-4.6": { score: 78, basis: "curated seed — GPQA Diamond ballpark" },
    "gpt-5.5-pro": { score: 76, basis: "curated seed — GPQA Diamond ballpark" },
    "deepseek-v4-pro": { score: 72, basis: "curated seed — GPQA Diamond ballpark" },
    "kimi-k3": { score: 70, basis: "curated seed — GPQA Diamond ballpark" },
    "claude-opus-4.8": { score: 69, basis: "curated seed — GPQA Diamond ballpark" },
    "glm-5.3": { score: 64, basis: "curated seed — GPQA Diamond ballpark" },
    "claude-sonnet-5": { score: 63, basis: "curated seed — GPQA Diamond ballpark" },
    "gemini-3.7-flash": { score: 58, basis: "curated seed — GPQA Diamond ballpark" },
    "deepseek-v4-flash": { score: 55, basis: "curated seed — GPQA Diamond ballpark" },
    "MiniMax-M3": { score: 53, basis: "curated seed — GPQA Diamond ballpark" },
    "command-a-reasoning-08-2025": { score: 46, basis: "curated seed — GPQA Diamond ballpark" },
  },
  mmlu: {
    "gpt-5.6": { score: 92, basis: "curated seed — MMLU ballpark" },
    "gemini-3.1-pro-preview": { score: 92, basis: "curated seed — MMLU ballpark" },
    "claude-opus-5": { score: 91, basis: "curated seed — MMLU ballpark" },
    "claude-fable-5-1": { score: 91, basis: "curated seed — MMLU ballpark" },
    "gpt-5.5-pro": { score: 90, basis: "curated seed — MMLU ballpark" },
    "grok-4.6": { score: 89, basis: "curated seed — MMLU ballpark" },
    "claude-opus-4.8": { score: 88, basis: "curated seed — MMLU ballpark" },
    "deepseek-v4-pro": { score: 88, basis: "curated seed — MMLU ballpark" },
    "kimi-k3": { score: 86, basis: "curated seed — MMLU ballpark" },
    "claude-sonnet-5": { score: 85, basis: "curated seed — MMLU ballpark" },
    "glm-5.3": { score: 83, basis: "curated seed — MMLU ballpark" },
    "gemini-3.7-flash": { score: 81, basis: "curated seed — MMLU ballpark" },
    "deepseek-v4-flash": { score: 79, basis: "curated seed — MMLU ballpark" },
    "MiniMax-M3": { score: 78, basis: "curated seed — MMLU ballpark" },
    "kimi-k2.7-code": { score: 76, basis: "curated seed — MMLU ballpark" },
    "command-a-reasoning-08-2025": { score: 72, basis: "curated seed — MMLU ballpark" },
    "qwen2.5-coder-7b": { score: 58, basis: "curated seed — MMLU ballpark" },
  },
  lmarena_elo: {
    "gpt-5.6": { score: 88, basis: "curated seed — LMArena ELO ~1464 normalized (1200 + 3·score)" },
    "gemini-3.1-pro-preview": { score: 87, basis: "curated seed — LMArena ELO ~1460 normalized (1200 + 3·score)" },
    "claude-opus-5": { score: 86, basis: "curated seed — LMArena ELO ~1458 normalized (1200 + 3·score)" },
    "claude-fable-5-1": { score: 84, basis: "curated seed — LMArena ELO ~1452 normalized (1200 + 3·score)" },
    "grok-4.6": { score: 83, basis: "curated seed — LMArena ELO ~1449 normalized (1200 + 3·score)" },
    "gpt-5.5-pro": { score: 82, basis: "curated seed — LMArena ELO ~1446 normalized (1200 + 3·score)" },
    "claude-opus-4.8": { score: 80, basis: "curated seed — LMArena ELO ~1440 normalized (1200 + 3·score)" },
    "deepseek-v4-pro": { score: 78, basis: "curated seed — LMArena ELO ~1434 normalized (1200 + 3·score)" },
    "kimi-k3": { score: 76, basis: "curated seed — LMArena ELO ~1428 normalized (1200 + 3·score)" },
    "claude-sonnet-5": { score: 75, basis: "curated seed — LMArena ELO ~1425 normalized (1200 + 3·score)" },
    "glm-5.3": { score: 71, basis: "curated seed — LMArena ELO ~1413 normalized (1200 + 3·score)" },
    "gemini-3.7-flash": { score: 68, basis: "curated seed — LMArena ELO ~1404 normalized (1200 + 3·score)" },
    "deepseek-v4-flash": { score: 65, basis: "curated seed — LMArena ELO ~1395 normalized (1200 + 3·score)" },
    "MiniMax-M3": { score: 62, basis: "curated seed — LMArena ELO ~1386 normalized (1200 + 3·score)" },
    "command-a-reasoning-08-2025": { score: 54, basis: "curated seed — LMArena ELO ~1362 normalized (1200 + 3·score)" },
  },
};

/**
 * Look up the axis seed for one model. Bare model id first (case-insensitive,
 * mirroring lookupBenchmarkSeed), then full `provider/model` id.
 */
export function lookupAxisSeed(
  axis: BenchmarkAxis,
  ref: { model: string; id?: string }
): AxisSeed | null {
  const table = AXIS_SEEDS[axis];
  if (!table) return null;
  const byModel = table[ref.model.toLowerCase()];
  if (byModel) return byModel;
  if (ref.id) {
    const byFullId = table[ref.id.toLowerCase()];
    if (byFullId) return byFullId;
  }
  return null;
}

// ── Task types (harness Layer 3 classifier vocabulary) ──────────────────────

export const TASK_TYPES = [
  "code",
  "research",
  "math",
  "reasoning",
  "plan",
  "vision",
  "search",
  "chat",
  "image_gen",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

const TASK_TYPE_SET: ReadonlySet<string> = new Set(TASK_TYPES);

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && TASK_TYPE_SET.has(value);
}

/**
 * Task type → tag-index query: which axes rank it, which capability floors
 * apply, and (only where a name-inferred subcategory genuinely narrows the
 * pool — vision, search) which category to retrieve from. For code / math /
 * reasoning / chat the category is intentionally UNSET: the axis ranks the
 * whole chat registry, because flagship generalists (categorized chat)
 * often beat name-inferred "coder" models on SWE-bench. The mapping is
 * shared by the classifier's output, `GET /v1/models/best?task=` and the
 * capability aliases, so "classified as code" and "best for code" can
 * never drift apart.
 */
export const TASK_TYPE_TO_QUERY: Record<
  TaskType,
  {
    category?: ModelCategory;
    /** Ranking precedence — first present axis wins. */
    axes: readonly BenchmarkAxis[];
    requireTools?: boolean;
    requireVision?: boolean;
    /** Fallback category when the primary one resolves empty. */
    fallbackCategory?: ModelCategory;
    description: string;
  }
> = {
  code: {
    axes: ["swe_bench", "humaneval"],
    requireTools: true,
    description: "coding / implementation / debugging work",
  },
  research: {
    category: "search",
    axes: [],
    fallbackCategory: "chat",
    description: "multi-source research and synthesis",
  },
  math: {
    axes: ["math500", "gpqa"],
    description: "mathematics / formal reasoning",
  },
  reasoning: {
    axes: ["gpqa", "mmlu"],
    description: "logic, deduction, multi-step reasoning",
  },
  plan: {
    // Guide 2's Hermes contract string — decomposition/planning is deep
    // reasoning; same whole-registry GPQA/MMLU ranking, its own alias.
    axes: ["gpqa", "mmlu"],
    description: "decomposition, planning, multi-step strategy",
  },
  vision: {
    category: "vision",
    axes: [],
    requireVision: true,
    description: "image understanding",
  },
  search: {
    category: "search",
    axes: [],
    fallbackCategory: "chat",
    description: "web search / current facts",
  },
  chat: {
    axes: ["lmarena_elo"],
    description: "general assistant conversation",
  },
  image_gen: {
    category: "image-gen",
    axes: [],
    description: "image generation (media endpoint, not chat dispatch)",
  },
};
