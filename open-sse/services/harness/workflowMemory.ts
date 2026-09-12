/**
 * Workflow memory (harness Layer 3/4, build B16) — routing guide §14:
 * "Do not force web research into normal model benchmarks. Web quality is
 * a workflow property." Record and aggregate outcomes per
 * (workflow, model, tools) — this is the evidence the execution router
 * surfaces for agents ("For technical research: Model X + Camofox →
 * excellent for deep research") that no benchmark leaderboard contains.
 *
 * Memory boundary (§15): OmniRoute stores structured routing statistics
 * (recordWorkflowOutcome / getWorkflowHistory); richer semantic memory
 * stays with Hermes. Module state is process-lifetime — the durable
 * closed loop remains the jobs store.
 */

export type WorkflowOutcome = {
  /** Workflow/domain id, e.g. "web_research" or "technical_research". */
  workflow: string;
  model: string | null;
  tools: string[];
  sourcesFound?: number | null;
  sourcesVerified?: number | null;
  /** 0–1 synthesis/answer quality (evaluator-assigned). */
  qualityScore?: number | null;
  latencyMs?: number | null;
  success?: boolean | null;
};

export type WorkflowStat = {
  workflow: string;
  model: string | null;
  tools: string[];
  attempts: number;
  successes: number;
  successRate: number | null;
  avgSourcesFound: number | null;
  avgSourcesVerified: number | null;
  avgQualityScore: number | null;
  avgLatencyMs: number | null;
};

type Aggregate = {
  workflow: string;
  model: string | null;
  tools: string[];
  attempts: number;
  successes: number;
  sourcesFoundSum: number;
  sourcesFoundCount: number;
  sourcesVerifiedSum: number;
  sourcesVerifiedCount: number;
  qualitySum: number;
  qualityCount: number;
  latencySum: number;
  latencyCount: number;
};

const memory = new Map<string, Aggregate>();

function workflowKey(workflow: string, model: string | null, tools: string[]): string {
  const toolSignature = [...new Set(tools)].sort().join("+") || "no-tools";
  return `${workflow.toLowerCase()}|${model ?? "*"}|${toolSignature}`;
}

/** Test hook. */
export function clearWorkflowMemory(): void {
  memory.clear();
}

export function recordWorkflowOutcome(outcome: WorkflowOutcome): void {
  const workflow = outcome.workflow.trim().toLowerCase();
  if (!workflow) return;
  const key = workflowKey(workflow, outcome.model, outcome.tools);
  let aggregate = memory.get(key);
  if (!aggregate) {
    aggregate = {
      workflow,
      model: outcome.model ?? null,
      tools: [...new Set(outcome.tools)].sort(),
      attempts: 0,
      successes: 0,
      sourcesFoundSum: 0,
      sourcesFoundCount: 0,
      sourcesVerifiedSum: 0,
      sourcesVerifiedCount: 0,
      qualitySum: 0,
      qualityCount: 0,
      latencySum: 0,
      latencyCount: 0,
    };
    memory.set(key, aggregate);
  }
  aggregate.attempts += 1;
  if (outcome.success === true) aggregate.successes += 1;
  if (typeof outcome.sourcesFound === "number" && Number.isFinite(outcome.sourcesFound)) {
    aggregate.sourcesFoundSum += outcome.sourcesFound;
    aggregate.sourcesFoundCount += 1;
  }
  if (typeof outcome.sourcesVerified === "number" && Number.isFinite(outcome.sourcesVerified)) {
    aggregate.sourcesVerifiedSum += outcome.sourcesVerified;
    aggregate.sourcesVerifiedCount += 1;
  }
  if (typeof outcome.qualityScore === "number" && Number.isFinite(outcome.qualityScore)) {
    aggregate.qualitySum += outcome.qualityScore;
    aggregate.qualityCount += 1;
  }
  if (typeof outcome.latencyMs === "number" && Number.isFinite(outcome.latencyMs)) {
    aggregate.latencySum += outcome.latencyMs;
    aggregate.latencyCount += 1;
  }
}

function toStat(aggregate: Aggregate): WorkflowStat {
  const avg = (sum: number, count: number) => (count > 0 ? sum / count : null);
  return {
    workflow: aggregate.workflow,
    model: aggregate.model,
    tools: aggregate.tools,
    attempts: aggregate.attempts,
    successes: aggregate.successes,
    successRate: aggregate.attempts > 0 ? aggregate.successes / aggregate.attempts : null,
    avgSourcesFound: avg(aggregate.sourcesFoundSum, aggregate.sourcesFoundCount),
    avgSourcesVerified: avg(aggregate.sourcesVerifiedSum, aggregate.sourcesVerifiedCount),
    avgQualityScore: avg(aggregate.qualitySum, aggregate.qualityCount),
    avgLatencyMs: avg(aggregate.latencySum, aggregate.latencyCount),
  };
}

/** §15 interface: history for a workflow, best-evidence first. */
export function getWorkflowHistory(workflow: string): WorkflowStat[] {
  const prefix = `${workflow.trim().toLowerCase()}|`;
  const stats = [...memory.values()].filter((aggregate) => aggregate.workflow === workflow.trim().toLowerCase()).map(toStat);
  void prefix;
  // Rank: attempts (evidence volume) × avg quality — the user's insight:
  // "that's information you won't find on a benchmark leaderboard."
  return stats.sort((a, b) => {
    const scoreA = (a.avgQualityScore ?? 0.5) * Math.log1p(a.attempts);
    const scoreB = (b.avgQualityScore ?? 0.5) * Math.log1p(b.attempts);
    return scoreB - scoreA;
  });
}

/** Evidence for one (workflow, model, tools) combination, if observed. */
export function workflowEvidence(
  workflow: string,
  model: string | null,
  tools: string[]
): WorkflowStat | null {
  return toStat(memory.get(workflowKey(workflow, model, tools)) ?? {
    workflow: workflow.toLowerCase(),
    model,
    tools,
    attempts: 0,
    successes: 0,
    sourcesFoundSum: 0,
    sourcesFoundCount: 0,
    sourcesVerifiedSum: 0,
    sourcesVerifiedCount: 0,
    qualitySum: 0,
    qualityCount: 0,
    latencySum: 0,
    latencyCount: 0,
  });
}

export function workflowMemorySize(): number {
  return memory.size;
}
