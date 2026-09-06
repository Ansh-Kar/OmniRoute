/**
 * Curated benchmark seeds — the static quality layer of the tag index.
 *
 * Existence reason (fork: parallel execution): `panelFromTags` and
 * `GET /api/models/tags?minBenchmark=…` need a per-category quality score to
 * rank and filter candidates. OmniRoute's authoritative quality signal is the
 * DB-backed taskFitness stack (user override → arena ELO → models.dev tier —
 * see open-sse/services/autoCombo/taskFitness.ts), but that stack answers
 * "how fit is model X for task Y", not "rank every catalog model for a
 * category right now, including ones no arena has ever scored". These seeds
 * are the static floor: a small, hand-maintained, VERSIONED table that gives
 * flagship models an honest ballpark so panels and retrievals order sanely
 * out of the box.
 *
 * Discipline (inherited from taskFitness #11503, which fixed the ranking
 * inversions loose family patterns caused there):
 *   - Every key names a versioned id that EXISTS in the provider catalog
 *     (chat registry bare id, or full `provider/model` id for media models).
 *     No family patterns, no "latest" aliases that silently adopt every
 *     future member.
 *   - Scores are 0..100 ballpark curations, NOT measured results; `basis`
 *     says so on every entry. Operators should override with arena/fitness
 *     data via the runtime `scoreLookup` hook (tagIndex.ts) when present.
 *   - An id this table does not know simply has NO benchmark — it sorts last
 *     and is filtered out by any `minBenchmark > 0` query. "No evidence" is
 *     never silently converted into a number.
 */

import type { ModelCategory } from "./taxonomy.ts";

export type BenchmarkSeed = {
  /** Curated 0..100 ballpark for this category. */
  score: number;
  /** Provenance note surfaced verbatim through the API. */
  basis: string;
};

/**
 * Seeds keyed by category, then by model id. Chat-registry models are keyed
 * by bare model id (provider-agnostic: `glm-5.3` scores the same whether it
 * is reached via glm, glmt or glmcn); media-registry models are keyed by
 * their full `provider/model` id.
 */
