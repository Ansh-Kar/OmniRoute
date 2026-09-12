/**
 * Capability registry — the layered router (harness B12).
 *
 * The user's pipeline, verbatim:
 *
 *              Task
 *               │
 *               ▼
 *         Capability filter          (hard, deterministic elimination —
 *               │                     modality, capability, tool_calling,
 *      ┌────────┼────────┐            context window: 100 → 17)
 *      ▼        ▼        ▼
 *   Vision   Coding    Audio
 *               │
 *               ▼
 *            Ranking                    (score = capability_match
 *               │                        × benchmark × historical_success
 *            Top 3 tiers                 × reliability
 *               │                        / cost_penalty / latency_penalty)
 *               ▼
 *            Hermes                     (PRIMARY + SECONDARY + ALL fallbacks,
 *                                        with per-dimension metadata so the
 *                                        brain can exercise contextual judgment)
 *
 * Two architectural rules live here:
 *
 * 1. CLOSED LOOP — ranking multiplies EMPIRICAL per-(model × category)
 *    success from the jobs store (aggregateModelStatsByCategory), not just
 *    benchmarks: the router learns P(success | model, task) as work flows
 *    through it. Benchmark(model) is only the prior; the workload is the
 *    evidence.
 *
 * 2. EQUAL SCORING (authority without self-selection bias) — the caller's
 *    own model, when it is among the candidates, is scored by the IDENTICAL
 *    function with no bonus and no penalty. "The router cannot select
 *    itself unless it wins the same scoring function applied to every other
 *    candidate." (The orchestrator's lenient near-tie diversification
 *    (B11 bias_tolerance) still governs dispatch; this module never
 *    special-cases the caller.)
 *
 * Pure module: no DB, no clock, no globals — every input is a parameter.
 */

import type { ModelTagEntry, ModelTagIndex } from "../modelTags/index.ts";
import type { ModelStat } from "./allocator.ts";

// ── Descriptor schema ───────────────────────────────────────────────────────

export type CapabilityMatrix = {
  text: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  image_generation: boolean;
  tool_calling: boolean;
  code: boolean;
  reasoning: boolean;
};

export type ModelSpecialization = { name: string; score: number }; // 0..1

export type ModelOperational = {
  context_window: number | null;
  /** Empirical average latency (ms) over observed tasks; null = unobserved. */
  latency_p50_ms: number | null;
  /** Enrichment-sourced list price ($/M tokens); null = unknown (no penalty). */
  cost_per_million_tokens: number | null;
};

export type ModelReliability = {
  /** Laplace-smoothed global task success rate; null = unobserved. */
  success_rate: number | null;
  timeout_rate: number | null;
  /** Observed terminal tasks behind the rates. */
  samples: number;
};

export type ModelDescriptor = {
  id: string;
  provider: string;
  capabilities: CapabilityMatrix;
  specializations: ModelSpecialization[];
  /** Normalized 0..100 per named benchmark (axes + category composites). */
  benchmarks: Record<string, number>;
  operational: ModelOperational;
  reliability: ModelReliability;
  /** Routing hints: the specializations this model is preferred for. */
  preferred_for: string[];
};

/** Empirical stats keyed `model|category` (the closed-loop feed). */
export type StatsByCategory = Record<string, ModelStat>;

export type RegistryInputs = {
  entries: ModelTagEntry[];
  /** Global per-model stats (aggregateModelStats). */
  stats?: Record<string, ModelStat>;
  /** Per-(model × category) stats (aggregateModelStatsByCategory). */
  statsByCategory?: StatsByCategory;
  /**
   * Enrichment: per-model overrides — specializations and cost. Keyed by
   * bare model id (exact) — e.g. { "qwen3-vl-32b": { specializations: {
   * ocr: 0.96, ui_understanding: 0.91 }, cost_per_million_tokens: 0.40 } }.
   * Anything absent stays derived (axes) or null (no penalty).
   */
  enrichment?: Record<
    string,
    { specializations?: Record<string, number>; cost_per_million_tokens?: number }
  >;
};

// ── Specialization derivation ───────────────────────────────────────────────

/** Axis → specialization names (a model scoring on the axis carries both). */
const AXIS_SPECIALIZATIONS: Record<string, string> = {
  swe_bench: "swe_tasks",
  humaneval: "coding",
  math500: "math",
  gpqa: "hard_reasoning",
  mmlu: "knowledge",
  lmarena_elo: "conversation",
};

