/**
 * Tool registry (harness Layer 3, build B16) — execution capabilities,
 * SEPARATE from model routing. Per the routing guide (§13): "Do not put
 * everything into one model list… The router may maintain capability
 * metadata for tools/agents, but it should not implement their runtimes."
 *
 * A TOOL is an execution environment (Camofox, OpenWork) — never ranked
 * against models. "Can browse" is not a model capability in the same sense
 * as "can do OCR": web performance is a property of the whole execution
 * stack (model × browser × search strategy × verification × synthesis),
 * so tools get capability metadata + workflow memory (§14), not benchmark
 * scores.
 *
 * Availability (`execution`): "native" = an OmniRoute endpoint the router
 * can dispatch directly; "client" = the executor (Hermes, bot mode) runs
 * it itself — the router only ADVISES; "external" = a separate service.
 * The fork never rebuilds tool runtimes — Hermes already has them.
 */

export type ToolExecution = "native" | "client" | "external";

export type ToolDescriptor = {
  id: string;
  kind: "tool";
  /** Execution capabilities: browser, web_navigation, javascript, web_research, … */
  capabilities: string[];
  /** Who runs this tool. */
  execution: ToolExecution;
  /** Native tools: the OmniRoute endpoint that executes it. */
  endpoint: string | null;
  description: string;
};

export const TOOL_REGISTRY: ToolDescriptor[] = [
  {
    id: "web_search",
    kind: "tool",
    capabilities: ["web_search", "fresh_information"],
    execution: "native",
    endpoint: "/v1/search",
    description: "OmniRoute's native literal web search (POST /v1/search) — no model in the loop.",
  },
  {
    id: "camofox",
    kind: "tool",
    capabilities: ["browser", "web_navigation", "javascript"],
    execution: "client",
    endpoint: null,
    description: "Stealth browser automation — client-side (Hermes bot mode executes it).",
  },
  {
    id: "openwork",
    kind: "tool",
    capabilities: ["web_research", "browser", "javascript"],
    execution: "client",
    endpoint: null,
    description: "Agentic web research workspace — client-side (Hermes bot mode executes it).",
  },
];

export function getTool(id: string): ToolDescriptor | null {
  return TOOL_REGISTRY.find((tool) => tool.id === id) ?? null;
}

/**
 * Tools whose capabilities COVER the requirement (superset), ranked by
 * overlap then registry order. An empty requirement matches nothing —
 * tool matching is always capability-driven, never "all tools".
 */
export function toolsForCapabilities(required: readonly string[]): ToolDescriptor[] {
  if (required.length === 0) return [];
  const needed = [...new Set(required.map((capability) => capability.toLowerCase()))];
  return TOOL_REGISTRY.map((tool) => {
    const owned = new Set(tool.capabilities.map((capability) => capability.toLowerCase()));
    const overlap = needed.filter((capability) => owned.has(capability)).length;
    return { tool, overlap, covers: overlap === needed.length };
  })
    .filter((entry) => entry.covers)
    .sort((a, b) => b.overlap - a.overlap)
    .map((entry) => entry.tool);
}

/** The "can I browse directly?" check — Hermes' Level-0 path. */
export function browserTools(): ToolDescriptor[] {
  return toolsForCapabilities(["browser"]);
}

/** Tools the requesting executor can run itself (client + native). */
export function selfExecutableTools(): ToolDescriptor[] {
  return TOOL_REGISTRY.filter((tool) => tool.execution !== "external");
}
