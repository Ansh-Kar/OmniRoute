/**
 * The allocator's breaker feed (harness B9, roadmap §6) — the missing
 * SOURCE for B5's `breaker(0.2 open)` multiplier: the same provider-keyed
 * circuit-breaker registry the chat pipeline consults
 * (getCircuitBreaker(provider) in chatHelpers), read side-effect-free.
 *
 * Semantics:
 *   - OPEN  → the 0.2 penalty applies (the pipeline is already rejecting
 *     the provider's requests — ranking it top would just burn a retry).
 *   - HALF_OPEN → still counts: the provider is probing, not proven healthy.
 *   - DEGRADED / CLOSED / unknown → no penalty. DEGRADED passes requests by
 *     design; an unknown provider has no evidence against it.
 *   - Cold-process fallback: when the registry has no instance (fresh
 *     boot), the PERSISTED breaker state is consulted — the same record
 *     getCircuitBreaker's constructor rehydrates from — so a restart
 *     doesn't forget an open breaker until something re-trips it.
 */

import {
  peekCircuitBreaker,
  STATE,
} from "@/shared/utils/circuitBreaker";
import { loadCircuitBreakerState } from "@/lib/db/domainState";

const PENALTY_STATES: ReadonlySet<string> = new Set([STATE.OPEN, STATE.HALF_OPEN]);

/** True when the provider's breaker state earns the allocator's 0.2 multiplier. */
export function providerBreakerOpen(provider: string | null | undefined): boolean {
  if (!provider) return false;
  const breaker = peekCircuitBreaker(provider);
  if (breaker) {
    return PENALTY_STATES.has(breaker.state);
  }
  try {
    const persisted = loadCircuitBreakerState(provider);
    return persisted ? PENALTY_STATES.has(persisted.state) : false;
  } catch {
    // DB unavailable (headless/tests) — registry-only verdict.
    return false;
  }
}