function deriveSpecializations(entry: ModelTagEntry): ModelSpecialization[] {
  const out = new Map<string, number>();
  for (const [axis, name] of Object.entries(AXIS_SPECIALIZATIONS)) {
    const score = entry.axes?.[axis as keyof typeof entry.axes]?.score;
    if (typeof score === "number") out.set(name, Math.max(0, Math.min(1, score / 100)));
  }
  if (entry.vision) out.set("visual_reasoning", Math.max(out.get("visual_reasoning") ?? 0, entry.benchmark?.score ? entry.benchmark.score / 100 : 0.7));
  return [...out.entries()].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
}

function deriveBenchmarks(entry: ModelTagEntry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [axis, value] of Object.entries(entry.axes ?? {})) {
    if (typeof value?.score === "number") out[axis] = value.score;
  }
  for (const [category, value] of Object.entries(entry.benchmarkOverlays ?? {})) {
    if (typeof value?.score === "number") out[category] = value.score;
  }
  if (typeof entry.benchmark?.score === "number") out.composite = entry.benchmark.score;
  return out;
}

function deriveCapabilities(entry: ModelTagEntry): CapabilityMatrix {
  const categories = entry.categories as readonly string[];
  return {
    text: true, // every chat-registry model accepts text
    vision: entry.vision,
    audio: categories.includes("audio"),
    video: categories.includes("video") || categories.includes("video-gen"),
    image_generation: categories.includes("image-gen"),
    tool_calling: entry.tools,
    code:
      categories.includes("coder") ||
      typeof entry.axes?.humaneval?.score === "number" ||
      typeof entry.axes?.swe_bench?.score === "number",
    reasoning: entry.reasoning || typeof entry.axes?.gpqa?.score === "number",
  };
}

function laplaceSuccess(stat: ModelStat | undefined): number | null {
  if (!stat || stat.successes + stat.failures === 0) return null;
  return (stat.successes + 1) / (stat.successes + stat.failures + 2);
}

function avgLatency(stat: ModelStat | undefined): number | null {
  if (!stat || stat.successes === 0) return null;
  return stat.totalLatencyMs / stat.successes;
}

/** Descriptor + the internal per-category empirical rates (not serialized). */
export type DescriptorWithRates = ModelDescriptor & { categoryRates: Map<string, number> };

/** Build the full descriptor set from the tag index + empirical stats. */
export function buildModelDescriptors(inputs: RegistryInputs): DescriptorWithRates[] {
  const { entries, stats, statsByCategory, enrichment } = inputs;
  return entries.map((entry) => {
    const global = stats?.[entry.id];
    // Every observed (model × category) key — a model may carry evidence for
    // task categories it isn't *categorized* as (a vision model that served
    // code tasks has code history; that history must surface).
    const categoryRates = new Map<string, number>();
    for (const [key, stat] of Object.entries(statsByCategory ?? {})) {
      const separator = key.indexOf("|");
      if (separator <= 0) continue;
      const model = key.slice(0, separator);
      const category = key.slice(separator + 1);
      if (model !== entry.id || !category) continue;
      const rate = laplaceSuccess(stat);
      if (rate !== null) categoryRates.set(category, rate);
    }
    const rich = enrichment?.[entry.model];
    const specializations = deriveSpecializations(entry);
    if (rich?.specializations) {
      for (const [name, score] of Object.entries(rich.specializations)) {
        const existing = specializations.find((spec) => spec.name === name);
        if (existing) existing.score = Math.max(0, Math.min(1, score));
        else specializations.push({ name, score: Math.max(0, Math.min(1, score)) });
      }
      specializations.sort((a, b) => b.score - a.score);
    }
    const successRate = laplaceSuccess(global);
    return {
      id: entry.id,
      provider: entry.provider,
      capabilities: deriveCapabilities(entry),
      specializations,
      benchmarks: deriveBenchmarks(entry),
      operational: {
        context_window: entry.contextLength ?? null,
        latency_p50_ms: avgLatency(global),
        cost_per_million_tokens: rich?.cost_per_million_tokens ?? null,
      },
      operationalByCategory: undefined,
      reliability: {
        success_rate: successRate,
        timeout_rate: successRate === null ? null : Math.max(0, 1 - successRate),
        samples: global ? global.successes + global.failures : 0,
      },
      preferred_for: specializations.slice(0, 3).map((spec) => spec.name),
      categoryRates,
    };
  });
}

