/**
 * Failure taxonomy (harness Layer 3/4, build B15) — distinguishes MODEL
 * failure from ROUTING/INFRA failure before anything touches memory.
 *
 * The user's rule: "Only [the model isn't good at the task] should
 * significantly decrease the model's task-specific reputation. Otherwise
 * your learning system will slowly make terrible routing decisions because
 * a provider outage gets interpreted as 'Qwen is bad at OCR.'"
 *
 * Evidence-based EXCLUSION: a failure is excused from reputation only when
 * its error carries detectable non-model evidence (timeout, context limit,
 * malformed request, provider/infra, budget sweep). No infra evidence →
 * the failure is attributed to the model (this preserves the closed loop's
 * existing semantics: a bare failure after exhausting attempts IS a
 * quality signal). The three memories stay separate:
 *
 *   Model Memory   — reputation-affecting failures (kind "model")
 *   Task Memory    — per-signature outcomes (routingCache.ts)
 *   Failure Memory — excused failures (everything else), tracked as
 *                    ModelStat.infraFailures for visibility, never fed to
 *                    laplace/health scoring
 */

export type FailureKind =
  | "model"
  | "timeout"
  | "context_too_large"
  | "malformed_request"
  | "infrastructure"
  | "budget";

export type FailureClassification = {
  kind: FailureKind;
  /** False = routing/infra failure: tracked, but never hurts reputation. */
  affectsReputation: boolean;
};

/** Ordered patterns — first match wins. Keep in sync with tests. */
const FAILURE_PATTERNS: Array<{ kind: FailureKind; pattern: RegExp }> = [
  // Budget/deadline sweeps are PLANNING failures: the task never ran (or
  // the job ran out of runway) — nothing the serving model did.
  { kind: "budget", pattern: /\b(budget exhausted|max_total_tokens|deadline exceeded|job deadline)\b/i },
  { kind: "timeout", pattern: /\b(timeout|timed out|ETIMEDOUT|abort(ed)? on (timeout|deadline)|request deadline)\b/i },
  {
    kind: "context_too_large",
    pattern: /\b(context (length|size|window)|too many tokens|token limit|maximum context|input too large|context_length_exceeded|exceeds the model|too large)\b/i,
  },
  {
    kind: "malformed_request",
    pattern: /\b(invalid request|malformed|bad request|unsupported (request|format|media type)|unprocessable|invalid.*schema|status(?: code)? 4(?:00|13|15|22))\b/i,
  },
  {
    kind: "infrastructure",
    pattern:
      /\b(rate.?limit|quota|429|status(?: code)? 5\d\d|service unavailable|gateway|bad gateway|overloaded|upstream|ECONNREFUSED|ENOTFOUND|ECONNRESET|EPIPE|dns|network|connection (reset|refused|closed|dropped)|server error|internal error)\b/i,
  },
];

/**
 * Classify a terminal task failure from its lastError. null/empty errors
 * classify as "model": a task that exhausted its attempts with no
 * infra-shaped error is a quality failure — the closed loop must still
 * learn from it.
 */
export function classifyFailure(lastError: string | null | undefined): FailureClassification {
  if (typeof lastError === "string" && lastError.trim()) {
    for (const { kind, pattern } of FAILURE_PATTERNS) {
      if (pattern.test(lastError)) return { kind, affectsReputation: kind === "model" };
    }
  }
  return { kind: "model", affectsReputation: true };
}

/** Failures that count against a model's reputation (laplace/health input). */
export function reputationFailures(failures: number, infraFailures: number | null | undefined): number {
  const infra = typeof infraFailures === "number" && infraFailures > 0 ? Math.min(infraFailures, failures) : 0;
  return Math.max(0, failures - infra);
}
