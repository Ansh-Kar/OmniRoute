/**
 * Execution router (harness Layer 3, build B16) — the THREE-REGISTRY
 * separation: models, tools, and agents are different kinds of things and
 * are never ranked against each other. This module answers the user's
 * cleaner question:
 *
 *   Hermes isn't asking "which model can browse?"
 *   It's asking "who/what can accomplish web research?"
 *
 * The decision ladder (the user's design, pure code — no LLM):
 *
 *   Fresh information required?
 *     YES → can the executor browse directly (a browser tool)?
 *       YES + short/direct task  → TOOL DIRECT (Level-0: Hermes + Camofox,
 *                                  no model delegation whatsoever)
 *       NO / long/multi-step/parallelizable/specialized
 *                              → AGENT (the escalation path — "this isn't
 *                                  a browsing operation; this is a
 *                                  20-source research job")
 *     NO  → MODEL (capability-evidence routing — /v1/router/candidates)
 *
 * Camofox available directly to Hermes is an ADVANTAGE, not a conflict:
 * the cheap Level-0 browsing path; web-research agents are the escalation
 * when browsing turns into actual research.
 */

import { browserTools, toolsForCapabilities, type ToolDescriptor } from "./toolRegistry.ts";
import { agentsForCapabilities, type AgentDescriptor } from "./agentRegistry.ts";
import type { WorkflowStat } from "./workflowMemory.ts";
import { workflowEvidence } from "./workflowMemory.ts";

/** The user's rule for Hermes, verbatim. */
export const HERMES_EXECUTION_RULE =
  "Tools are preferred for short, direct operations. Agents are preferred for extended, parallelizable, specialized, or multi-step operations. Models are selected based on task-specific capability evidence. Self-execution is preferred when expected quality is sufficient and delegation cost is not justified.";

export type ExecutionProfile = {
  domain: string | null;
  modality: string | null;
  complexity: "fast" | "deep" | null;
  /** Task depth — "long" work justifies agent escalation. */
  durationEstimate: "short" | "long" | null;
  /** Needs current web information (search-type or explicit). */
  requiresFreshInformation: boolean;
  parallelizable: boolean;
};

export type ExecutionProfileInput = {
  type: string | null;
  modality: string | null;
  complexity: "fast" | "deep" | null;
  parallelizable?: boolean;
  requiresFreshInformation?: boolean;
};

/** Infer the execution profile — task depth per the user's spec. */
export function executionProfileFrom(input: ExecutionProfileInput): ExecutionProfile {
  const requiresFreshInformation = input.requiresFreshInformation ?? input.type === "search";
  return {
    domain: input.type,
    modality: input.modality,
    complexity: input.complexity,
    durationEstimate: input.complexity === null ? null : input.complexity === "deep" ? "long" : "short",
    requiresFreshInformation,
    parallelizable: input.parallelizable ?? false,
  };
}

export type ExecutionDecision = {
  path: "tool" | "agent" | "model";
  tool: ToolDescriptor | null;
  agent: AgentDescriptor | null;
  reason: string;
  /** The ladder trace, for audit and the advisory surface. */
  ladder: string[];
};

/**
 * The ladder as pure code. `tools` are the tools the EXECUTOR (Hermes)
 * can run directly (selfExecutableTools from the caller's perspective).
 */
export function executionDecision(
  profile: ExecutionProfile,
  options: { tools?: ToolDescriptor[]; agents?: AgentDescriptor[] } = {}
): ExecutionDecision {
  const tools = options.tools ?? browserTools();
  const agents = options.agents ?? agentsForCapabilities(["web_research", "source_verification"]);

  if (!profile.requiresFreshInformation) {
    return {
      path: "model",
      tool: null,
      agent: null,
      reason: "no fresh information required — model capability routing applies (/v1/router/candidates)",
      ladder: ["fresh information? NO", "→ model routing by capability evidence"],
    };
  }

  const browser = tools.find((tool) => tool.capabilities.some((capability) => capability === "browser")) ?? null;
  const shortAndDirect = profile.durationEstimate !== "long" && !profile.parallelizable;
  if (browser && shortAndDirect) {
    return {
      path: "tool",
      tool: browser,
      agent: null,
      reason: `fresh information + short/direct — Level-0 browsing: run ${browser.id} yourself, no model delegation`,
      ladder: [
        "fresh information? YES",
        `can the executor browse directly? YES (${browser.id})`,
        `duration estimate ${profile.durationEstimate ?? "short"} → short and direct`,
        `→ TOOL DIRECT (${browser.id})`,
      ],
    };
  }

  const agent = agents[0] ?? null;
  if (agent) {
    return {
      path: "agent",
      tool: null,
      agent,
      reason: `fresh information + ${profile.parallelizable ? "parallelizable" : profile.durationEstimate ?? "multi-step"} workload — this is research, not browsing: escalate to ${agent.id}`,
      ladder: [
        "fresh information? YES",
        browser ? `can the executor browse directly? YES (${browser.id})` : "can the executor browse directly? NO",
        profile.parallelizable
          ? "parallelizable research workload → too big for direct browsing"
          : `duration estimate ${profile.durationEstimate ?? "long"} → extended/multi-step`,
        `→ AGENT (${agent.id}: ${agent.tools.join(" + ")})`,
      ],
    };
  }

  // No research agent registered — a browser tool is still better than
  // nothing for fresh information.
  if (browser) {
    return {
      path: "tool",
      tool: browser,
      agent: null,
      reason: `fresh information and no research agent registered — Level-0 browsing with ${browser.id} is the available path`,
      ladder: ["fresh information? YES", `no agent matched → fallback TOOL DIRECT (${browser.id})`],
    };
  }
  return {
    path: "model",
    tool: null,
    agent: null,
    reason: "fresh information required but no browsing tool or research agent is available — a search-capable model is the remaining path",
    ladder: ["fresh information? YES", "no browser tool, no research agent", "→ MODEL (search-capable)"],
  };
}

/** Capability requirements implied by a domain, for tool/agent matching. */
export function toolCapabilitiesForDomain(domain: string | null): string[] {
  if (domain === "search" || domain === "research") return ["browser", "web_research"];
  return [];
}

export type AgentWithEvidence = AgentDescriptor & {
  workflow: WorkflowStat | null;
};

/**
 * Attach workflow memory evidence to matching agents — §14: the evidence
 * for research paths is WORKFLOW performance, never model benchmarks.
 */
export function agentsWithEvidence(profile: ExecutionProfile): AgentWithEvidence[] {
  const required = ["web_research"];
  const matched = agentsForCapabilities(required);
  return matched.map((agent) => ({
    ...agent,
    workflow: workflowEvidence("web_research", agent.model, agent.tools),
  }));
}

export { toolsForCapabilities };