// ── Stage 1: hard capability filter (deterministic elimination) ─────────────

export type CandidateFilter = {
  /** Required INPUT modality ("image" → the model must accept images). */
  modality?: "text" | "image" | "audio" | "video";
  /** Required capability key from the matrix (vision, code, tool_calling, …). */
  capability?: string;
  tool_calling?: boolean;
  /** Minimum context window (tokens). */
  min_context?: number;
};

function acceptsModality(capabilities: CapabilityMatrix, modality: string): boolean {
  switch (modality) {
    case "text":
      return capabilities.text;
    case "image":
      return capabilities.vision;
    case "audio":
      return capabilities.audio;
    case "video":
      return capabilities.video;
    default:
      return false;
  }
}

/**
 * The deterministic elimination: registry.filter(input_modality,
 * required_capability, tool_calling). 100 → 17. Every rule is a hard
 * requirement — a model failing ANY rule is out, no scoring rescue.
 */
export function filterCandidates(
  descriptors: ModelDescriptor[],
  filter: CandidateFilter
): { candidates: ModelDescriptor[]; eliminated: number } {
  const before = descriptors.length;
  const candidates = descriptors.filter((descriptor) => {
    if (filter.modality !== undefined && !acceptsModality(descriptor.capabilities, filter.modality)) return false;
    if (filter.capability !== undefined) {
      const key = filter.capability as keyof CapabilityMatrix;
      if (!(key in descriptor.capabilities) || descriptor.capabilities[key] !== true) return false;
    }
    if (filter.tool_calling === true && !descriptor.capabilities.tool_calling) return false;
    if (filter.min_context !== undefined) {
      if (descriptor.operational.context_window === null) return false;
      if (descriptor.operational.context_window < filter.min_context) return false;
    }
    return true;
  });
  return { candidates, eliminated: before - candidates.length };
}

// ── Stage 2: unified ranking ────────────────────────────────────────────────

export type RankContext = {
  /** The task's specialization (e.g. "ocr") — feeds capability_match. */
  specialization?: string;
  /** The task category (e.g. "coder") — benchmark + empirical lookup. */
  category?: string;
  /** Cost tuning: $/M tokens that costs a full ×2 penalty (default 1). */
  costBasePerMillion?: number;
  /** Latency tuning: ms that costs a full ×2 penalty (default 10s). */
  latencyBaseMs?: number;
};

export type ScoreBreakdown = {
  capability_match: number;
  benchmark: number;
  historical_success: number;
  reliability: number;
  cost_penalty: number;
  latency_penalty: number;
};

export type RankedCandidate = {
  descriptor: ModelDescriptor;
  rank: number;
  tier: "primary" | "secondary" | "fallback";
  score: number;
  breakdown: ScoreBreakdown;
};

/**
 * The user's formula, exactly:
 *
 *   score = capability_match × benchmark_score × historical_success
 *           × reliability / cost_penalty / latency_penalty
 *
 * Unknown dimensions are NEUTRAL (1.0 for penalties, smoothed 0.75 for
 * empirical multipliers) — absence of evidence never zeroes a candidate,
 * and never promotes one either.
 */
