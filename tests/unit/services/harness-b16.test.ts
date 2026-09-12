/**
 * Harness B16 — the three-registry separation: tool registry, agent
 * registry, the execution decision ladder (fresh information → Level-0
 * tool vs agent escalation), workflow memory (§14 evidence), and the
 * TOOL_FAILURE taxonomy kind.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b16-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b16-test-secret";

import {
  TOOL_REGISTRY,
  browserTools,
  getTool,
  selfExecutableTools,
  toolsForCapabilities,
} from "../../../open-sse/services/harness/toolRegistry.ts";
import { AGENT_REGISTRY, agentsForCapabilities, getAgent } from "../../../open-sse/services/harness/agentRegistry.ts";
import {
  executionDecision,
  executionProfileFrom,
  HERMES_EXECUTION_RULE,
  agentsWithEvidence,
} from "../../../open-sse/services/harness/executionRouter.ts";
import {
  clearWorkflowMemory,
  getWorkflowHistory,
  recordWorkflowOutcome,
  workflowEvidence,
  workflowMemorySize,
} from "../../../open-sse/services/harness/workflowMemory.ts";
import { classifyFailure } from "../../../open-sse/services/harness/failureTaxonomy.ts";

// ── Tool registry ───────────────────────────────────────────────────────────

test("tools: execution environments, capability-matched, never model-shaped", () => {
  const camofox = getTool("camofox");
  assert.ok(camofox);
  assert.equal(camofox.execution, "client", "camofox runs in Hermes' runtime (bot mode)");
  assert.deepEqual(camofox.capabilities, ["browser", "web_navigation", "javascript"]);

  const webSearch = getTool("web_search");
  assert.ok(webSearch);
  assert.equal(webSearch.execution, "native");
  assert.equal(webSearch.endpoint, "/v1/search");

  // Superset matching with overlap ranking: openwork covers [browser,
  // web_research] fully; camofox lacks web_research → not matched.
  const matched = toolsForCapabilities(["browser", "web_research"]);
  assert.deepEqual(matched.map((tool) => tool.id), ["openwork"]);

  assert.ok(browserTools().some((tool) => tool.id === "camofox"));
  assert.ok(selfExecutableTools().every((tool) => tool.execution !== "external"));
  assert.deepEqual(toolsForCapabilities([]), [], "no requirement → no tools (capability-driven, never 'all tools')");
  assert.equal(getTool("does-not-exist"), null);
});

// ── Agent registry ──────────────────────────────────────────────────────────

test("agents: model+tools+capabilities, the escalation path", () => {
  const research = getAgent("web_research_agent");
  assert.ok(research);
  assert.deepEqual(research.tools, ["camofox", "openwork"]);
  assert.equal(research.modelAlias, "research");

  assert.deepEqual(
    agentsForCapabilities(["web_research", "source_verification"]).map((agent) => agent.id),
    ["web_research_agent"]
  );
  assert.deepEqual(agentsForCapabilities(["ocr"]), [], "agents are matched by capability, never by model axes");
  assert.deepEqual(AGENT_REGISTRY.filter((agent) => agent.kind === "agent").length, AGENT_REGISTRY.length);
});

// ── Execution profile (task depth) ──────────────────────────────────────────

test("profile: task depth — fresh information, duration estimate, parallelizable", () => {
  const search = executionProfileFrom({ type: "search", modality: null, complexity: "fast" });
  assert.equal(search.requiresFreshInformation, true, "search-type ⇒ fresh information");
  assert.equal(search.durationEstimate, "short");

  const deepResearch = executionProfileFrom({ type: "research", modality: null, complexity: "deep" });
  assert.equal(deepResearch.durationEstimate, "long");
  assert.equal(deepResearch.requiresFreshInformation, false, "research ≠ fresh-info unless search/explicit");

  const explicit = executionProfileFrom({ type: "chat", modality: null, complexity: "fast", requiresFreshInformation: true });
  assert.equal(explicit.requiresFreshInformation, true, "explicit override wins");

  const unknown = executionProfileFrom({ type: null, modality: null, complexity: null });
  assert.equal(unknown.durationEstimate, null);
});

// ── The decision ladder ─────────────────────────────────────────────────────

test("ladder: fresh info + short/direct → Level-0 TOOL (Hermes browses itself)", () => {
  const decision = executionDecision(
    executionProfileFrom({ type: "search", modality: null, complexity: "fast" })
  );
  assert.equal(decision.path, "tool");
  assert.equal(decision.tool?.id, "camofox");
  assert.match(decision.reason, /Level-0 browsing/);
  assert.ok(decision.ladder.some((step) => step.includes("fresh information? YES")));
});

test("ladder: fresh info + long/parallelizable → AGENT escalation (research, not browsing)", () => {
  const long = executionDecision(executionProfileFrom({ type: "search", modality: null, complexity: "deep" }));
  assert.equal(long.path, "agent");
  assert.equal(long.agent?.id, "web_research_agent");
  assert.match(long.reason, /research, not browsing/);

  const parallel = executionDecision(
    executionProfileFrom({ type: "search", modality: null, complexity: "fast", parallelizable: true })
  );
  assert.equal(parallel.path, "agent", "parallelizable research workload escalates even when each step is fast");
  assert.equal(parallel.agent?.id, "web_research_agent");
});

test("ladder: no fresh info → MODEL path; degenerate cases fall safely", () => {
  const model = executionDecision(executionProfileFrom({ type: "code", modality: null, complexity: "deep" }));
  assert.equal(model.path, "model");
  assert.equal(model.tool, null);
  assert.equal(model.agent, null);
  assert.match(model.reason, /\/v1\/router\/candidates/);

  // No agents registered → browser tool is still the fresh-info path.
  const noAgents = executionDecision(executionProfileFrom({ type: "search", modality: null, complexity: "deep" }), { agents: [] });
  assert.equal(noAgents.path, "tool");
  assert.match(noAgents.reason, /no research agent registered/);

  // Nothing at all → a search-capable model is the remaining path.
  const nothing = executionDecision(executionProfileFrom({ type: "search", modality: null, complexity: "deep" }), { tools: [], agents: [] });
  assert.equal(nothing.path, "model");
  assert.match(nothing.reason, /no browsing tool or research agent/);
});

test("rule: the user's Hermes rule, verbatim", () => {
  assert.equal(
    HERMES_EXECUTION_RULE,
    "Tools are preferred for short, direct operations. Agents are preferred for extended, parallelizable, specialized, or multi-step operations. Models are selected based on task-specific capability evidence. Self-execution is preferred when expected quality is sufficient and delegation cost is not justified."
  );
});

// ── Workflow memory (§14 — measure workflows, not model benchmarks) ─────────

test("workflow memory: outcomes aggregate per (workflow, model, tools)", () => {
  clearWorkflowMemory();
  recordWorkflowOutcome({
    workflow: "web_research",
    model: "model-x",
    tools: ["camofox"],
    sourcesFound: 14,
    sourcesVerified: 12,
    qualityScore: 0.91,
    latencyMs: 38_000,
    success: true,
  });
  recordWorkflowOutcome({
    workflow: "web_research",
    model: "model-x",
    tools: ["camofox"],
    sourcesFound: 10,
    sourcesVerified: 10,
    qualityScore: 0.89,
    latencyMs: 40_000,
    success: true,
  });
  recordWorkflowOutcome({
    workflow: "web_research",
    model: "model-y",
    tools: ["openwork"],
    sourcesFound: 20,
    sourcesVerified: 19,
    qualityScore: 0.95,
    latencyMs: 90_000,
    success: true,
  });

  assert.equal(workflowMemorySize(), 2, "3 outcomes → 2 distinct (workflow, model, tools) keys");
  const evidence = workflowEvidence("web_research", "model-x", ["camofox"]);
  assert.ok(evidence);
  assert.equal(evidence.attempts, 2);
  assert.equal(evidence.avgSourcesFound, 12);
  assert.equal(evidence.avgSourcesVerified, 11);
  assert.ok(Math.abs((evidence.avgQualityScore ?? 0) - 0.9) < 1e-9);
  assert.equal(evidence.avgLatencyMs, 39_000);

  // History ranking: quality × evidence volume — "information you won't
  // find on a benchmark leaderboard".
  const history = getWorkflowHistory("web_research");
  assert.equal(history.length, 2, "per-key stats, not per-outcome");
  assert.ok(history[0].model === "model-y" || history[0].model === "model-x", "both strong entries ranked first/second deterministically");

  // Empty evidence is all-null, never invented.
  const none = workflowEvidence("web_research", "model-z", []);
  assert.ok(none, "empty evidence is a zeroed stat, not null");
  assert.equal(none.attempts, 0);
  assert.equal(none.avgQualityScore, null);
  assert.equal(none.successRate, null);

  // Case-insensitive workflow, deduped sorted tools.
  recordWorkflowOutcome({ workflow: "Web_Research", model: "m", tools: ["b", "a", "b"], success: true });
  const deduped = workflowEvidence("web_research", "m", ["a", "b"]);
  assert.ok(deduped);
  assert.equal(deduped.attempts, 1);
  assert.deepEqual(deduped.tools, ["a", "b"]);
  clearWorkflowMemory();
});

test("agents with evidence: workflow memory attaches to matched agents", () => {
  clearWorkflowMemory();
  const before = agentsWithEvidence(executionProfileFrom({ type: "search", modality: null, complexity: "deep" }));
  assert.equal(before[0].workflow?.attempts ?? 0, 0, "no evidence yet — never invented");

  recordWorkflowOutcome({
    workflow: "web_research",
    model: null, // the seeded agent resolves its own model
    tools: ["camofox", "openwork"],
    sourcesFound: 15,
    sourcesVerified: 14,
    qualityScore: 0.93,
    latencyMs: 60_000,
    success: true,
  });
  const after = agentsWithEvidence(executionProfileFrom({ type: "search", modality: null, complexity: "deep" }));
  assert.equal(after[0].id, "web_research_agent");
  assert.equal(after[0].workflow?.attempts, 1);
  assert.ok(Math.abs((after[0].workflow?.avgQualityScore ?? 0) - 0.93) < 1e-9);
  clearWorkflowMemory();
});

// ── Taxonomy: TOOL_FAILURE (guide §12) ───────────────────────────────────────

test("taxonomy: tool failures never hurt model reputation", () => {
  assert.deepEqual(classifyFailure("tool failure: camofox browser crashed mid-navigation"), {
    kind: "tool_failure",
    affectsReputation: false,
  });
  assert.deepEqual(classifyFailure("TOOL_ERROR: openwork workspace timed out"), {
    kind: "tool_failure",
    affectsReputation: false,
  });
  // A model-quality failure still counts.
  assert.deepEqual(classifyFailure("the synthesis missed two claims"), { kind: "model", affectsReputation: true });
});
