/**
 * Model tag index — provider + category + benchmark retrieval.
 *
 * Existence reason (fork: parallel execution): choosing models for parallel
 * execution had two bad options before this — hand-maintained combo model
 * lists (stale the moment a vendor ships a new version) or ad-hoc client-side
 * filtering of the whole /v1/models catalog. This index is the third option:
 * every catalog model is tagged once (provider, categories, benchmark,
 * capabilities) and retrieval becomes a one-call query:
 *
 *   findModelsByTags(index, { category: "coder", minBenchmark: 80,
 *                             diverseProviders: true, limit: 4 })
 *
 * Purity: the builder takes its inputs as plain data (chat provider→models
 * map + media model list) and every quality number comes from the curated
 * seed table or an injected `scoreLookup` — never from the DB. That keeps
 * this module unit-testable without a database and lets the live layer
 * (liveIndex.ts) enrich scores from taskFitness/arena later without touching
 * this logic.
 */

import { inferModelCategories, type ModelCapabilityHints } from "./inference.ts";
import { lookupBenchmarkSeed, type BenchmarkSeed } from "./seedBenchmarks.ts";
import type { ModelCategory } from "./taxonomy.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** Structural slice of RegistryModel the index consumes (test-friendly). */
export type RegistryModelLike = {
  id: string;
  name?: string;
  contextLength?: number;
  toolCalling?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
};

/** One media-registry model pre-classified by its source registry. */
export type MediaModelSource = {
  /** Full `provider/model` id as addressed on the wire. */
  id: string;
  provider: string;
  model: string;
  category: ModelCategory;
};

/** Runtime score hook: category + model ref → score, or null for "unknown". */
export type ScoreLookup = (
  category: ModelCategory,
  ref: { model: string; id: string; provider: string }
) => number | null | undefined;

export type ModelTagEntry = {
  /** Full `provider/model` string usable directly as a combo model step. */
  id: string;
  /** Bare model id (no provider prefix). */
  model: string;
  /** Canonical provider id. */
  provider: string;
  categories: ModelCategory[];
  /** Present only when a seed or scoreLookup produced a number. */
  benchmark?: { score: number; source: "seed" | "runtime"; basis: string };
  /**
   * Per-overlay-category benchmarks: a model categorized `chat` + `coder`
   * carries its chat score in `benchmark` and its coder score here, so a
   * `coder` query ranks on coder evidence and a `chat` query on chat
   * evidence (see resolveBenchmark in the builder).
   */
  benchmarkOverlays?: Partial<Record<ModelCategory, { score: number; source: "seed" | "runtime"; basis: string }>>;
  contextLength?: number;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
};

export type ModelTagIndex = {
  entries: ModelTagEntry[];
  byCategory: Map<ModelCategory, ModelTagEntry[]>;
  byProvider: Map<string, ModelTagEntry[]>;
  /** Full-id (and bare-model) lookup for membership checks. */
  lookup(idOrModel: string): ModelTagEntry | undefined;
};

export type BuildModelTagIndexOptions = {
  /** Capability hints keyed by bare model id (merged over registry flags). */
  hints?: Record<string, ModelCapabilityHints>;
  /** Runtime benchmark provider (arena/fitness). Takes precedence over seeds. */
  scoreLookup?: ScoreLookup;
  /** Extra/override seeds: category → model → seed. Merged over defaults. */
  benchmarkSeeds?: Partial<Record<ModelCategory, Record<string, BenchmarkSeed>>>;
  /** Providers to skip entirely (e.g. passthrough relays). */
  excludeProviders?: readonly string[];
};

// ── Build ──────────────────────────────────────────────────────────────────

function resolveBenchmark(
  category: ModelCategory,
  ref: { model: string; id: string; provider: string },
  options: BuildModelTagIndexOptions
): ModelTagEntry["benchmark"] {
  if (options.scoreLookup) {
    const score = options.scoreLookup(category, ref);
    if (typeof score === "number" && Number.isFinite(score)) {
      return { score, source: "runtime", basis: "runtime score lookup" };
    }
  }
  const seeds = options.benchmarkSeeds?.[category];
  const normalizedModel = ref.model.toLowerCase();
  const normalizedId = ref.id.toLowerCase();
  const seed =
    (seeds && (seeds[normalizedModel] ?? seeds[ref.model])) ||
    lookupBenchmarkSeed(category, { model: normalizedModel, id: normalizedId });
  return seed ? { score: seed.score, source: "seed", basis: seed.basis } : undefined;
}

