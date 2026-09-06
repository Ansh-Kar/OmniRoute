/**
 * Model category inference — pattern + capability-flag heuristics.
 *
 * Existence reason (fork: parallel execution): the tag index
 * (open-sse/services/modelTags/tagIndex.ts) must categorize ~1200 models
 * across 233 providers without hand-maintaining a per-model list. Three
 * signals compose, in increasing trust:
 *
 *   1. Capability flags from the provider registry (`supportsVision`,
 *      `supportsReasoning`, `toolCalling`) — authoritative when present.
 *   2. Versioned name patterns below — curated, deliberately conservative
 *      (false negatives are acceptable: an uncategorized model is still
 *      retrievable as `chat`; false positives are NOT acceptable: a model
 *      tagged `coder` that cannot code poisons every panel built from it).
 *   3. Curated benchmark seeds (seedBenchmarks.ts) — which only ever ADD a
 *      score to an already-categorized model, never invent a category.
 *
 * Patterns follow the same discipline as taskFitness's FITNESS_TABLE
 * (#11503): they must not adopt whole model families by loose substring.
 * Every pattern is anchored on distinctive tokens (`whisper`, `dall-e`,
 * `-coder`, …) that are unambiguous about the model's modality.
 */

import { MODALITY_CATEGORIES, type ModelCategory } from "./taxonomy.ts";

/** Capability hints the provider registry already knows about a model. */
export type ModelCapabilityHints = {
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  toolCalling?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  contextLength?: number;
};

/**
 * Conservative id-pattern table. Order matters only for readability — the
 * caller collects EVERY match into a set, so overlapping patterns are fine.
 *
 * Patterns run against the lowercased bare model id (provider prefix
 * stripped). Word boundaries (`\b`) guard against substring accidents
 * ("encode" must not match "code").
 */
const CATEGORY_PATTERNS: ReadonlyArray<readonly [ModelCategory, RegExp]> = [
  // ── Audio ────────────────────────────────────────────────────────────────
  ["speech-to-text", /(^|[-/_])(whisper|stt)([-/_]|$)|transcri/],
  ["text-to-speech", /(^|[-/_])(tts|speech-synth|voice-synth)([-/_]|$)|text-to-speech/],
  // ── Image generation / editing ───────────────────────────────────────────
  [
    "image-gen",
    /(^|[-/.])(dall-e|dalle|imagen|flux|sdxl|stable-diffusion|seedream|gpt-image|recraft|ideogram|firefly-image|kolors|hidream)([-/.]|$)/,
  ],
  ["image-edit", /(^|[-/_])(inpaint|image-edit|photo-edit|image-variation)([-/_]|$)/],
  // ── Video generation ─────────────────────────────────────────────────────
  [
    "video-gen",
    /(^|[-/_])(veo|sora|kling|hailuo|runway|seedance|wan2|video-gen|text-to-video)([-/_]|$)/,
  ],
  // ── Music ────────────────────────────────────────────────────────────────
  ["music-gen", /(^|[-/_])(music-gen|text-to-music|suno|lyria)([-/_]|$)/],
  // ── Utility modalities ───────────────────────────────────────────────────
  ["embedding", /(^|[-/.])(embed|embedding|bge-|gte-|e5-|jina-embed)([-/.]|$)|^text-embedding/],
  ["rerank", /(^|[-/_])(rerank|re-rank)([-/_]|$)/],
  ["ocr", /(^|[-/_])(ocr|pixtral-ocr)([-/_]|$)/],
  ["search", /(^|[-/_])(sonar|online[-/_]search|web-search)([-/_]|$)/],
  ["moderation", /(^|[-/_])(moderation|guardrail|omni-moderation)([-/_]|$)/],
  ["upscale", /(^|[-/_])(upscale|upscaler|esrgan)([-/_]|$)/],
  // ── Chat capability overlays ─────────────────────────────────────────────
  ["coder", /(^|[-/.])(codex|coder|coding|codegemma|starcoder|devstral|codestral)([-/.]|$)|-code(-|$)/],
  // Vision: distinctive multimodal families that predate per-model flags.
  ["vision", /(^|[-/.])(qwen[0-9.]*-vl|llama-vision|-vl-|-vision)([-/.]|$)/],
];

/**
 * Infer the category tag set for one model.
 *
 * - Registry capability flags (hints) always win and only ADD tags.
 * - A modality match (image-gen, whisper, …) suppresses the base `chat`
 *   tag: media models are not chat models.
 * - Everything else lands on the neutral `chat` base, plus `vision` /
 *   `reasoning` overlays when the flags say so.
 */
export function inferModelCategories(
  modelId: string,
  hints: ModelCapabilityHints = {}
): ModelCategory[] {
  const id = (modelId ?? "").trim().toLowerCase();
  const categories = new Set<ModelCategory>();

  if (id) {
    for (const [category, pattern] of CATEGORY_PATTERNS) {
      if (pattern.test(id)) categories.add(category);
    }
  }

  // Capability overlays from the registry — additive, trusted.
  if (hints.supportsVision) categories.add("vision");
  if (hints.supportsReasoning) categories.add("reasoning");

  const hasModality = [...categories].some((c) => MODALITY_CATEGORIES.has(c));
  if (!hasModality) categories.add("chat");

  // Sort for stable snapshots (deterministic index output → stable tests).
  return [...categories].sort();
}
