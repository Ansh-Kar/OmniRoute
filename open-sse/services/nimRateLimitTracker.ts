/**
 * nimRateLimitTracker — In-memory sliding-window rate tracking for NVIDIA NIM
 * (provider id "nvidia") connections.
 *
 * B4 hardening for the agent-harness fork (HARNESS_ROADMAP.md, Layer 2):
 *   - Retry-After: 429 cooldowns honor the upstream Retry-After header when
 *     present; otherwise a fallback is derived from the sliding window.
 *   - Sliding window: per-connection 60s request windows. The RPM ceiling is
 *     LEARNED — when a 429 arrives, the current window size is recorded as the
 *     observed ceiling, so subsequent rotations can skip connections that are
 *     already at the observed limit BEFORE they 429 (Key1 saturated → go to
 *     Key2 instead of burning an attempt on a guaranteed 429).
 *   - Key rotation: chatCore's nvidia 429 block consults
 *     isNimConnectionSaturated() while picking the next connection.
 *
 * Mirrors geminiRateLimitTracker.ts (in-memory, per-process, best-effort —
 * the DB-level cooldown via markConnectionRateLimitedUntil is the durable
 * signal; this tracker is the pre-emptive in-memory layer on top).
 */

// ── Sliding 60s request window state ────────────────────────────────────────

/** connectionId → timestamps (ms) of requests dispatched in the last 60s */
const requestWindows = new Map<string, number[]>();

/** connectionId → epoch ms until which the connection is cooling down */
const cooldowns = new Map<string, number>();

/** connectionId → observed RPM ceiling (learned from the 429 that proved it) */
const observedCeilings = new Map<string, number>();

const WINDOW_MS = 60_000;
/** Default cooldown when a 429 arrives without a usable Retry-After header. */
const DEFAULT_429_COOLDOWN_MS = 20_000;
/** Cooldowns never exceed this regardless of what we learn. */
const MAX_429_COOLDOWN_MS = 5 * 60_000;
/** Ignore absurd Retry-After values (e.g. a year) — treat as no header. */
const MAX_USABLE_RETRY_AFTER_MS = 15 * 60_000;

function pruneWindow(now: number, entries: number[]): number[] {
  const cutoff = now - WINDOW_MS;
  let firstKept = 0;
  while (firstKept < entries.length && entries[firstKept] < cutoff) {
    firstKept++;
  }
  if (firstKept === 0) return entries;
  return entries.slice(firstKept);
}

// ── Recording ───────────────────────────────────────────────────────────────

/** Record that a request was dispatched on a NIM connection. */
export function recordNimRequest(connectionId: string): void {
  if (!connectionId) return;
  const now = Date.now();
  const entries = pruneWindow(now, requestWindows.get(connectionId) ?? []);
  entries.push(now);
  requestWindows.set(connectionId, entries);
}

/**
 * Record a 429 on a NIM connection. Learns the observed RPM ceiling from the
 * current window size and stamps a cooldown derived from Retry-After (when
 * given) or the sliding window itself.
 *
 * @returns the cooldown applied, in ms
 */
export function recordNim429(connectionId: string, retryAfterMs: number | null): number {
  if (!connectionId) return 0;
  const now = Date.now();
  const entries = pruneWindow(now, requestWindows.get(connectionId) ?? []);

  // Learn: whatever the window size was when the 429 hit IS the ceiling.
  if (entries.length > 0) {
    observedCeilings.set(connectionId, entries.length);
  }

  let cooldownMs: number;
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    // Retry-After is authoritative when sane.
    cooldownMs = Math.min(retryAfterMs, MAX_USABLE_RETRY_AFTER_MS);
  } else {
    // No usable header: estimate from the window — when does the oldest
    // request age out of the 60s window? That's the earliest the limit can
    // reset. Fallback default when the window is somehow empty.
    cooldownMs =
      entries.length > 0 ? Math.max(WINDOW_MS - (now - entries[0]), 0) : DEFAULT_429_COOLDOWN_MS;
    cooldownMs = Math.max(cooldownMs, DEFAULT_429_COOLDOWN_MS);
  }
  cooldownMs = Math.min(cooldownMs, MAX_429_COOLDOWN_MS);

  cooldowns.set(connectionId, now + cooldownMs);
  return cooldownMs;
}

// ── Queries ─────────────────────────────────────────────────────────────────

/** Requests dispatched on this connection in the last 60s. */
export function nimWindowCount(connectionId: string): number {
  if (!connectionId) return 0;
  const now = Date.now();
  return pruneWindow(now, requestWindows.get(connectionId) ?? []).length;
}

/** Observed RPM ceiling for this connection (null until a 429 teaches it). */
export function nimObservedCeiling(connectionId: string): number | null {
  return observedCeilings.get(connectionId) ?? null;
}

/** ms remaining on the connection's active 429 cooldown (0 if none). */
export function nimCooldownRemainingMs(connectionId: string): number {
  if (!connectionId) return 0;
  const until = cooldowns.get(connectionId);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(connectionId);
    return 0;
  }
  return remaining;
}

/**
 * Whether the connection is at (or beyond) its learned RPM ceiling — i.e.
 * dispatching on it now is likely to 429. Only meaningful once a 429 has
 * taught us the ceiling; before that it returns false (no signal).
 */
export function isNimConnectionSaturated(connectionId: string): boolean {
  if (!connectionId) return false;
  if (nimCooldownRemainingMs(connectionId) > 0) return true;
  const ceiling = observedCeilings.get(connectionId);
  if (!ceiling) return false;
  return nimWindowCount(connectionId) >= ceiling;
}

/** Test helper: wipe all tracker state. */
export function resetNimRateLimitTracker(): void {
  requestWindows.clear();
  cooldowns.clear();
  observedCeilings.clear();
}
