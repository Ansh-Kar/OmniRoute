/**
 * Allocator — quality-first, provider-diverse assignment with live
 * health/speed/breaker multipliers (harness Layer 5, build B5; Guide 1
 * Part 4 + Part 8).
 *
 * B1 shipped the static half: candidates ranked by the tag index's benchmark
 * axis (the quality prior). B5 adds the live half on top:
 *
 *   score = quality[tag]                     # static prior (tag index)
 *           × (0.5 + 0.5 × health)           # smoothed success rate
 *           × (0.5 + 0.5 × speed)            # decay vs latency average
 *           × breaker_penalty                # 0.2 when breaker open
 *
 * Health/speed come from the jobs store's per-model task outcomes
 * (`aggregateModelStats`) — existing telemetry, not a parallel system.
 * Quality is additionally reduced by the judge drift penalty
 * (`applyJudgeVerdict`: two consecutive failed verdicts on a model →
 * −0.05 per subsequent fail, quality floor 0.3 — Part 8's drift loop).
 *
 * Pure module: no DB, no clock, no globals — every input is a parameter, so
 * allocation is a pure function of (candidates, stats, penalties, policy)
 * and replays/tests are trivial (guide Part 4 determinism note).
 */

// ── Stats ───────────────────────────────────────────────────────────────────

/** Per-model outcome aggregate from the jobs store (both stores implement). */
export type ModelStat = {
  /** Terminal task successes (state done). */
  successes: number;
  /** Terminal task failures (state failed). */
  failures: number;
  /** Sum of recorded latencies (ms) over successful tasks. */
  totalLatencyMs: number;
};

/**
 * Smoothed success rate in [0,1]. Laplace smoothing ((s+1)/(s+f+2)) so a
 * model with no history is neutral (0.5), not dead — matching the guide's
 * (0.5 + 0.5 × health) shape: unknown ⇒ ×0.75 multiplier for everyone.
 */
export function healthFromStat(stat: ModelStat | undefined): number {
  if (!stat || stat.successes + stat.failures === 0) return 0.5;
  return (stat.successes + 1) / (stat.successes + stat.failures + 2);
}

/** Latency (ms) a model must beat to score speed = 1. Tunable prior. */
export const SPEED_BASELINE_MS = 3_000;

/**
 * Speed decay in [0,1] vs the latency average: 1 at or under baseline,
 * decaying toward 0 as latency grows (baseline/avg, clamped).
 */
export function speedFromStat(stat: ModelStat | undefined): number {
  const n = stat?.successes ?? 0;
  if (!stat || n === 0) return 0.5; // no history — neutral
  const avg = stat.totalLatencyMs / n;
  if (avg <= 0) return 1;
  return Math.min(1, SPEED_BASELINE_MS / avg);
}

/** Circuit-breaker penalty per the guide: 0.2 while open, 1 otherwise. */
export function breakerPenalty(breakerOpen: boolean): number {
  return breakerOpen ? 0.2 : 1;
}

/** Judge drift: quality decrement per penalized fail streak step. */
export const JUDGE_DRIFT_PENALTY = 0.05;
/** Quality floor from the guide: penalties never push quality below 0.3. */
export const QUALITY_FLOOR = 0.3;

// ── Scoring ─────────────────────────────────────────────────────────────────

export type ScoreInputs = {
  /** Static prior in [0,1] from the tag index (axis/benchmark score). */
  quality: number;
  stat?: ModelStat | undefined;
  breakerOpen?: boolean | undefined;
};

/** The Part 8 score function, exactly. */
export function scoreCandidate({ quality, stat, breakerOpen }: ScoreInputs): number {
  const q = Math.max(QUALITY_FLOOR, Math.min(1, quality));
  return (
    q *
    (0.5 + 0.5 * healthFromStat(stat)) *
    (0.5 + 0.5 * speedFromStat(stat)) *
    breakerPenalty(breakerOpen ?? false)
  );
}

// ── Assignment (water-filling) ──────────────────────────────────────────────

export type AllocatorCandidate = {
  model: string;
  provider?: string | null;
  /** Static quality prior in [0,1]. */
  quality: number;
};