/**
 * Build the index from the chat provider registry (provider → models) plus
 * pre-classified media models. Deterministic: providers iterate in insertion
 * order, models in array order, categories sorted — same inputs, same index.
 */
export function buildModelTagIndex(
  chatProviders: Record<string, readonly RegistryModelLike[]>,
  mediaModels: readonly MediaModelSource[] = [],
  options: BuildModelTagIndexOptions = {}
): ModelTagIndex {
  const entries: ModelTagEntry[] = [];
  const byFullId = new Map<string, ModelTagEntry>();
  const byBareModel = new Map<string, ModelTagEntry>();
  const exclude = new Set(options.excludeProviders ?? []);

  const push = (entry: ModelTagEntry) => {
    // First full-id wins (a model offered by many providers keeps one entry
    // per provider — full ids differ — but alias providers sharing the same
    // canonical id collapse to the first-seen entry).
    if (byFullId.has(entry.id)) return;
    entries.push(entry);
    byFullId.set(entry.id, entry);
    if (!byBareModel.has(entry.model)) byBareModel.set(entry.model, entry);
  };

  for (const [providerKey, models] of Object.entries(chatProviders)) {
    if (exclude.has(providerKey)) continue;
    for (const model of models) {
      const id = `${providerKey}/${model.id}`;
      if (byFullId.has(id)) continue;
      const hints = { ...model, ...options.hints?.[model.id] };
      const categories = inferModelCategories(model.id, hints);
      // Benchmark resolves against the entry's PRIMARY category only — the
      // category the operator is retrieving by. Chat overlays (vision,
      // reasoning) resolve their own scores below.
      const primary = categories.includes("chat")
        ? "chat"
        : (categories.find((c) => c !== "vision" && c !== "reasoning") ?? "chat");
      const benchmark = resolveBenchmark(primary, { model: model.id, id, provider: providerKey }, options);
      push({
        id,
        model: model.id,
        provider: providerKey,
        categories,
        benchmark,
        contextLength: model.contextLength,
        tools: model.toolCalling === true,
        vision: model.supportsVision === true,
        reasoning: model.supportsReasoning === true,
      });
      // Capability overlays get their own benchmark resolution so a
      // `vision` panel ranks on vision scores, not chat scores.
      for (const overlay of ["coder", "reasoning", "vision"] as const) {
        if (!categories.includes(overlay) || overlay === primary) continue;
        const overlayBenchmark = resolveBenchmark(
          overlay,
          { model: model.id, id, provider: providerKey },
          options
        );
        if (overlayBenchmark) {
          const target = byFullId.get(id);
          if (target) {
            target.benchmarkOverlays = target.benchmarkOverlays ?? {};
            target.benchmarkOverlays[overlay] = overlayBenchmark;
          }
        }
      }
    }
  }

  for (const media of mediaModels) {
    if (exclude.has(media.provider)) continue;
    if (byFullId.has(media.id)) continue;
    const benchmark = resolveBenchmark(
      media.category,
      { model: media.model, id: media.id, provider: media.provider },
      options
    );
    push({
      id: media.id,
      model: media.model,
      provider: media.provider,
      categories: [media.category],
      benchmark,
      tools: false,
      vision: false,
      reasoning: false,
    });
  }

  const byCategory = new Map<ModelCategory, ModelTagEntry[]>();
  const byProvider = new Map<string, ModelTagEntry[]>();
  for (const entry of entries) {
    for (const category of entry.categories) {
      const list = byCategory.get(category);
      if (list) list.push(entry);
      else byCategory.set(category, [entry]);
    }
    const providers = byProvider.get(entry.provider);
    if (providers) providers.push(entry);
    else byProvider.set(entry.provider, [entry]);
  }

  return {
    entries,
    byCategory,
    byProvider,
    lookup(idOrModel: string) {
      return byFullId.get(idOrModel) ?? byBareModel.get(idOrModel);
    },
  };
}

// ── Query ──────────────────────────────────────────────────────────────────

