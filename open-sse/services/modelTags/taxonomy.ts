/**
 * Model tag taxonomy — the fork's model-retrieval vocabulary.
 *
 * Existence reason (fork: parallel execution): OmniRoute already knows a LOT
 * about each model — which provider owns it (provider registry), whether it
 * supports vision/tools/reasoning (`RegistryModel` capability flags), which
 * media endpoint family it serves (image/audio/video/rerank/… registries) and
 * how fit it is per task (taskFitness layers). What it lacked was ONE uniform
 * retrieval vocabulary: "give me the top-N coder models across DIFFERENT
 * providers" had to be answered by hand-maintaining combo model lists.
 *
 * This module defines the category tags every model in the tag index carries
 * (`open-sse/services/modelTags/tagIndex.ts`). Categories are deliberately
 * coarse and user-facing — they are what an operator types into
 * `panelFromTags.category` or `GET /api/models/tags?category=…`, not an
 * internal capability matrix. Capability detail (tools, context length,
 * vision) rides alongside as entry fields, not as categories.
 */

/**
 * The closed category vocabulary.
 *
 * - `chat` is the base category every conversational model carries.
 * - Capability overlays (`coder`, `reasoning`, `vision`) stack on `chat`.
 * - Modality categories (`image-gen`, `speech-to-text`, …) REPLACE the base
 *   `chat` tag: a model whose job is generating images is not a chat model,
 *   even when it is addressed through a chat-shaped endpoint.
 */
export const MODEL_CATEGORIES = [
  // Conversational base + capability overlays
  "chat",
  "coder",
  "reasoning",
  "vision",
  // Media generation / understanding modalities
  "image-gen",
  "image-edit",
  "video-gen",
  "speech-to-text",
  "text-to-speech",
  "music-gen",
  // Utility modalities
  "embedding",
  "rerank",
  "ocr",
  "search",
  "moderation",
  "upscale",
] as const;

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

/** Fast membership test for untrusted input (API query params, combo config). */
export const MODEL_CATEGORY_SET: ReadonlySet<string> = new Set(MODEL_CATEGORIES);

/** Categories that describe a non-chat modality (see taxonomy header). */
export const MODALITY_CATEGORIES: ReadonlySet<ModelCategory> = new Set([
  "image-gen",
  "image-edit",
  "video-gen",
  "speech-to-text",
  "text-to-speech",
  "music-gen",
  "embedding",
  "rerank",
  "ocr",
  "search",
  "moderation",
  "upscale",
] as const satisfies readonly ModelCategory[]);

/** Human labels for API responses and dashboard rendering. */
export const MODEL_CATEGORY_LABELS: Record<ModelCategory, string> = {
  chat: "Chat",
  coder: "Coding",
  reasoning: "Reasoning",
  vision: "Vision (image understanding)",
  "image-gen": "Image generation",
  "image-edit": "Image editing",
  "video-gen": "Video generation",
  "speech-to-text": "Speech to text",
  "text-to-speech": "Text to speech",
  "music-gen": "Music generation",
  embedding: "Embeddings",
  rerank: "Reranking",
  ocr: "OCR",
  search: "Search-grounded",
  moderation: "Moderation",
  upscale: "Image upscaling",
};

/**
 * Type guard for untrusted category strings (zod schemas and the HTTP API
 * both funnel through this so the vocabulary stays closed).
 */
export function isModelCategory(value: unknown): value is ModelCategory {
  return typeof value === "string" && MODEL_CATEGORY_SET.has(value);
}

/**
 * Category → taskFitness task type, where a direct mapping exists
 * (open-sse/services/autoCombo/taskFitness.ts). The static tag index does
 * NOT read taskFitness (it is DB-backed); this mapping exists so runtime
 * layers can enrich `benchmark` scores from the live fitness/arena layers,
 * and so a `coder` panel and a `coding`-fitness score never drift apart
 * lexically.
 */
export const CATEGORY_TO_FITNESS_TASK: Partial<Record<ModelCategory, string>> = {
  coder: "coding",
  reasoning: "planning",
  vision: "analysis",
  chat: "analysis",
};