export type AssignOptions = {
  /** Max assignments per provider per wave (guide Part 4 step 4). */
  maxPerProvider: number;
  /** Live per-model stats (optional — neutral when absent). */
  statOf?: (model: string) => ModelStat | undefined;
  /** Judge-drift quality penalties per model (subtracted from quality). */
  penaltyOf?: (model: string) => number;
  /**
   * B10 bias guard: the calling agent's own model. A same-model sub-agent
   * inherits the caller's blind spots (self-preference bias), so it scores
   * ×BIAS_AVOID_MULTIPLIER while any tag-viable alternative remains — a
   * penalty, not a ban: with no alternative, or an overwhelmingly better
   * caller model, the caller model still wins (and the task is flagged
   * bias_same_model in the API). Undefined = no guard (B3–B9 behavior).
   */
  avoidModel?: string;
  /**
   * Breaker state per candidate (B9: the feed is live — the plan route
   * passes the provider-keyed circuit-breaker registry via
   * src/lib/harness/breakerFeed.ts). Provider is the candidate's registry
   * provider; the model is passed for finer-grained feeds.
   */
  breakerOf?: (model: string, provider: string | null) => boolean;
};

/** B10 bias guard: score multiplier for the caller's own model. */
export const BIAS_AVOID_MULTIPLIER = 0.6;

export type Assignment = {
  task: string;
  candidate: AllocatorCandidate;
  score: number;
};

/**
 * Provider-diverse water-filling over ready tasks (guide Part 4):
 * candidates are scored (quality − drift penalty, health/speed/breaker
 * multipliers), grouped by provider, and assigned round-robin across
 * providers — best of A, best of B, then second of A… — respecting
 * max_per_provider. Tasks with no surviving candidate get NO assignment:
 * the caller records the reason and falls back (never silently downgrade —
 * the B5 orchestrator falls back to the capability alias and logs it).
 *
 * Deterministic: stable input order, stable tie-breaking (first-seen wins).
 */
export function assignModels(
  tasks: Array<{ id: string; tag: string }>,
  candidatesFor: (tag: string) => AllocatorCandidate[],
  options: AssignOptions
): { assignments: Map<string, Assignment>; unassigned: Array<{ id: string; reason: string }> } {
  const perProvider = new Map<string, number>();
  const usedModels = new Set<string>();
  const assignments = new Map<string, Assignment>();
  const unassigned: Array<{ id: string; reason: string }> = [];

  for (const task of tasks) {
    const candidates = candidatesFor(task.tag);
    if (candidates.length === 0) {
      unassigned.push({ id: task.id, reason: "no candidates for tag" });
      continue;
    }
    const scored = candidates.map((candidate, index) => {
      const penalty = options.penaltyOf?.(candidate.model) ?? 0;
      const quality = Math.max(QUALITY_FLOOR, candidate.quality - penalty);
      const score = scoreCandidate({
        quality,
        stat: options.statOf?.(candidate.model),
        breakerOpen: options.breakerOf?.(candidate.model, candidate.provider ?? null) ?? false,
      }) * (options.avoidModel && candidate.model === options.avoidModel ? BIAS_AVOID_MULTIPLIER : 1);
      return { candidate, score, index };
    });
    // Highest score wins; ties keep the tag index's original order (index).
    scored.sort((a, b) => b.score - a.score || a.index - b.index);

    const hasCapacity = (entry: (typeof scored)[number]) =>
      (perProvider.get(entry.candidate.provider ?? "") ?? 0) < options.maxPerProvider;
    // Prefer providers with capacity AND models not already assigned this
    // wave (guide "best of A, best of B, then second of A"); reuse of an
    // already-assigned model is the fallback, never the first pick.
    const chosen =
      scored.find((entry) => hasCapacity(entry) && !usedModels.has(entry.candidate.model)) ??
      scored.find((entry) => hasCapacity(entry));

    if (!chosen) {
      unassigned.push({ id: task.id, reason: `max_per_provider ${options.maxPerProvider} reached` });
      continue;
    }
    const provider = chosen.candidate.provider ?? "";
    perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
    usedModels.add(chosen.candidate.model);
    assignments.set(task.id, { task: task.id, candidate: chosen.candidate, score: chosen.score });
  }
  return { assignments, unassigned };
}
