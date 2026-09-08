/**
 * Runtime benchmark wiring for the tag index (harness B8, roadmap §6):
 * feed the DB-backed taskFitness stack (user override → arena ELO →
 * models.dev tier) into the index build as the `scoreLookup` hook, so
 * operator-scored reality overrides the static seed ballparks.
 *
 * Discipline (seedBenchmarks.md): the index build itself never touches the
 * DB — the lookup is INJECTED here, at the live singleton's composition
 * root. Only DB-backed sources are honored ("user_override", "arena_elo",
 * "models_dev_tier"); the fitness stack's own static fallback table is a
 * DIFFERENT static layer and would just launder one set of ballparks into
 * another, so it is deliberately not mapped (null → seeds stay).
 *
 * Static import by design: every consumer of the live index already
 * bundles the DB layer (combos, autoCombo), and the fitness stack is
 * resilient headless — queryModelIntelligence catches a missing DB and
 * returns null, which falls through to the seeds here.
 */

import { getTaskFitnessWithSource } from "../autoCombo/taskFitness.ts";
import type { ModelCategory } from "./taxonomy.ts";
import type { ScoreLookup } from "./tagIndex.ts";

/**
 * Tag-index categories with a semantically matching taskFitness task type.
 * Categories without a row here (chat, vision, media, search, …) have no
 * honest DB-backed counterpart and keep their seed/axis ranking.
 */
const CATEGORY_TO_FITNESS_TASK: Partial<Record<ModelCategory, string>> = {
  coder: "coding",
  reasoning: "analysis",
};

const DB_BACKED_SOURCES = new Set(["user_override", "arena_elo", "models_dev_tier"]);

/**
 * The scoreLookup handed to buildModelTagIndex by the live singleton:
 * DB-backed taskFitness scores (0..1) rescaled to the index's 0..100, only
 * for categories with a real mapping. Never throws — a missing table or DB
 * returns null and the seeds apply unchanged.
 */
export const taskFitnessScoreLookup: ScoreLookup = (category, ref) => {
  const taskType = CATEGORY_TO_FITNESS_TASK[category];
  if (!taskType) return null;
  try {
    const { score, source } = getTaskFitnessWithSource(ref.model, taskType);
    if (!DB_BACKED_SOURCES.has(source)) return null;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    return Math.round(Math.min(1, Math.max(0, score)) * 100);
  } catch {
    return null;
  }
};