export type ModelTagQuery = {
  category?: ModelCategory;
  /** Single provider filter (id or alias — matched exactly). */
  provider?: string;
  /** Provider allowlist. */
  providers?: readonly string[];
  excludeProviders?: readonly string[];
  /** 0..100; entries without a benchmark never pass a > 0 threshold. */
  minBenchmark?: number;
  requireTools?: boolean;
  requireVision?: boolean;
  minContextLength?: number;
  limit?: number;
  /** Round-robin across providers instead of pure score order. */
  diverseProviders?: boolean;
  /**
   * Collapse entries that share the same bare model id (the same model is
   * offered by many provider keys — relays, gateways, mirrors). Each model
   * is represented once, by its most canonical provider (see
   * FIRST_PARTY_PROVIDER_ORDER). Essential for panels: "4 providers" must
   * mean 4 different models, not one model through 4 frontdoors.
   */
  distinctModels?: boolean;
};

/**
 * Preference order for picking a model's canonical entry when the same bare
 * model is offered by many provider keys. First-party vendor keys come
 * first; everything else ties at Infinity and falls back to score, then
 * stable id order. Data, not logic — extend freely.
 */
export const FIRST_PARTY_PROVIDER_ORDER: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "gemini",
  "vertex",
  "moonshot",
  "kimi",
  "minimax",
  "zhipu",
  "glm",
  "xai",
  "deepseek",
  "alibaba",
  "qwen",
  "mistral",
  "cohere",
  "perplexity",
  "elevenlabs",
];

const FIRST_PARTY_RANK = new Map(FIRST_PARTY_PROVIDER_ORDER.map((p, i) => [p, i]));

