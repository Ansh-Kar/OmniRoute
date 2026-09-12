/**
 * Route-side embedding source for the classifier's stage 1.5 (B14).
 * Implements ClassifierEmbed against OmniRoute's OWN /v1/embeddings via
 * self-fetch — the call runs the full native pipeline (embedding provider
 * selection, failover, credentials) with zero duplication.
 *
 * Model resolution honors the total Hermes abstraction: no model naming is
 * required. An explicit `embeddingModel` wins; otherwise the first
 * configured embedding model is resolved by reading this server's own
 * GET /v1/embeddings models list (the catalog route stays the single
 * authority on what is configured; 60s cache). When no embedding model is
 * configured — or the call fails or times out — the embedder returns null
 * and the classifier degrades to its next stage.
 */

import { selfFetchEmbeddings, selfFetchList } from "./selfFetch";
import type { ClassifierEmbed } from "@omniroute/open-sse/services/harness/classifier.ts";

const DEFAULT_MODEL_TTL_MS = 60_000;

type CatalogEntry = { id?: unknown; type?: unknown; dimensions?: unknown };

let defaultModelCache: { model: string | null; at: number } | null = null;

/** First configured embedding model (via GET /v1/embeddings, 60s cache);
 *  null when none exist. Never throws. */
async function resolveDefaultEmbeddingModel(incoming: Request): Promise<string | null> {
  if (defaultModelCache && Date.now() - defaultModelCache.at < DEFAULT_MODEL_TTL_MS) {
    return defaultModelCache.model;
  }
  let model: string | null = null;
  try {
    const response = await selfFetchList("/api/v1/embeddings", incoming);
    if (response.ok) {
      const payload = (await response.json()) as { data?: CatalogEntry[] };
      const data = Array.isArray(payload.data) ? payload.data : [];
      const usable = data.filter(
        (entry): entry is { id: string; dimensions?: unknown } =>
          entry.type === "embedding" && typeof entry.id === "string" && entry.id.length > 0
      );
      // Prefer the first model with known vector dimensions (the centroid
      // math is dimension-sensitive), else the first listed.
      const preferred =
        usable.find((entry) => typeof entry.dimensions === "number" && (entry.dimensions as number) > 0) ??
        usable[0];
      model = preferred?.id ?? null;
    }
  } catch {
    model = null; // list unavailable → embeddings stage silently off
  }
  defaultModelCache = { model, at: Date.now() };
  return model;
}

/** Test hook: drop the default-model cache. */
export function clearDefaultEmbeddingModelCache(): void {
  defaultModelCache = null;
}

export type SelfFetchEmbedderOptions = {
  /** The incoming request — its auth headers ride the internal fetch. */
  incoming: Request;
  /** Explicit embedding model (overrides the catalog default). */
  model?: string;
  /** Per-call budget. Default 2500ms — refinement, never a stall. */
  timeoutMs?: number;
};

/**
 * Build a ClassifierEmbed wired to this server's /v1/embeddings. NEVER
 * throws: any failure returns null so the classifier degrades downward.
 */
export function makeSelfFetchEmbedder(options: SelfFetchEmbedderOptions): ClassifierEmbed {
  return async (texts: string[]) => {
    try {
      const model = options.model?.trim() || (await resolveDefaultEmbeddingModel(options.incoming));
      if (!model) return null;
      const response = await selfFetchEmbeddings({
        incoming: options.incoming,
        body: { model, input: texts },
        timeoutMs: options.timeoutMs ?? 2_500,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        model?: unknown;
        data?: Array<{ index?: unknown; embedding?: unknown }>;
      };
      if (!Array.isArray(payload.data)) return null;
      // OpenAI shape: data[i].embedding with an optional index field.
      const byIndex = new Map<number, number[]>();
      for (const entry of payload.data) {
        if (!entry || typeof entry !== "object") continue;
        const embedding = entry.embedding;
        if (
          !Array.isArray(embedding) ||
          embedding.length === 0 ||
          !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
        ) {
          continue;
        }
        byIndex.set(typeof entry.index === "number" ? entry.index : byIndex.size, embedding as number[]);
      }
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        const vector = byIndex.get(i);
        if (!vector) return null; // incomplete batch — never partially trust
        vectors.push(vector);
      }
      return {
        model: typeof payload.model === "string" && payload.model ? payload.model : model,
        vectors,
      };
    } catch {
      return null; // the classifier must never break on the embedding source
    }
  };
}
