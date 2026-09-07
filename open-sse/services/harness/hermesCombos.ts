/**
 * Hermes combos — the `hermes/*` reserved model namespace (harness Layer 2,
 * B4; Guide 2 `docs/guides/HERMES_ABSTRACTION_SPEC.md`).
 *
 * Guide 2 specifies a hermes plugin that installs named combos so an agent's
 * config can reference stable, role-shaped model names instead of vendors
 * ("hermes/fast" etc.). The fork has no runtime plugin loader, so this module
 * IS the plugin — a static registry (the registry.json equivalent) of
 * `hermes/*` names, each mapping onto a capability alias (B1) with an optional
 * budget tier. Resolution is hooked at `getComboForModel` right after the
 * capability-alias step, so:
 *
 *   - operator-owned combos still win (an operator who names a combo
 *     "hermes/fast" overrides the mapping, deliberately);
 *   - `hermes/<name>` is reserved as a prefix — "hermes" is added to the
 *     reserved provider prefixes so no custom provider node can shadow it;
 *   - unknown `hermes/*` names fall through to ordinary resolution (404),
 *     never a silent wrong route;
 *   - the underlying alias still resolves EVERY request, so `hermes/smart`
 *     tracks the index's current best chat specialists over time.
 *
 * Tier mapping (roadmap "complexity tiers fast-free/deep→best"):
 *   hermes/fast   → chat:cheap   (fast-free tier — flash/mini-class models)
 *   hermes/smart  → chat:best    (deep tier — top axis-ranked specialists)
 */

import { buildCapabilityAliasCombo, type CapabilityAliasCombo } from "./capabilityAliases.ts";

/** The hermes plugin's registry (registry.json equivalent). */
export const HERMES_COMBOS: Record<string, { target: string; description: string }> = {
  "hermes/fast": { target: "chat:cheap", description: "fast general assistant (cheap tier)" },
  "hermes/smart": { target: "chat:best", description: "deep general assistant (best tier)" },
  "hermes/code": { target: "code", description: "coding specialists" },
  "hermes/code-best": { target: "code:best", description: "top coding specialists (best tier)" },
  "hermes/reason": { target: "reasoning:best", description: "top reasoning specialists (best tier)" },
  "hermes/plan": { target: "plan", description: "decomposition/planning specialists" },
  "hermes/math": { target: "math", description: "math specialists" },
  "hermes/vision": { target: "vision", description: "vision-capable specialists" },
  "hermes/research": { target: "research", description: "search-grounded research specialists" },
  "hermes/search": { target: "search", description: "web-search specialists" },
};

/**
 * Membership test for untrusted input. True only for EXACT registry names —
 * `hermes/`, `hermes/foo`, and case variants are not combos.
 */
export function isHermesComboName(name: unknown): name is string {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(HERMES_COMBOS, name);
}

/**
 * Build the ephemeral combo for a `hermes/*` name: resolves the mapped
 * capability alias (with its budget tier) and rebrands the combo under the
 * requested hermes name so the rest of the machinery (admission, failover,
 * logs) attributes it correctly. Returns null for unknown names or when the
 * underlying alias resolves no candidate — callers fall through to ordinary
 * model resolution.
 */
export function buildHermesCombo(name: string): CapabilityAliasCombo | null {
  const entry = isHermesComboName(name) ? HERMES_COMBOS[name] : null;
  if (!entry) return null;
  const underlying = buildCapabilityAliasCombo(entry.target);
  if (!underlying) return null;
  return {
    ...underlying,
    name,
    description: `hermes combo — ${entry.description} (via ${entry.target})`,
  };
}