function canonicalRank(entry: ModelTagEntry): number {
  return FIRST_PARTY_RANK.get(entry.provider) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Keep one entry per bare model id (lowercased): the canonical provider
 * preferred, then benchmark, then stable id order.
 */
function collapseToDistinctModels(sorted: ModelTagEntry[]): ModelTagEntry[] {
  const best = new Map<string, ModelTagEntry>();
  for (const entry of sorted) {
    const key = entry.model.toLowerCase();
    const incumbent = best.get(key);
    if (!incumbent) {
      best.set(key, entry);
      continue;
    }
    const rankNew = canonicalRank(entry);
    const rankOld = canonicalRank(incumbent);
    if (rankNew !== rankOld) {
      if (rankNew < rankOld) best.set(key, entry);
      continue;
    }
    if ((entry.benchmark?.score ?? -1) > (incumbent.benchmark?.score ?? -1)) {
      best.set(key, entry);
    }
  }
  // Preserve the incoming (score) order.
  return sorted.filter((entry) => best.get(entry.model.toLowerCase()) === entry);
}

function entryBenchmarkFor(entry: ModelTagEntry, category?: ModelCategory): number | null {
  if (category) {
    const overlay = entry.benchmarkOverlays?.[category];
    if (overlay) return overlay.score;
  }
  return entry.benchmark ? entry.benchmark.score : null;
}

function matchesQuery(entry: ModelTagEntry, query: ModelTagQuery): boolean {
  if (query.category && !entry.categories.includes(query.category)) return false;
  if (query.provider && entry.provider !== query.provider) return false;
  if (query.providers && query.providers.length > 0 && !query.providers.includes(entry.provider))
    return false;
  if (query.excludeProviders && query.excludeProviders.includes(entry.provider)) return false;
  if (query.requireTools && !entry.tools) return false;
  if (query.requireVision && !entry.vision) return false;
  if (query.minContextLength && (entry.contextLength ?? 0) < query.minContextLength) return false;
  if (query.minBenchmark !== undefined && query.minBenchmark > 0) {
    const score = entryBenchmarkFor(entry, query.category);
    if (score === null || score < query.minBenchmark) return false;
  }
  return true;
}

function sortEntries(index: ModelTagIndex, query: ModelTagQuery): ModelTagEntry[] {
  const pool = query.category
    ? (index.byCategory.get(query.category) ?? [])
    : index.entries;
  const filtered = pool.filter((entry) => matchesQuery(entry, query));
  filtered.sort((a, b) => {
    const scoreA = entryBenchmarkFor(a, query.category);
    const scoreB = entryBenchmarkFor(b, query.category);
    if (scoreA !== scoreB) {
      if (scoreA === null) return 1; // unscored sorts last — "no evidence"
      if (scoreB === null) return -1;
      return scoreB - scoreA;
    }
    if (scoreA === null) {
      // Both unscored: larger context wins, then stable id order.
      return (b.contextLength ?? 0) - (a.contextLength ?? 0) || (a.id < b.id ? -1 : 1);
    }
    return (b.contextLength ?? 0) - (a.contextLength ?? 0) || (a.id < b.id ? -1 : 1);
  });
  return filtered;
}

/**
 * Provider-diverse interleaving: take each provider's best remaining entry in
 * turn (round-robin by descending per-provider score). This is what makes a
 * fusion panel genuinely multi-provider: pure score order would happily fill
 * the whole panel from one vendor's tiered variants.
 */
function interleaveByProvider(sorted: ModelTagEntry[]): ModelTagEntry[] {
  const byProvider = new Map<string, ModelTagEntry[]>();
  for (const entry of sorted) {
    const list = byProvider.get(entry.provider);
    if (list) list.push(entry);
    else byProvider.set(entry.provider, [entry]);
  }
  const out: ModelTagEntry[] = [];
  const queues = [...byProvider.values()];
  for (let round = 0; ; round++) {
    let added = false;
    for (const queue of queues) {
      if (round < queue.length) {
        out.push(queue[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** Retrieve models by tag query. Pure; does not touch the DB or network. */
export function findModelsByTags(
  index: ModelTagIndex,
  query: ModelTagQuery = {}
): ModelTagEntry[] {
  let sorted = sortEntries(index, query);
  if (query.distinctModels) sorted = collapseToDistinctModels(sorted);
  if (query.diverseProviders) sorted = interleaveByProvider(sorted);
  return query.limit ? sorted.slice(0, query.limit) : sorted;
}

// ── Fusion panel construction ──────────────────────────────────────────────

/** Mirrors FUSION_DEFAULTS.maxPanel (open-sse/services/fusion.ts). */
export const TAG_PANEL_MAX_SIZE = 40;

export type TagPanelSpec = {
  category: ModelCategory;
  /** Panel size. Default 4, clamped to [2, TAG_PANEL_MAX_SIZE]. */
  size?: number;
  /** 0..100 minimum benchmark. Default 0 (no floor). */
  minBenchmark?: number;
  /**
   * HARD cap on models per provider. Default 1 — the multi-provider
   * guarantee: a panel of N needs N distinct providers, and a category with
   * fewer providers yields a smaller panel (flagged `truncated`) rather than
   * padding with same-provider models. Raise it to let strong providers
   * contribute more than one distinct model.
   */
  perProvider?: number;
  providers?: readonly string[];
  excludeProviders?: readonly string[];
  requireTools?: boolean;
  requireVision?: boolean;
};

export type TagPanelResolution = {
  /** Full `provider/model` strings, panel order (best first per round). */
  models: string[];
  entries: ModelTagEntry[];
  requestedSize: number;
  /** True when fewer models than requested passed the spec. */
  truncated: boolean;
};

/**
 * Build a provider-diverse fusion panel from tags: the retrieval call that
 * backs `combo.config.panelFromTags` (fork: parallel execution).
 *
 * Composition: `findModelsByTags` with `distinctModels: true` (one entry per
 * bare model — its canonical provider) and `diverseProviders: true`
 * (best-per-provider round-robin). `perProvider` then caps how many picks
 * may come from the same provider (default 1; the cap matters when
 * perProvider > 1). Result: a panel of DIFFERENT models from DIFFERENT
 * providers — "multiple models from multiple providers working
 * simultaneously", not one model through N frontdoors.
 */
export function buildFusionPanelFromTags(
  index: ModelTagIndex,
  spec: TagPanelSpec
): TagPanelResolution {
  const requestedSize = Math.min(
    Math.max(Math.floor(spec.size ?? 4), 2),
    TAG_PANEL_MAX_SIZE
  );
  const perProvider = Math.max(Math.floor(spec.perProvider ?? 1), 1);
  const diverse = findModelsByTags(index, {
    category: spec.category,
    minBenchmark: spec.minBenchmark,
    providers: spec.providers,
    excludeProviders: spec.excludeProviders,
    requireTools: spec.requireTools,
    requireVision: spec.requireVision,
    distinctModels: true,
    diverseProviders: true,
  });
  const perProviderCount = new Map<string, number>();
  const picked: ModelTagEntry[] = [];
  for (const entry of diverse) {
    if (picked.length >= requestedSize) break;
    const used = perProviderCount.get(entry.provider) ?? 0;
    if (used >= perProvider) continue;
    perProviderCount.set(entry.provider, used + 1);
    picked.push(entry);
  }
  return {
    models: picked.map((entry) => entry.id),
    entries: picked,
    requestedSize,
    truncated: picked.length < requestedSize,
  };
}
