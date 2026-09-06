/**
 * Model tags — public API of the fork's model-retrieval vocabulary.
 *
 * Consumers:
 *   - combo fusion dispatch (config.panelFromTags → parallel panels):
 *     open-sse/services/combo/dispatchPrelude.ts
 *   - HTTP retrieval: src/app/api/models/tags/route.ts
 *   - docs: docs/guides/PARALLEL_EXECUTION.md
 *
 * Everything is re-exported from the leaf modules so import sites never
 * depend on internal file layout.
 */

export {
  CATEGORY_TO_FITNESS_TASK,
  MODEL_CATEGORIES,
  MODEL_CATEGORY_LABELS,
  MODEL_CATEGORY_SET,
  isModelCategory,
} from "./taxonomy.ts";
export type { ModelCategory } from "./taxonomy.ts";

export { inferModelCategories } from "./inference.ts";
export type { ModelCapabilityHints } from "./inference.ts";

export { BENCHMARK_SEEDS, lookupBenchmarkSeed } from "./seedBenchmarks.ts";
export type { BenchmarkSeed } from "./seedBenchmarks.ts";

export {
  TAG_PANEL_MAX_SIZE,
  buildFusionPanelFromTags,
  buildModelTagIndex,
  findModelsByTags,
} from "./tagIndex.ts";
export type {
  BuildModelTagIndexOptions,
  MediaModelSource,
  ModelTagEntry,
  ModelTagIndex,
  ModelTagQuery,
  RegistryModelLike,
  ScoreLookup,
  TagPanelResolution,
  TagPanelSpec,
} from "./tagIndex.ts";

export {
  collectMediaModels,
  getModelTagIndex,
  parseTagPanelSpec,
  resetModelTagIndexCache,
  resolveFusionTagPanel,
} from "./liveIndex.ts";
