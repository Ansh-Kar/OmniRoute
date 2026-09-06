/**
 * Live model tag index — assembles the pure tag index from the real
 * provider/media registries, and resolves fusion tag panels at dispatch.
 *
 * Existence reason (fork: parallel execution): tagIndex.ts is pure data-in /
 * data-out so it stays unit-testable; THIS file is the only place that knows
 * where the data comes from (the chat provider registry + the media
 * registries). Keeping the two apart means the retrieval semantics can be
 * tested without importing 233 provider configs, while the live singleton is
 * still one import away for the combo dispatcher and the HTTP API.
 */

import { getAllImageModels } from "../../config/imageRegistry.ts";
import { getAllRerankModels } from "../../config/rerankRegistry.ts";
import { getAllVideoModels } from "../../config/videoRegistry.ts";
import {
  AUDIO_SPEECH_PROVIDERS,
  AUDIO_TRANSCRIPTION_PROVIDERS,
} from "../../config/audioRegistry.ts";
import { EMBEDDING_PROVIDERS } from "../../config/embeddingRegistry.ts";
import { MODERATION_PROVIDERS } from "../../config/moderationRegistry.ts";
import { MUSIC_PROVIDERS } from "../../config/musicRegistry.ts";
import { OCR_PROVIDERS } from "../../config/ocrRegistry.ts";
import { SEARCH_PROVIDERS } from "../../config/searchRegistry.ts";
import { UPSCALE_PROVIDERS } from "../../config/upscaleRegistry.ts";
import { generateModels } from "../../config/providerRegistry.ts";
import type { ComboLogger } from "../combo/types.ts";
import {
  buildFusionPanelFromTags,
  buildModelTagIndex,
  type MediaModelSource,
  type ModelTagIndex,
  type TagPanelResolution,
  type TagPanelSpec,
} from "./tagIndex.ts";
import { isModelCategory, type ModelCategory } from "./taxonomy.ts";

/** Structural slice of a media provider config that carries models. */
type ProviderWithModels = { models?: ReadonlyArray<{ id: string }> };

/**
 * Collect media/utility-registry models, pre-classified by source registry.
 * Full `provider/model` ids are preserved exactly as each registry emits
 * them, so a tag-resolved id is wire-addressable without translation.
 */
export function collectMediaModels(): MediaModelSource[] {
  const out: MediaModelSource[] = [];

  const fromProviders = (
    providers: Record<string, unknown>,
    category: ModelCategory
  ) => {
    for (const [providerKey, config] of Object.entries(providers)) {
      const models = (config as ProviderWithModels | null)?.models ?? [];
      for (const model of models) {
        if (!model?.id) continue;
        out.push({
          id: `${providerKey}/${model.id}`,
          provider: providerKey,
          model: model.id,
          category,
        });
      }
    }
  };

  // Audio: transcription vs speech are separate provider maps.
  fromProviders(AUDIO_TRANSCRIPTION_PROVIDERS as unknown as Record<string, unknown>, "speech-to-text");
  fromProviders(AUDIO_SPEECH_PROVIDERS as unknown as Record<string, unknown>, "text-to-speech");

  fromProviders(EMBEDDING_PROVIDERS as unknown as Record<string, unknown>, "embedding");
  fromProviders(MODERATION_PROVIDERS as unknown as Record<string, unknown>, "moderation");
  fromProviders(MUSIC_PROVIDERS as unknown as Record<string, unknown>, "music-gen");
  fromProviders(OCR_PROVIDERS as unknown as Record<string, unknown>, "ocr");
  fromProviders(SEARCH_PROVIDERS as unknown as Record<string, unknown>, "search");
  fromProviders(UPSCALE_PROVIDERS as unknown as Record<string, unknown>, "upscale");

  for (const entry of getAllRerankModels()) {
    out.push({
      id: entry.id,
      provider: entry.provider,
      model: entry.id.includes("/") ? entry.id.slice(entry.id.indexOf("/") + 1) : entry.id,
      category: "rerank",
    });
  }

  for (const entry of getAllVideoModels()) {
    const slash = entry.id.indexOf("/");
    out.push({
      id: entry.id,
      provider: slash > 0 ? entry.id.slice(0, slash) : "video",
      model: slash > 0 ? entry.id.slice(slash + 1) : entry.id,
      category: "video-gen",
    });
  }

  for (const entry of getAllImageModels()) {
    const acceptsImage = (entry.inputModalities ?? []).includes("image");
    out.push({
      id: entry.id,
      provider: entry.provider,
      model: entry.id.includes("/") ? entry.id.slice(entry.id.indexOf("/") + 1) : entry.id,
      category: "image-gen",
    });
    if (acceptsImage) {
      out.push({
        id: entry.id,
        provider: entry.provider,
        model: entry.id.includes("/") ? entry.id.slice(entry.id.indexOf("/") + 1) : entry.id,
        category: "image-edit",
      });
    }
  }

  return out;
}

