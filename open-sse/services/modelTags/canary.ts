/**
 * Liveness canaries for the tag index (harness B8, roadmap §6) — the
 * fork-side replacement for the mods.md probe.py pattern: actively probe
 * providers and let rankings skip models whose provider is demonstrably
 * dead, instead of discovering death one failed request at a time.
 *
 * Design constraints:
 *   - The canary state is process-local and EMPTY by default: until a
 *     round runs, `canaryAllows` admits every model and every ranking
 *     behaves exactly as before (no behavior change on a fresh boot).
 *   - Dead verdicts are conservative: a provider is marked dead only
 *     after CANARY_DEAD_THRESHOLD consecutive failed probes, and a stale
 *     dead verdict (older than CANARY_FRESHNESS_MS) stops filtering —
 *     a canary outage must never permanently remove a model.
 *   - The default probe is the cheapest reachability check that needs no
 *     credentials: any HTTP response from the provider's base URL (even
 *     401/403) proves the endpoint is up. Only network-level failures
 *     (DNS, refused, timeout) count as dead.
 */

export type CanaryState = {
  alive: boolean;
  /** Epoch ms of the last completed probe. */
  lastCheckAt: number;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
};

export type CanaryProbeResult = { ok: true; latencyMs: number } | { ok: false; error: string };

export type CanaryProbe = (entry: { id: string; provider: string }) => Promise<CanaryProbeResult>;

export type CanaryRoundSummary = {
  checked: number;
  markedDead: number;
  recovered: number;
  failures: number;
};

/** Consecutive failed probes before a provider is considered dead. */
export const CANARY_DEAD_THRESHOLD = 2;
/** A dead verdict older than this stops filtering rankings (stale = keep). */
export const CANARY_FRESHNESS_MS = 10 * 60_000;
/** Per-probe timeout for the default HTTP reachability probe. */
export const CANARY_PROBE_TIMEOUT_MS = 5_000;

const states = new Map<string, CanaryState>();

/** Full snapshot (API surface / tests). Keyed by full model id. */
export function getCanarySnapshot(): Record<string, CanaryState> {
  return Object.fromEntries(states.entries());
}

/** Test seam: drop all canary state. */
export function resetCanaries(): void {
  states.clear();
}

/**
 * Ranking gate: keep the model when unknown, alive, or stale-dead. Wired
 * into findModelsByTags — with an empty state map this is always true,
 * so rankings are unchanged until canaries actually run.
 */
export function canaryAllows(id: string, now: number = Date.now()): boolean {
  const state = states.get(id);
  if (!state || state.alive) return true;
  return now - state.lastCheckAt > CANARY_FRESHNESS_MS;
}

/** Models currently marked dead (fresh verdicts only) — the skip list. */
export function deadModelIds(now: number = Date.now()): string[] {
  return [...states.entries()].filter(([, state]) => !state.alive && now - state.lastCheckAt <= CANARY_FRESHNESS_MS).map(([id]) => id);
}

/**
 * Run one canary round over the given entries. Pure state machine over the
 * injected probe — deterministic and testable; the HTTP probe below is just
 * the default producer.
 */
export async function runCanaryRound(
  entries: Array<{ id: string; provider: string }>,
  probe: CanaryProbe,
  now: () => number = Date.now
): Promise<CanaryRoundSummary> {
  const summary: CanaryRoundSummary = { checked: 0, markedDead: 0, recovered: 0, failures: 0 };
  for (const entry of entries) {
    summary.checked += 1;
    const previous = states.get(entry.id);
    let result: CanaryProbeResult;
    try {
      result = await probe(entry);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "probe threw" };
    }
    if (result.ok) {
      if (previous && !previous.alive) summary.recovered += 1;
      states.set(entry.id, {
        alive: true,
        lastCheckAt: now(),
        latencyMs: result.latencyMs,
        consecutiveFailures: 0,
        lastError: null,
      });
    } else {
      summary.failures += 1;
      const failures = (previous?.consecutiveFailures ?? 0) + 1;
      const alive = failures < CANARY_DEAD_THRESHOLD;
      if (previous?.alive !== false && !alive) summary.markedDead += 1;
      states.set(entry.id, {
        alive,
        lastCheckAt: now(),
        latencyMs: null,
        consecutiveFailures: failures,
        lastError: result.error,
      });
    }
  }
  return summary;
}

/**
 * Default probe: HTTP reachability of the provider's base URL. ANY status
 * response (401/403/404 included) proves the endpoint answers — only
 * network-level failures (DNS, connection refused, timeout) mark death.
 * Providers without a resolvable base URL are skipped (reported ok — an
 * unprobeable provider must not be culled by the canary).
 */
export function makeHttpCanaryProbe(
  baseUrlFor: (provider: string) => string | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CANARY_PROBE_TIMEOUT_MS
): CanaryProbe {
  return async (entry) => {
    const baseUrl = baseUrlFor(entry.provider);
    if (!baseUrl) return { ok: true, latencyMs: 0 };
    const started = Date.now();
    try {
      const response = await fetchImpl(baseUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      void response.status; // any answer = alive
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "probe failed" };
    }
  };
}
