/**
 * Agent registry (harness Layer 3, build B16). An AGENT is a model + tools
 * + instructions (+ possibly memory) — an ESCALATION path, never ranked
 * against models. Per the routing guide (§13/§16): the router keeps
 * capability metadata for agents but never implements their runtimes —
 * Hermes provides the agent infrastructure (bot mode).
 *
 * The user's separation, verbatim in spirit:
 *   Hermes isn't asking "which model can browse?" — it's asking
 *   "who/what can accomplish web research?" That's a much cleaner
 *   abstraction.
 *
 * Agents are matched by capability; their EVIDENCE is workflow memory
 * (workflowMemory.ts — §14: research quality is a property of the whole
 * execution stack, so we measure workflows, not model benchmarks).
 */

export type AgentDescriptor = {
  id: string;
  kind: "agent";
  /** The agent's model, or null when it resolves its own (alias/auto). */
  model: string | null;
  /** Capability-alias vocabulary for the model the agent wants. */
  modelAlias: string | null;
  /** Tool ids from the tool registry this agent runs with. */
  tools: string[];
  capabilities: string[];
  description: string;
};

export const AGENT_REGISTRY: AgentDescriptor[] = [
  {
    id: "web_research_agent",
    kind: "agent",
    model: null,
    modelAlias: "research",
    tools: ["camofox", "openwork"],
    capabilities: ["web_research", "source_verification", "synthesis"],
    description:
      "Deep web research: browse, gather sources, verify claims against primary sources, synthesize. Escalation path when browsing turns into actual research.",
  },
];

export function getAgent(id: string): AgentDescriptor | null {
  return AGENT_REGISTRY.find((agent) => agent.id === id) ?? null;
}

/** Agents whose capabilities cover the requirement (superset), capability-ranked. */
export function agentsForCapabilities(required: readonly string[]): AgentDescriptor[] {
  if (required.length === 0) return [];
  const needed = [...new Set(required.map((capability) => capability.toLowerCase()))];
  return AGENT_REGISTRY.map((agent) => {
    const owned = new Set(agent.capabilities.map((capability) => capability.toLowerCase()));
    const overlap = needed.filter((capability) => owned.has(capability)).length;
    return { agent, overlap, covers: overlap === needed.length };
  })
    .filter((entry) => entry.covers)
    .sort((a, b) => b.overlap - a.overlap)
    .map((entry) => entry.agent);
}
