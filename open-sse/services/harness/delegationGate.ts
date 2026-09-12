/**
 * Delegation gate (harness Layer 3, build B15) — the user's "most important
 * optimization": a hard threshold against model-call inflation.
 *
 *   "Don't delegate just because another model is technically better.
 *    Hermes 91 vs specialist 93 → not worth another model call.
 *    Hermes 72 vs specialist 96 → absolutely delegate."
 *
 *   if specialist_advantage < DELEGATION_THRESHOLD: self_execute()
 *   else: delegate()
 *
 * Pure CODE, not an LLM call — the boundary between "I can do it" and
 * "delegate" must be extremely cheap. The verdict is still ADVISORY:
 * the recommendation isn't the decision, Hermes remains sovereign. The
 * gate just keeps Hermes from burning reasoning (and round-trips) on
 * decisions that aren't actually ambiguous.
 */

export type TaskSignals = {
  /** "fast" | "deep" | null — the classifier's complexity estimate. */
  complexity: "fast" | "deep" | null;
  /** Content modality of the request (image/audio/…), null = text. */
  modality: string | null;
  /** Task domain (specialization / category / type), null = unknown. */
  domain: string | null;
  /** Estimated request context size (tokens), null = unknown. */
  contextSize: number | null;
  /** Does the winning path require a specialization the task names? */
  specializationRequired: boolean;
  /** Can the work be split into independent parallel tasks? */
  parallelizable: boolean;
};

export const DEFAULT_DELEGATION_THRESHOLD = 5; // points on the 0–100 scale

export type DelegationVerdict = {
  recommendation: "self" | "delegate" | "consider";
  /** best − self, in points on the 0–100 scale; null when self is unscored. */
  advantage: number | null;
  threshold: number;
  signals: TaskSignals;
  reason: string;
};

export type DelegationGateInput = {
  signals: TaskSignals;
  /** The caller's unified score (0–1); null when unregistered/unscored. */
  selfScore: number | null;
  /** The best candidate's unified score (0–1). */
  bestScore: number;
  /** The caller's self-assessment status; null = no caller model named. */
  selfStatus: "ranked" | "filtered" | "unregistered" | null;
  /** Advantage (in points) below which self-execution wins. Default 5. */
  threshold?: number;
};

/**
 * The cheapest decision in the system: should the caller even consider
 * delegating? Deterministic, ~0 cost, no LLM.
 */
export function delegationGate(input: DelegationGateInput): DelegationVerdict {
  const threshold = typeof input.threshold === "number" && Number.isFinite(input.threshold) && input.threshold >= 0 ? input.threshold : DEFAULT_DELEGATION_THRESHOLD;
  const base = { threshold, signals: input.signals };

  if (input.selfStatus === "filtered") {
    return {
      ...base,
      recommendation: "delegate",
      advantage: null,
      reason: "you were filtered out — you cannot serve this task (modality/capability hard filter)",
    };
  }
  if (input.selfStatus === "unregistered" || input.selfScore === null) {
    return {
      ...base,
      recommendation: "consider",
      advantage: null,
      reason: "the router cannot score you (unregistered or no caller named) — judge for yourself; best scored candidate is listed",
    };
  }
  if (input.bestScore <= 0) {
    return { ...base, recommendation: "self", advantage: null, reason: "no viable candidate scored above zero — self-execute" };
  }

  const advantage = Math.max(0, (input.bestScore - input.selfScore) * 100);
  if (advantage < threshold) {
    return {
      ...base,
      recommendation: "self",
      advantage,
      reason: `specialist advantage ${advantage.toFixed(1)} pts < threshold ${threshold} — not worth a delegation round-trip`,
    };
  }
  return {
    ...base,
    recommendation: "delegate",
    advantage,
    reason: `specialist advantage ${advantage.toFixed(1)} pts ≥ threshold ${threshold} — a specialist is meaningfully better; consider delegating`,
  };
}
