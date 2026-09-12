/**
 * Routing decision cache (harness Layer 3, build B15) — the user's fast
 * path: "KNOWN TASK → cache hit → CALL MODEL, rather than Hermes → router
 * → inspect candidates → reason → model every single time."
 *
 * task_signature → preferred model, with task-conditioned outcome memory:
 * each signature remembers its attempts/successes, so the cache IS the
 * Task Memory of the three-memories design (Model Memory = descriptors +
 * stats; Failure Memory = excused failures inside ModelStat.infraFailures).
 *
 * Invalidation discipline ("if any exceptions occur then we route
 * immediately"): a REPUTATION failure on the cached model drops the entry
 * — the next consultation re-runs the full path. Infra failures (timeout,
 * provider outage, …) are recorded but do NOT invalidate: the model choice
 * wasn't wrong, the transport was. Entries also expire (6h, matching the
 * registry freshness discipline) and are pruned when the registry rebuild
 * drops their model.
 *
 * Process-lifetime module state (like the registry caches); a restart
 * starts cold, which is correct for a cache — the durable source of truth
 * is the jobs store's closed loop.
 */

export type TaskSignatureInput = {
  type: string | null;
  modality: string | null;
  specialization?: string | null;
  complexity?: string | null;
};

/** Normalized semantic fingerprint — similar tasks share an entry. */
export function taskSignature(input: TaskSignatureInput): string {
  const part = (value: string | null | undefined) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "*";
  return [part(input.type), part(input.modality), part(input.specialization), part(input.complexity)].join("|");
}

export type CachedRoutingDecision = {
  signature: string;
  model: string;
  provider: string | null;
  /** Unified score at decision time (0–1). */
  score: number;
  decidedAt: number;
  /** Times this entry was served (cache hits). */
  uses: number;
  lastUsedAt: number;
  /** Task-conditioned outcomes for this signature (Task Memory). */
  attempts: number;
  successes: number;
};

const ROUTING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ROUTING_CACHE_MAX = 256;

const cache = new Map<string, CachedRoutingDecision>();

/** Test hook: reset the cache. */
export function clearRoutingCache(): void {
  cache.clear();
}

/** Test/debug surface: live entries (snapshot). */
export function routingCacheEntries(): CachedRoutingDecision[] {
  return [...cache.values()].map((entry) => ({ ...entry }));
}

function fresh(entry: CachedRoutingDecision, now: number): boolean {
  return now - entry.decidedAt < ROUTING_CACHE_TTL_MS;
}

/** The fast path: a cached decision for this signature, or null. */
export function getCachedDecision(signature: string, now: () => number = Date.now): CachedRoutingDecision | null {
  const entry = cache.get(signature);
  if (!entry) return null;
  if (!fresh(entry, now())) {
    cache.delete(signature);
    return null;
  }
  entry.uses += 1;
  entry.lastUsedAt = now();
  // LRU touch: re-insert at the end.
  cache.delete(signature);
  cache.set(signature, entry);
  return { ...entry };
}

/** Record a fresh routing decision (the router's PRIMARY after a full pass). */
export function recordRoutingDecision(
  signature: string,
  decision: { model: string; provider?: string | null; score: number },
  now: () => number = Date.now
): void {
  if (!decision.model) return;
  const previous = cache.get(signature); // preserve outcome memory across re-decisions
  const entry: CachedRoutingDecision = {
    signature,
    model: decision.model,
    provider: decision.provider ?? null,
    score: decision.score,
    decidedAt: now(),
    uses: 0,
    lastUsedAt: now(),
    attempts: previous?.attempts ?? 0,
    successes: previous?.successes ?? 0,
  };
  cache.set(signature, entry);
  if (cache.size > ROUTING_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Feed a task outcome back into the signature's Task Memory. A
 * reputation-affecting failure on the cached model INVALIDATES the entry
 * (route immediately on the next request); an infra failure is recorded
 * but kept.
 */
export function recordRoutingOutcome(
  signature: string,
  model: string | null | undefined,
  ok: boolean,
  affectsReputation: boolean,
  now: () => number = Date.now
): void {
  if (!model) return;
  const entry = cache.get(signature);
  if (!entry) return; // outcomes only accumulate on cached signatures
  entry.attempts += 1;
  if (ok) entry.successes += 1;
  if (!ok && affectsReputation && entry.model === model) {
    cache.delete(signature); // exception → route immediately next time
    return;
  }
  entry.lastUsedAt = now();
}

/** Registry-rebuild hook: drop entries whose model no longer exists. */
export function pruneRoutingCache(validModels: ReadonlySet<string>): number {
  let pruned = 0;
  for (const [signature, entry] of cache) {
    if (!validModels.has(entry.model)) {
      cache.delete(signature);
      pruned += 1;
    }
  }
  return pruned;
}