/**
 * Process-wide singleton. Built lazily on first use (the provider registry is
 * a large static import; dashboards and combos that never touch tags never
 * pay for it) and never invalidated — the underlying registries are
 * build-time constants. Tests that need determinism build their own index
 * with buildModelTagIndex instead of touching this cache.
 */
let cachedIndex: ModelTagIndex | null = null;

export function getModelTagIndex(): ModelTagIndex {
  if (!cachedIndex) {
    cachedIndex = buildModelTagIndex(generateModels(), collectMediaModels());
  }
  return cachedIndex;
}

/** Test/CLI escape hatch: drop the singleton so the next call rebuilds. */
export function resetModelTagIndexCache(): void {
  cachedIndex = null;
}

// ── Fusion tag-panel resolution (combo.config.panelFromTags) ───────────────

/**
 * Parse an untrusted combo config object into a TagPanelSpec. Returns null
 * when `panelFromTags` is absent or malformed — the caller then falls back to
 * the combo's literal model list, exactly as before the fork.
 */
export function parseTagPanelSpec(value: unknown): TagPanelSpec | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isModelCategory(raw.category)) return null;
  const spec: TagPanelSpec = { category: raw.category };
  // Numeric strings coerce (zod's z.coerce may not have run on legacy rows).
  const toNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return undefined;
  };
  const size = toNumber(raw.size);
  if (size !== undefined) spec.size = Math.floor(size);
  const minBenchmark = toNumber(raw.minBenchmark);
  if (minBenchmark !== undefined) spec.minBenchmark = Math.min(Math.max(minBenchmark, 0), 100);
  const perProvider = toNumber(raw.perProvider);
  if (perProvider !== undefined) spec.perProvider = Math.max(Math.floor(perProvider), 1);
  if (Array.isArray(raw.providers)) {
    const providers = raw.providers.filter((p): p is string => typeof p === "string" && p.trim() !== "");
    if (providers.length > 0) spec.providers = providers;
  }
  if (Array.isArray(raw.excludeProviders)) {
    const excludeProviders = raw.excludeProviders.filter(
      (p): p is string => typeof p === "string" && p.trim() !== ""
    );
    if (excludeProviders.length > 0) spec.excludeProviders = excludeProviders;
  }
  if (raw.requireTools === true) spec.requireTools = true;
  if (raw.requireVision === true) spec.requireVision = true;
  return spec;
}

/**
 * Resolve the fusion panel for one combo config. Returns null when the combo
 * does not opt into tag panels (the pre-fusion literal-list path). Logs the
 * resolution so operators can see which models a tag panel expanded to.
 */
export function resolveFusionTagPanel(
  cfg: Record<string, unknown> | null | undefined,
  opts: { comboName: string; log: ComboLogger }
): TagPanelResolution | null {
  if (!cfg || cfg.panelFromTags === undefined || cfg.panelFromTags === null) return null;
  const spec = parseTagPanelSpec(cfg.panelFromTags);
  if (!spec) {
    opts.log.warn(
      "COMBO",
      `Combo "${opts.comboName}" has a malformed config.panelFromTags (category missing or invalid) — ignoring it and using the literal model list`
    );
    return null;
  }
  const resolution = buildFusionPanelFromTags(getModelTagIndex(), spec);
  if (resolution.models.length === 0) {
    opts.log.warn(
      "COMBO",
      `Combo "${opts.comboName}" panelFromTags (category "${spec.category}") matched no models — using the literal model list`
    );
    return null;
  }
  if (resolution.truncated) {
    opts.log.warn(
      "COMBO",
      `Combo "${opts.comboName}" panelFromTags (category "${spec.category}") resolved only ${resolution.models.length} of ${resolution.requestedSize} panel models`
    );
  } else {
    opts.log.info(
      "COMBO",
      `Combo "${opts.comboName}" panelFromTags (category "${spec.category}") resolved ${resolution.models.length} models: ${resolution.models.join(", ")}`
    );
  }
  return resolution;
}