export const BENCHMARK_SEEDS: Partial<Record<ModelCategory, Record<string, BenchmarkSeed>>> = {
  coder: {
    "gpt-5.6": { score: 94, basis: "curated seed — flagship coding agent tier" },
    "claude-opus-5": { score: 93, basis: "curated seed — flagship coding agent tier" },
    "gemini-3.1-pro-preview": { score: 92, basis: "curated seed — flagship coding agent tier" },
    "claude-opus-4.8": { score: 91, basis: "curated seed — prior flagship tier" },
    "gpt-5.5-pro": { score: 91, basis: "curated seed — prior flagship tier" },
    "deepseek-v4-pro": { score: 90, basis: "curated seed — strong open-weights coding tier" },
    "claude-fable-5-1": { score: 90, basis: "curated seed — reasoning-tuned coding tier" },
    "claude-sonnet-5": { score: 89, basis: "curated seed — fast coding tier" },
    "kimi-k2.7-code": { score: 88, basis: "curated seed — coding-specialized tier" },
    "grok-4.6": { score: 87, basis: "curated seed — strong generalist coding tier" },
    "kimi-k3": { score: 86, basis: "curated seed — strong generalist coding tier" },
    "gemini-3.7-flash": { score: 85, basis: "curated seed — fast coding tier" },
    "glm-5.3": { score: 84, basis: "curated seed — mid flagship tier" },
    "deepseek-v4-flash": { score: 84, basis: "curated seed — fast open-weights tier" },
    "MiniMax-M3": { score: 82, basis: "curated seed — mid tier" },
    "codestral-latest": { score: 80, basis: "curated seed — coding-specialized mid tier" },
    "devstral-latest": { score: 79, basis: "curated seed — coding-specialized mid tier" },
    "qwen2.5-coder-7b": { score: 62, basis: "curated seed — small coding model tier" },
  },
  reasoning: {
    "gpt-5.6": { score: 94, basis: "curated seed — flagship reasoning tier" },
    "claude-fable-5-1": { score: 93, basis: "curated seed — flagship reasoning tier" },
    "claude-opus-5": { score: 92, basis: "curated seed — flagship reasoning tier" },
    "gemini-3.1-pro-preview": { score: 91, basis: "curated seed — flagship reasoning tier" },
    "grok-4.6": { score: 90, basis: "curated seed — strong reasoning tier" },
    "deepseek-v4-pro": { score: 89, basis: "curated seed — strong open-weights reasoning tier" },
    "kimi-k3": { score: 87, basis: "curated seed — strong reasoning tier" },
    "glm-5.3": { score: 85, basis: "curated seed — mid flagship tier" },
    "command-a-reasoning-08-2025": { score: 78, basis: "curated seed — mid reasoning tier" },
  },
  vision: {
    "gemini-3.1-pro-preview": { score: 93, basis: "curated seed — flagship multimodal tier" },
    "gpt-5.6": { score: 91, basis: "curated seed — flagship multimodal tier" },
    "claude-fable-5-1": { score: 90, basis: "curated seed — flagship multimodal tier" },
    "grok-4.6": { score: 88, basis: "curated seed — strong multimodal tier" },
    "kimi-k3": { score: 86, basis: "curated seed — strong multimodal tier" },
    "command-a-vision-07-2025": { score: 76, basis: "curated seed — mid multimodal tier" },
    "qwen3-vl-8b": { score: 65, basis: "curated seed — small VL tier" },
  },
  chat: {
    "gpt-5.6": { score: 93, basis: "curated seed — flagship assistant tier" },
    "claude-opus-5": { score: 92, basis: "curated seed — flagship assistant tier" },
    "gemini-3.1-pro-preview": { score: 91, basis: "curated seed — flagship assistant tier" },
    "claude-sonnet-5": { score: 89, basis: "curated seed — fast assistant tier" },
    "deepseek-v4-pro": { score: 88, basis: "curated seed — strong open-weights assistant tier" },
    "grok-4.6": { score: 87, basis: "curated seed — strong assistant tier" },
    "kimi-k3": { score: 85, basis: "curated seed — strong assistant tier" },
    "glm-5.3": { score: 83, basis: "curated seed — mid flagship tier" },
    "MiniMax-M3": { score: 80, basis: "curated seed — mid tier" },
  },
  "image-gen": {
    "openai/gpt-image-2": { score: 90, basis: "curated seed — flagship image tier" },
    "openai/gpt-image-1.5": { score: 87, basis: "curated seed — prior flagship image tier" },
    "openai/dall-e-3": { score: 78, basis: "curated seed — legacy flagship image tier" },
  },
  "text-to-speech": {
    "openai/gpt-4o-mini-tts": { score: 86, basis: "curated seed — flagship TTS tier" },
    "google/gemini-3.1-flash-tts-preview": { score: 84, basis: "curated seed — strong TTS tier" },
    "openai/tts-1-hd": { score: 78, basis: "curated seed — legacy TTS tier" },
  },
};

/**
 * Look up the seed for one model. Chat models are keyed by bare id (checked
 * first so a full id still hits via its model part); media models by their
 * full `provider/model` id.
 */
export function lookupBenchmarkSeed(
  category: ModelCategory,
  ref: { model: string; id?: string }
): BenchmarkSeed | null {
  const table = BENCHMARK_SEEDS[category];
  if (!table) return null;
  // Case-insensitive on both sides: registry ids may carry vendor casing
  // ("Kimi-K2.7-Code") while seed keys are canonical lowercase.
  const byModel = table[ref.model.toLowerCase()];
  if (byModel) return byModel;
  if (ref.id) {
    const byFullId = table[ref.id.toLowerCase()];
    if (byFullId) return byFullId;
  }
  return null;
}
