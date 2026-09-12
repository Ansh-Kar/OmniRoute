/**
 * Harness B13 — advisory task profiles, benchmark provenance
 * (public/internal/confidence), runtime percentiles with a 30d window,
 * terminal-stamp anchoring, and registry versioning/refresh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b13-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b13-test-secret";

const registry = await import("../../../open-sse/services/harness/capabilityRegistry.ts");
const {
  buildModelDescriptors,
  filterCandidates,
  rankCandidates,
  unifiedScore,
  taskProfile,
  refreshRegistry,
  ensureRegistryFresh,
  registryVersionInfo,
  REGISTRY_STALENESS_GUIDANCE,
} = registry;
import type { ModelTagEntry } from "../../../open-sse/services/modelTags/index.ts";
import type { SelfAssessment } from "../../../open-sse/services/harness/capabilityRegistry.ts";

const orchestrator = await import("../../../open-sse/services/harness/orchestrator.ts");
const { InMemoryJobsStore } = orchestrator;
import type { OrchestrateJob, OrchestrateTask } from "../../../open-sse/services/harness/orchestrator.ts";

function entry(overrides: Partial<ModelTagEntry> & { id: string }): ModelTagEntry {
  return {
    model: overrides.id.includes("/") ? overrides.id.split("/")[1] : overrides.id,
    provider: overrides.id.includes("/") ? overrides.id.split("/")[0] : "p",
    categories: ["chat"],
    tools: false,
    vision: false,
    reasoning: false,
    ...overrides,
  } as ModelTagEntry;
}

const ENTRIES: ModelTagEntry[] = [
  entry({ id: "a/strong", benchmark: { score: 95, source: "seed", basis: "test" }, axes: { gpqa: { score: 92, source: "seed", basis: "test" } } }),
  entry({ id: "a/mid", benchmark: { score: 80, source: "seed", basis: "test" } }),
  entry({ id: "b/weak", benchmark: { score: 50, source: "seed", basis: "test" } }),
  entry({ id: "b/mystery" }), // no public benchmark at all
];

// ── Benchmark provenance ─────────────────────────────────────────────────────

test("provenance: public (nullable), internal from workload, confidence from samples", () => {
  const withStats = buildModelDescriptors({
    entries: ENTRIES,
    stats: {
      "a/strong": { successes: 60, failures: 0, totalLatencyMs: 120_000 }, // 61 samples → high
      "a/mid": { successes: 9, failures: 1, totalLatencyMs: 20_000 }, // 10 → medium
    },
  });
  const strong = withStats.find((d) => d.id === "a/strong");
  assert.ok(strong);
  assert.equal(strong.benchmark_provenance.composite.public, 95);
  assert.equal(strong.benchmark_provenance.composite.internal, 98, "laplace(60,0) = 61/62 = 0.9839 → ×100 → 98");
  assert.equal(strong.benchmark_provenance.composite.confidence, "high");

  const mid = withStats.find((d) => d.id === "a/mid");
  assert.ok(mid);
  assert.equal(mid.benchmark_provenance.composite.confidence, "medium");

  const mystery = withStats.find((d) => d.id === "b/mystery");
  assert.ok(mystery);
  assert.equal(mystery.benchmarks.composite, undefined, "no public number at all");
  assert.equal(mystery.benchmark_provenance.composite, undefined);
  // Unknown ≠ unusable: the model is still a candidate.
  assert.ok(filterCandidates([mystery], {}).candidates.length === 1);
});

test("score: a missing public benchmark falls back to INTERNAL evidence, never neutral-zero", () => {
  const statsByCategory = {
    "b/mystery|chat": { successes: 20, failures: 0, totalLatencyMs: 40_000 }, // laplace = 21/22 ≈ 0.9545
  };
  const descriptors = buildModelDescriptors({ entries: ENTRIES, statsByCategory });
  const mystery = descriptors.find((d) => d.id === "b/mystery");
  assert.ok(mystery);
  const scored = unifiedScore(mystery, { category: "chat" });
  // internalAsBenchmark: 0.9545×100 → benchmark ≈ 0.9545 (NOT the neutral 0.5).
  assert.ok(Math.abs(scored.breakdown.benchmark - 0.9545) < 0.01, `internal substitutes for the missing public score (got ${scored.breakdown.benchmark})`);

  const withoutCategory = unifiedScore(mystery, {});
  assert.ok(Math.abs(withoutCategory.breakdown.benchmark - 0.5) < 1e-9, "no category context and no public score → neutral 0.5");
});

// ── Task profile (advisory routing) ─────────────────────────────────────────

function rankedOf(stats?: Record<string, { successes: number; failures: number; totalLatencyMs: number }>) {
  const descriptors = buildModelDescriptors({ entries: ENTRIES, stats });
  const { candidates } = filterCandidates(descriptors, {});
  return { ranked: rankCandidates(candidates, {}, 3), descriptors };
}

function selfOf(model: string, ranked: ReturnType<typeof rankCandidates>, descriptors: ReturnType<typeof buildModelDescriptors>): SelfAssessment {
  return registry.selfAssess(model, ranked, descriptors.filter((d) => !ranked.some((r) => r.descriptor.id === d.id)));
}

test("profile: specialist advantage HIGH/MEDIUM/NONE by score ratio", () => {
  const { ranked, descriptors } = rankedOf();
  // Caller = the weak model: best/strong ≫ weak → HIGH.
  const weakSelf = selfOf("b/weak", ranked, descriptors);
  const high = taskProfile(ranked, { domain: "ocr", complexity: "deep", input: "image" }, weakSelf);
  assert.equal(high.specialist_advantage, "high");
  assert.equal(high.self_estimate, "marginal");
  assert.equal(high.domain, "ocr");
  assert.equal(high.complexity, "deep");
  assert.equal(high.input, "image");
  assert.equal(high.best_available.length, 3, "top-3 best available");
  assert.equal(high.best_available[0].id, "a/strong");

  // Caller = the strongest: NONE (self-competitive), capable.
  const strongSelf = selfOf("a/strong", ranked, descriptors);
  const none = taskProfile(ranked, {}, strongSelf);
  assert.equal(none.specialist_advantage, "none");
  assert.equal(none.self_estimate, "capable");

  // No caller named: advantage NONE, estimate capable (nothing to compare).
  const anon = taskProfile(ranked, {}, null);
  assert.equal(anon.specialist_advantage, "none");

  // Caller filtered out: incapable on both axes.
  const visionOnly = rankCandidates(filterCandidates(buildModelDescriptors({ entries: ENTRIES }), { capability: "vision" }).candidates, {}, 3);
  const filtered = registry.selfAssess("a/strong", visionOnly, buildModelDescriptors({ entries: ENTRIES }));
  const incapable = taskProfile(visionOnly, {}, filtered);
  assert.equal(incapable.specialist_advantage, "incapable");
  assert.equal(incapable.self_estimate, "incapable");

  // MEDIUM band: mid vs strong ratio.
  const midSelf = selfOf("a/mid", ranked, descriptors);
  const medium = taskProfile(ranked, {}, midSelf);
  assert.equal(medium.specialist_advantage, "medium");
});

// ── Runtime percentiles + 30d window ────────────────────────────────────────

test("stats: p50/p95 nearest-rank over done latencies", () => {
  const store = new InMemoryJobsStore();
  const job: OrchestrateJob = {
    jobId: "job_p",
    goal: "g",
    mode: "parallel",
    policy: {} as OrchestrateJob["policy"],
    blackboard: null,
    status: "done",
    failureReason: null,
    idempotencyKey: null,
    callerModel: null,
    parentJobId: null,
    judgeRounds: 0,
    createdAt: Date.now(),
    deadlineAt: Date.now() + 600_000,
    tasks: [],
    log: [],
  };
  const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  job.tasks = latencies.map(
    (latency, i) =>
      ({
        jobId: job.jobId,
        id: `t${i}`,
        tag: "chat",
        modality: "text",
        prompt: "x",
        dependsOn: [],
        state: "done",
        attempts: 1,
        wave: 1,
        assignedModel: "m/percentile",
        assignedProvider: "m",
        result: "ok",
        verdict: null,
        latencyMs: latency,
        lastError: null,
        leaseUntil: null,
        promptTokens: null,
        completionTokens: null,
        finishedAt: Date.now(),
      }) as OrchestrateTask
  );
  store.createJob(job, null);
  const stats = store.aggregateModelStats();
  assert.equal(stats["m/percentile"].successes, 10);
  assert.equal(stats["m/percentile"].p50LatencyMs, 500, "nearest-rank p50 of 10 values");
  assert.equal(stats["m/percentile"].p95LatencyMs, 1000, "nearest-rank p95");
});

test("stats: the 30d window excludes ancient history", () => {
  const store = new InMemoryJobsStore();
  const make = (id: string, state: "done" | "failed", finishedAt: number | null): OrchestrateTask =>
    ({ jobId: "job_w", id, tag: "code", modality: "text", prompt: "x", dependsOn: [], state, attempts: 1, wave: 1, assignedModel: "m/old", assignedProvider: "m", result: null, verdict: null, latencyMs: 100, lastError: null, leaseUntil: null, promptTokens: null, completionTokens: null, finishedAt }) as OrchestrateTask;
  const job: OrchestrateJob = {
    jobId: "job_w",
    goal: "g",
    mode: "parallel",
    policy: {} as OrchestrateJob["policy"],
    blackboard: null,
    status: "done",
    failureReason: null,
    idempotencyKey: null,
    callerModel: null,
    parentJobId: null,
    judgeRounds: 0,
    createdAt: Date.now(),
    deadlineAt: Date.now() + 600_000,
    tasks: [
      make("recent", "done", Date.now() - 1000),
      make("ancient", "done", Date.now() - 31 * 24 * 60 * 60 * 1000), // outside the window
      make("unstamped", "done", null), // pre-B13 row → counts as in-window
    ],
    log: [],
  };
  store.createJob(job, null);
  const stats = store.aggregateModelStats();
  assert.equal(stats["m/old"].successes, 2, "recent + unstamped counted; the 31d-old task excluded");
});

test("transitions: terminal writes stamp finishedAt, running does not", () => {
  const store = new InMemoryJobsStore();
  const job: OrchestrateJob = {
    jobId: "job_stamp",
    goal: "g",
    mode: "parallel",
    policy: {} as OrchestrateJob["policy"],
    blackboard: null,
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    callerModel: null,
    parentJobId: null,
    judgeRounds: 0,
    createdAt: Date.now(),
    deadlineAt: Date.now() + 600_000,
    tasks: [
      {
        jobId: "job_stamp", id: "t1", tag: "chat", modality: "text", prompt: "x", dependsOn: [],
        state: "queued", attempts: 0, wave: null, assignedModel: null, assignedProvider: null,
        result: null, verdict: null, latencyMs: null, lastError: null, leaseUntil: null,
        promptTokens: null, completionTokens: null, finishedAt: null,
      },
    ],
    log: [],
  };
  store.createJob(job, null);
  store.writeTaskTransition("job_stamp", "t1", { state: "running" });
  assert.equal(store.getJob("job_stamp")?.tasks[0].finishedAt, null, "running: no stamp");
  const before = Date.now();
  store.writeTaskTransition("job_stamp", "t1", { state: "done", result: "ok" });
  const stamped = store.getJob("job_stamp")?.tasks[0].finishedAt;
  assert.ok(typeof stamped === 'number' && stamped >= before, "terminal transition stamps finishedAt");
});

// ── Registry versioning + refresh ───────────────────────────────────────────

test("versioning: refresh stamps a date version; fresh() no-ops within the interval", () => {
  const version = refreshRegistry();
  assert.match(version.version, /^\d{4}\.\d{2}\.\d{2}$/, "date-stamped registry version");
  assert.equal(version.runtime_stats_window, "30d");
  const infoAfter = registryVersionInfo();
  assert.equal(infoAfter.version, version.version);

  // Within the 6h interval: same stamp, no rebuild.
  const fresh = ensureRegistryFresh();
  assert.equal(fresh.version, version.version);

  // The guidance is the user's exact stance.
  assert.ok(REGISTRY_STALENESS_GUIDANCE.toLowerCase().includes("stale"));
  assert.ok(REGISTRY_STALENESS_GUIDANCE.toLowerCase().includes("internal"));
});