export function unifiedScore(
  descriptor: ModelDescriptor & { categoryRates?: Map<string, number> },
  context: RankContext
): { score: number; breakdown: ScoreBreakdown } {
  const categoryRates = descriptor.categoryRates ?? new Map<string, number>();
  // capability_match: the specialization score for THIS task, neutral 1.
  const spec =
    context.specialization !== undefined
      ? descriptor.specializations.find((candidate) => candidate.name === context.specialization)?.score
      : undefined;
  const capabilityMatch = spec ?? 1;
  // benchmark: category overlay → axis/composite → neutral 0.5.
  const benchmarkRaw =
    (context.category !== undefined ? descriptor.benchmarks[context.category] : undefined) ??
    descriptor.benchmarks.composite ??
    0.5;
  const benchmark = Math.max(0, Math.min(1, benchmarkRaw / 100));
  // historical_success: empirical P(success | model, category), smoothed;
  // (0.5 + 0.5 × rate) so unobserved is neutral 0.75, matching the B5
  // allocator's health shape.
  const byCategory = context.category !== undefined ? categoryRates.get(context.category) : undefined;
  const historicalSuccess = byCategory !== undefined ? 0.5 + 0.5 * byCategory : 0.75;
  // reliability: global empirical success, same shape.
  const reliability =
    descriptor.reliability.success_rate !== null
      ? 0.5 + 0.5 * descriptor.reliability.success_rate
      : 0.75;
  // cost / latency penalties: ≥ 1, unknown = 1 (never penalize unknowns).
  const costBase = context.costBasePerMillion ?? 1;
  const costPenalty =
    descriptor.operational.cost_per_million_tokens !== null
      ? 1 + descriptor.operational.cost_per_million_tokens / costBase
      : 1;
  const latencyBase = context.latencyBaseMs ?? 10_000;
  const latencyPenalty =
    descriptor.operational.latency_p50_ms !== null ? 1 + descriptor.operational.latency_p50_ms / latencyBase : 1;
  const score = (capabilityMatch * benchmark * historicalSuccess * reliability) / (costPenalty * latencyPenalty);
  return {
    score,
    breakdown: { capability_match: capabilityMatch, benchmark, historical_success: historicalSuccess, reliability, cost_penalty: costPenalty, latency_penalty: latencyPenalty },
  };
}

/**
 * Rank the filtered candidates: unified score, descending; ties keep the
 * tag index's original order (deterministic). Top `top` (default 3) split
 * into PRIMARY (rank 1) + SECONDARY (ranks 2..top); EVERY remaining
 * candidate stays visible as FALLBACK — Hermes gets the full list "just in
 * case of exceptions or models not responding", with the routing metadata
 * saying which to try first.
 */
export function rankCandidates(
  candidates: ModelDescriptor[],
  context: RankContext,
  top: number = 3
): RankedCandidate[] {
  const scored = candidates.map((descriptor, index) => ({ descriptor, index, ...unifiedScore(descriptor, context) }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const ceiling = Math.max(1, Math.min(16, Math.floor(top)));
  return scored.map((entry, position) => {
    const rank = position + 1;
    return {
      descriptor: entry.descriptor,
      rank,
      tier: rank === 1 ? "primary" : rank <= ceiling ? "secondary" : "fallback",
      score: entry.score,
      breakdown: entry.breakdown,
    };
  });
}

// ── Equal-scoring self-assessment ───────────────────────────────────────────

export type SelfAssessment = {
  model: string;
  /** The caller's rank among the candidates under the IDENTICAL score. */
  rank: number | null;
  score: number | null;
  /** True when the caller would be PRIMARY — it won the same scoring. */
  would_win: boolean;
  /** "ranked" = in the candidate list; "filtered" = eliminated by a hard rule; "unregistered" = not in the registry. */
  status: "ranked" | "filtered" | "unregistered";
};

/**
 * The architectural separation: Hermes doesn't need to know a model is
 * "better than Hermes" — the registry says. The caller is scored by the
 * same unified function as everyone else; if it wins, it wins (would_win),
 * if not, its rank says by how much. No self-bonus, no self-penalty.
 */
export function selfAssess(
  callerModel: string,
  ranked: RankedCandidate[],
  eliminated: ModelDescriptor[]
): SelfAssessment {
  const hit = ranked.find((candidate) => candidate.descriptor.id === callerModel);
  if (hit) {
    return { model: callerModel, rank: hit.rank, score: hit.score, would_win: hit.tier === "primary", status: "ranked" };
  }
  const wasFiltered = eliminated.some((descriptor) => descriptor.id === callerModel);
  return { model: callerModel, rank: null, score: null, would_win: false, status: wasFiltered ? "filtered" : "unregistered" };
}

/** Serialize a ranked candidate for the API surface. */
export function rankedToApi(candidate: RankedCandidate): Record<string, unknown> {
  return {
    id: candidate.descriptor.id,
    provider: candidate.descriptor.provider,
    tier: candidate.tier,
    rank: candidate.rank,
    score: Number(candidate.score.toFixed(4)),
    score_breakdown: candidate.breakdown,
    capabilities: candidate.descriptor.capabilities,
    specializations: candidate.descriptor.specializations,
    benchmarks: candidate.descriptor.benchmarks,
    operational: candidate.descriptor.operational,
    reliability: candidate.descriptor.reliability,
    preferred_for: candidate.descriptor.preferred_for,
  };
}
