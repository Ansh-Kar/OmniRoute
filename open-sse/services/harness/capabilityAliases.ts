/**
 * Capability aliases — reserved bare model names that route by WHAT the work
 * is, not by which vendor serves it (harness Layer 3, build B1).
 *
 * `model: "code"` / `"vision"` / `"reasoning"` / `"math"` / `"research"` /
 * `"search"` / `"chat"` behave like any other model id on every chat-shaped
 * surface, but resolve — at request time, every request — to an ephemeral
 * PRIORITY combo over the tag index's current best specialists for that
 * capability. Because the alias IS a combo, the entire native combo
 * machinery applies: priority failover across candidates, admission,
 * circuit breakers, quota-share, translation, streaming. When a vendor
 * ships a better model tomorrow, the alias tracks it without any edit.
 *
 * Resolution is hooked at `getComboForModel` (src/sse/services/model.ts) —
 * AFTER exact combo-name and model-combo-mapping lookups, BEFORE ordinary
 * model resolution — so:
 *   - operator-owned combos always win (an operator who names a combo "code"
 *     overrides the alias, deliberately);
 *   - aliases are reserved words only in the bare, unprefixed form
 *     (`provider/code` still means a literal model under that provider);
 *   - if the index resolves nothing (empty category, everything filtered),
 *     the alias returns null and the request falls through to normal model
 *     resolution — a 404 from the model layer, never a silent wrong route.
 */

import {
  findModelsByTags,
  getModelTagIndex,
  TASK_TYPE_TO_QUERY,
  type BenchmarkAxis,
  type TaskType,
} from "../modelTags/index.ts";

/** How many specialists an alias combo keeps as failover candidates. */
export const CAPABILITY_ALIAS_SIZE = 6;

export type CapabilityAliasSpec = {
  /** Tag-index category the alias retrieves from. */
  category: TaskType;
  /** Ranking precedence — first axis with any seed data wins. */
  axes: readonly BenchmarkAxis[];
  description: string;
};

/**
 * The reserved alias table. Keys are matched against the bare model string,
 * case-sensitively (model ids are; operators get lowercase by convention).
 */
export const CAPABILITY_ALIASES: Record<string, CapabilityAliasSpec> = {
  code: { category: "code", axes: ["swe_bench", "humaneval"], description: "best coding specialists (SWE-bench ranked)" },
  vision: { category: "vision", axes: [], description: "best vision-capable models" },
  reasoning: { category: "reasoning", axes: ["gpqa", "mmlu"], description: "best reasoning models (GPQA ranked)" },
  math: { category: "math", axes: ["math500", "gpqa"], description: "best math models (MATH-500 ranked)" },
  research: { category: "research", axes: [], description: "search-grounded research models" },
  search: { category: "search", axes: [], description: "web-search models" },
  chat: { category: "chat", axes: ["lmarena_elo"], description: "best general assistants (LMArena ranked)" },
};

/** Membership test for untrusted input (fast path for the routing seam). */
export function isCapabilityAlias(name: unknown): name is string {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(CAPABILITY_ALIASES, name);
}

export type CapabilityAliasCombo = {
  name: string;
  description: string;
  strategy: "priority";
  models: Array<{ model: string }>;
  config: Record<string, unknown>;
  /** Marks the combo as ephemeral (not a DB row) for logs and introspection. */
  _capabilityAlias: true;
};

/**
 * Build the ephemeral combo for a capability alias. Returns null when the
 * name is not an alias or the index resolves no candidate even after the
 * category fallback — callers then fall through to ordinary model
 * resolution.
 *
 * Pure w.r.t. the DB: it reads only the tag index (static registry data),
 * mirroring fusion's panelFromTags resolution discipline.
 */
export function buildCapabilityAliasCombo(name: string): CapabilityAliasCombo | null {
  const spec = isCapabilityAlias(name) ? CAPABILITY_ALIASES[name] : null;
  if (!spec) return null;
  const taskQuery = TASK_TYPE_TO_QUERY[spec.category];
  const index = getModelTagIndex();

  const query = (overrides: Partial<Parameters<typeof findModelsByTags>[1]> = {}) =>
    findModelsByTags(index, {
      category: taskQuery.category,
      requireTools: taskQuery.requireTools,
      requireVision: taskQuery.requireVision,
      axis: spec.axes[0],
      distinctModels: true,
      diverseProviders: true,
      limit: CAPABILITY_ALIAS_SIZE,
      ...overrides,
    });

  let candidates = query();
  if (candidates.length === 0 && taskQuery.fallbackCategory) {
    // e.g. no search-registry models connected → fall back to chat so the
    // alias still routes somewhere sensible instead of 404ing.
    candidates = query({ category: taskQuery.fallbackCategory, axis: spec.axes[0] });
  }
  if (candidates.length === 0 && (taskQuery.requireTools || taskQuery.requireVision)) {
    // Capability floor excluded everything (sparse catalog) → drop the floor,
    // keep the category ranking. Better a capable-category model without the
    // confirmed flag than a dead alias.
    candidates = query({ requireTools: undefined, requireVision: undefined });
  }
  if (candidates.length === 0 && taskQuery.fallbackCategory) {
    candidates = query({
      category: taskQuery.fallbackCategory,
      requireTools: undefined,
      requireVision: undefined,
    });
  }
  if (candidates.length === 0) return null;

  return {
    name,
    description: `capability alias — ${spec.description}`,
    strategy: "priority",
    models: candidates.map((entry) => ({ model: entry.id })),
    config: {},
    _capabilityAlias: true,
  };
}
