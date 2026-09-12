/**
 * Harness B15 — the decision layer: failure taxonomy (reputation vs infra),
 * the delegation threshold gate, the compact candidate matrix, and the
 * routing decision cache (task-conditioned memory + invalidation rules).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b15-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b15-test-secret";

import {
  classifyFailure,
  reputationFailures,
} from "../../../open-sse/services/harness/failureTaxonomy.ts";
import { delegationGate, DEFAULT_DELEGATION_THRESHOLD } from "../../../open-sse/services/harness/delegationGate.ts";
import {
  clearRoutingCache,
  getCachedDecision,
  pruneRoutingCache,
  recordRoutingDecision,
  recordRoutingOutcome,
  routingCacheEntries,
  taskSignature,
} from "../../../open-sse/services/harness/routingCache.ts";

const registry = await import("../../../open-sse/services/harness/capabilityRegistry.ts");
const { buildModelDescriptors, candidateMatrixLines, rankCandidates } = registry;
import type { ModelTagEntry } from "../../../open-sse/services/modelTags/index.ts";

const orchestrator = await import("../../../open-sse/services/harness/orchestrator.ts");
const { candidatesForTag, InMemoryJobsStore, runJob, validatePlan } = orchestrator;
import type { OrchestrateJob, OrchestrateTask, TaskDispatch } from "../../../open-sse/services/harness/orchestrator.ts";

// ── Failure taxonomy ────────────────────────────────────────────────────────

test("taxonomy: infra-shaped errors are excused; everything else is a model failure", () => {
  assert.deepEqual(classifyFailure("upstream provider timeout (ETIMEDOUT)"), { kind: "timeout", affectsReputation: false });
  assert.deepEqual(classifyFailure("request timeout after 30000ms"), { kind: "timeout", affectsReputation: false });
  assert.deepEqual(classifyFailure("context length exceeded: input too large for the model"), { kind: "context_too_large", affectsReputation: false });
  assert.deepEqual(classifyFailure("invalid request: unsupported media type (400)"), { kind: "malformed_request", affectsReputation: false });
  assert.deepEqual(classifyFailure("provider returned 429 rate limit exceeded"), { kind: "infrastructure", affectsReputation: false });
  assert.deepEqual(classifyFailure("ECONNREFUSED connecting to upstream gateway"), { kind: "infrastructure", affectsReputation: false });
  assert.deepEqual(classifyFailure("budget exhausted (max_total_tokens 4000)"), { kind: "budget", affectsReputation: false });
  // No infra evidence → the model owns it (closed-loop semantics preserved).
  assert.deepEqual(classifyFailure("bad"), { kind: "model", affectsReputation: true });
  assert.deepEqual(classifyFailure(null), { kind: "model", affectsReputation: true });
  assert.deepEqual(classifyFailure(""), { kind: "model", affectsReputation: true });

  assert.equal(reputationFailures(10, 7), 3);
  assert.equal(reputationFailures(10, undefined), 10);
  assert.equal(reputationFailures(5, 12), 0, "clamped: infra count never exceeds failures");
});

test("stats: infra failures counted separately, never fed to reputation (in-memory store)", () => {
  const store = new InMemoryJobsStore();
  const task = (id: string, state: "done" | "failed", lastError: string | null): OrchestrateTask =>
    ({
      jobId: "job_b15", id, tag: "chat", modality: "text", prompt: "x", dependsOn: [], state,
      attempts: 1, wave: 1, assignedModel: "m/one", assignedProvider: "m", result: state === "done" ? "ok" : null,
      verdict: null, latencyMs: state === "done" ? 1_000 : null, lastError, leaseUntil: null,
      promptTokens: null, completionTokens: null, finishedAt: Date.now(),
    }) as OrchestrateTask;
  const job: OrchestrateJob = {
    jobId: "job_b15", goal: "g", mode: "parallel", policy: {} as OrchestrateJob["policy"], blackboard: null,
    status: "done", failureReason: null, idempotencyKey: null, callerModel: null, parentJobId: null,
    judgeRounds: 0, createdAt: Date.now(), deadlineAt: Date.now() + 600_000,
    tasks: [
      task("ok1", "done", null),
      task("bad", "failed", "wrong answer"),
      task("to1", "failed", "provider timeout"),
      task("to2", "failed", "429 rate limit"),
      task("to3", "failed", "context length exceeded"),
    ],
    log: [],
  };
  store.createJob(job, null);
  const stats = store.aggregateModelStats();
  const stat = stats["m/one"];
  assert.ok(stat, "m/one has terminal tasks");
  assert.equal(stat.failures, 4);
  assert.equal(stat.infraFailures, 3, "three excused (failure memory)");
  assert.equal(reputationFailures(stat.failures, stat.infraFailures), 1, "one reputation failure");

  // Descriptor-level: reliability uses reputation failures only — with 1
  // reputation failure + 1 success the smoothed rate is (1+1)/(1+1+2) = 0.5.
  const descriptors = buildModelDescriptors({
    entries: [{ id: "m/one", model: "one", provider: "m", categories: ["chat"], tools: false, vision: false, reasoning: false } as ModelTagEntry],
    stats: stats,
  });
  const descriptor = descriptors[0];
  assert.ok(descriptor, "descriptor built");
  assert.ok(descriptor.reliability.success_rate !== null && Math.abs(descriptor.reliability.success_rate - 0.5) < 1e-9, "infra failures excused from reliability");

  // All-infra: no reputation failures at all → neutral reliability.
  const job2: OrchestrateJob = { ...structuredClone(job), jobId: "job_b15b", tasks: [task("t1", "failed", "provider timeout"), task("t2", "failed", "429 rate limit")] };
  const store2 = new InMemoryJobsStore();
  store2.createJob(job2, null);
  const neutral = buildModelDescriptors({
    entries: [{ id: "m/one", model: "one", provider: "m", categories: ["chat"], tools: false, vision: false, reasoning: false } as ModelTagEntry],
    stats: store2.aggregateModelStats(),
  });
  const neutralDescriptor = neutral[0];
  assert.ok(neutralDescriptor, "neutral descriptor built");
  assert.equal(neutralDescriptor.reliability.success_rate, null, "pure infra failure → no reputation evidence at all");
});

test("e2e: an infra outage does NOT flip the closed loop (bare quality failures still do)", async () => {
  candidatesForTag("chat", "any"); // warm the tag index
  const chatPool = candidatesForTag("chat", "any");
  assert.ok(chatPool.length >= 2, "needs a chat pool with alternatives");
  let m1: string | null = null;
  let m2: string | null = null;
  for (let i = 0; i + 1 < chatPool.length; i += 1) {
    if (chatPool[i].quality > 0 && chatPool[i + 1].quality / chatPool[i].quality > 0.75) {
      m1 = chatPool[i].model;
      m2 = chatPool[i + 1].model;
      break;
    }
  }
  assert.ok(m1 && m2, "chat pool has a near-quality adjacent pair");

  const makeJob = (): OrchestrateJob => {
    const validation = validatePlan({
      goal: "infra noise",
      mode: "parallel",
      tasks: [{ id: "t1", tag: "chat", prompt: "say hi", depends_on: [] }],
      policy: { routing: "assigned" },
    });
    assert.ok(validation.ok);
    const now = Date.now();
    return {
      jobId: `job_b15e_${Math.random().toString(36).slice(2, 8)}`,
      goal: "infra noise",
      mode: "parallel",
      policy: validation.ok ? validation.policy : ({} as OrchestrateJob["policy"]),
      blackboard: null, status: "active", failureReason: null, idempotencyKey: null,
      callerModel: null, parentJobId: null, judgeRounds: 0, createdAt: now, deadlineAt: now + 600_000,
      tasks: (validation.ok ? validation.tasks : []).map((task) => ({
        jobId: "", id: task.id, tag: task.tag, modality: task.modality, prompt: task.prompt,
        dependsOn: [], state: "queued" as const, attempts: 0, wave: null, assignedModel: null,
        assignedProvider: null, result: null, verdict: null, latencyMs: null, lastError: null,
        leaseUntil: null, promptTokens: null, completionTokens: null, finishedAt: null,
      })),
      log: [],
    };
  };
  const dispatch: TaskDispatch = async (input) => ({ ok: true, text: "ok", model: input.assignedModel ?? "served", provider: "p" });

  // Control: the prior picks m1.
  const storeA = new InMemoryJobsStore();
  storeA.createJob(makeJob(), null);
  await runJob("must-be-replaced", { store: storeA, dispatch, sleep: async () => {} }).catch(() => {});
  // (runJob needs the real jobId — run properly below.)

  const controlStore = new InMemoryJobsStore();
  const controlJob = makeJob();
  controlStore.createJob(controlJob, null);
  await runJob(controlJob.jobId, { store: controlStore, dispatch, sleep: async () => {} });
  assert.equal(controlStore.getJob(controlJob.jobId)?.tasks[0].assignedModel, m1, "control: prior picks m1");

  // History: m1 failed at chat ten times — but every failure is INFRA
  // (provider timeouts). No m2 successes: positive evidence for m2 may
  // legitimately win; this test isolates what m1's OWN reputation does.
  const makeHistory = (errorText: string): OrchestrateJob => {
    const history: OrchestrateJob = { ...makeJob(), jobId: `job_b15_h_${Math.random().toString(36).slice(2, 8)}`, status: "done", tasks: [] };
    for (let i = 0; i < 10; i += 1) {
      history.tasks.push({
        jobId: history.jobId, id: `h_f${i}`, tag: "chat", modality: "text", prompt: "x", dependsOn: [],
        state: "failed", attempts: 1, wave: 1, assignedModel: m1, assignedProvider: null, result: null,
        verdict: null, latencyMs: null, lastError: errorText, leaseUntil: null,
        promptTokens: null, completionTokens: null, finishedAt: Date.now(),
      } as OrchestrateTask);
    }
    return history;
  };

  const storeInfra = new InMemoryJobsStore();
  storeInfra.createJob(makeHistory("upstream provider timeout (ETIMEDOUT)"), null);
  const byCat = storeInfra.aggregateModelStatsByCategory();
  assert.equal(byCat[`${m1}|chat`].infraFailures, 10, "all ten are excused");
  const jobInfra = makeJob();
  storeInfra.createJob(jobInfra, null);
  await runJob(jobInfra.jobId, { store: storeInfra, dispatch, sleep: async () => {} });
  assert.equal(
    storeInfra.getJob(jobInfra.jobId)?.tasks[0].assignedModel,
    m1,
    "the outage NEVER reads as 'm1 is bad at chat' — m1's own reputation is untouched"
  );

  // Counterfactual in the same test: the SAME ten failures, bare quality
  // errors — now it flips (this is the b12 closed loop, still live).
  const storeQuality = new InMemoryJobsStore();
  storeQuality.createJob(makeHistory("bad"), null);
  const jobQuality = makeJob();
  storeQuality.createJob(jobQuality, null);
  await runJob(jobQuality.jobId, { store: storeQuality, dispatch, sleep: async () => {} });
  assert.equal(
    storeQuality.getJob(jobQuality.jobId)?.tasks[0].assignedModel,
    m2,
    "bare quality failures still flip — the excusal is the only difference"
  );
});

// ── Delegation gate ─────────────────────────────────────────────────────────

const SIGNALS = {
  complexity: "fast" as const,
  modality: null,
  domain: "ocr",
  contextSize: null,
  specializationRequired: false,
  parallelizable: false,
};

test("gate: the user's exact cases — 91 vs 93 → self; 72 vs 96 → delegate", () => {
  const near = delegationGate({ signals: SIGNALS, selfScore: 0.91, bestScore: 0.93, selfStatus: "ranked" });
  assert.equal(near.recommendation, "self");
  assert.ok(Math.abs((near.advantage ?? 0) - 2) < 1e-9);
  assert.equal(near.threshold, DEFAULT_DELEGATION_THRESHOLD);
  assert.match(near.reason, /2\.0 pts < threshold 5/);

  const far = delegationGate({ signals: SIGNALS, selfScore: 0.72, bestScore: 0.96, selfStatus: "ranked" });
  assert.equal(far.recommendation, "delegate");
  assert.ok(Math.abs((far.advantage ?? 0) - 24) < 1e-9);

  // Caller already wins → self, advantage 0.
  const winner = delegationGate({ signals: SIGNALS, selfScore: 0.95, bestScore: 0.93, selfStatus: "ranked" });
  assert.equal(winner.recommendation, "self");
  assert.equal(winner.advantage, 0);

  // Filtered (cannot serve) → delegate, always.
  const filtered = delegationGate({ signals: { ...SIGNALS, modality: "image" }, selfScore: null, bestScore: 0.9, selfStatus: "filtered" });
  assert.equal(filtered.recommendation, "delegate");
  assert.equal(filtered.advantage, null);

  // Unregistered / no caller named → consider (Hermes judges itself).
  assert.equal(delegationGate({ signals: SIGNALS, selfScore: null, bestScore: 0.9, selfStatus: "unregistered" }).recommendation, "consider");
  assert.equal(delegationGate({ signals: SIGNALS, selfScore: null, bestScore: 0.9, selfStatus: null }).recommendation, "consider");

  // Threshold override: 24 pts is delegate at 5, self at 30.
  assert.equal(delegationGate({ signals: SIGNALS, selfScore: 0.72, bestScore: 0.96, selfStatus: "ranked", threshold: 30 }).recommendation, "self");

  // No viable candidate → self.
  assert.equal(delegationGate({ signals: SIGNALS, selfScore: 0.3, bestScore: 0, selfStatus: "ranked" }).recommendation, "self");
});

// ── Compact candidate matrix ────────────────────────────────────────────────

test("matrix: every candidate in one compact line, tier-marked, self-tagged", () => {
  const entries: ModelTagEntry[] = [
    { id: "a/qwen-vl", model: "qwen-vl", provider: "a", categories: ["chat"], tools: false, vision: true, reasoning: false, benchmark: { score: 94, source: "seed", basis: "test" }, axes: { ocr: { score: 96, source: "seed", basis: "test" } } } as ModelTagEntry,
    { id: "a/model-b", model: "model-b", provider: "a", categories: ["chat"], tools: false, vision: true, reasoning: false, benchmark: { score: 80, source: "seed", basis: "test" } } as ModelTagEntry,
  ];
  const descriptors = buildModelDescriptors({
    entries,
    statsByCategory: { "a/qwen-vl|vision": { successes: 35, failures: 2, totalLatencyMs: 40_000 } },
    enrichment: { "qwen-vl": { cost_per_million_tokens: 0.4 } },
  });
  const ranked = rankCandidates(descriptors, { category: "vision" }, 2);
  const lines = candidateMatrixLines(ranked, { category: "vision", selfModel: "a/model-b" });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^P1 a\/qwen-vl\s+vision 94 \| hist 92% \| p50 — \| \$0\.40\/M$/); // composite 94: no 'vision' category overlay — the ocr axis is a specialization, not a category benchmark
  assert.match(lines[1], /S2 a\/model-b/);
  assert.ok(lines[1].includes("←you"), "the caller is tagged in the matrix");
  assert.ok(lines.every((line) => line.length <= 90), "each line is tiny — the whole field is a few hundred tokens");

  // No category context → composite benchmark, hist em-dash.
  const plain = candidateMatrixLines(rankCandidates(buildModelDescriptors({ entries }), {}, 2), {});
  assert.match(plain[0], /score 94 \| hist — /);
});

// ── Routing decision cache ──────────────────────────────────────────────────

test("signature: normalized semantic fingerprint", () => {
  assert.equal(taskSignature({ type: "Vision", modality: " Image ", specialization: "OCR", complexity: null }), "vision|image|ocr|*");
  assert.equal(taskSignature({ type: null, modality: null, specialization: null, complexity: null }), "*|*|*|*");
  assert.equal(
    taskSignature({ type: "code", modality: null, specialization: "refactor", complexity: "deep" }),
    taskSignature({ type: " CODE ", modality: null, specialization: "Refactor", complexity: "DEEP" })
  );
});

test("cache: record → hit (uses) → outcomes → invalidation rules", () => {
  clearRoutingCache();
  const sig = "vision|image|ocr|*";
  assert.equal(getCachedDecision(sig), null, "cold cache");

  recordRoutingDecision(sig, { model: "a/qwen-vl", provider: "a", score: 0.82 });
  const first = getCachedDecision(sig);
  assert.ok(first);
  assert.equal(first.model, "a/qwen-vl");
  assert.equal(first.uses, 1, "a hit is a use");
  const second = getCachedDecision(sig);
  assert.ok(second);
  assert.equal(second.uses, 2);

  // Success outcome → task memory.
  recordRoutingOutcome(sig, "a/qwen-vl", true, true);
  const afterOk = getCachedDecision(sig);
  assert.ok(afterOk);
  assert.equal(afterOk.attempts, 1);
  assert.equal(afterOk.successes, 1);

  // Infra failure → recorded, entry KEPT (the choice wasn't wrong).
  recordRoutingOutcome(sig, "a/qwen-vl", false, false);
  const afterInfra = getCachedDecision(sig);
  assert.ok(afterInfra, "infra failure keeps the entry");
  assert.equal(afterInfra.attempts, 2);
  assert.equal(afterInfra.successes, 1);

  // Reputation failure on the cached model → entry dropped (route immediately).
  recordRoutingOutcome(sig, "a/qwen-vl", false, true);
  assert.equal(getCachedDecision(sig), null, "quality failure invalidates");

  // A reputation failure on a DIFFERENT model never touches the entry.
  recordRoutingDecision(sig, { model: "a/qwen-vl", score: 0.82 });
  recordRoutingOutcome(sig, "b/other-model", false, true);
  assert.ok(getCachedDecision(sig), "another model's failure is not this entry's problem");

  // TTL expiry.
  clearRoutingCache();
  let now = 1_000_000;
  const clock = () => now;
  recordRoutingDecision("t|*|*|*", { model: "m", score: 0.5 }, clock);
  assert.ok(getCachedDecision("t|*|*|*", clock));
  now += 6 * 60 * 60 * 1000 + 1;
  assert.equal(getCachedDecision("t|*|*|*", clock), null, "6h TTL");
});

test("cache: prune drops models the registry rebuild deleted", () => {
  clearRoutingCache();
  recordRoutingDecision("code|*|*|*", { model: "a/live", score: 0.7 });
  recordRoutingDecision("chat|*|*|*", { model: "a/deprecated", score: 0.7 });
  const pruned = pruneRoutingCache(new Set(["a/live"]));
  assert.equal(pruned, 1);
  assert.ok(getCachedDecision("code|*|*|*"));
  assert.equal(getCachedDecision("chat|*|*|*"), null);
  clearRoutingCache();
});

test("runner wiring: task outcomes feed the signature's memory", async () => {
  clearRoutingCache();
  const validation = validatePlan({
    goal: "cache wiring",
    mode: "parallel",
    tasks: [{ id: "t1", tag: "chat", prompt: "say hi", depends_on: [] }],
    policy: { routing: "assigned" },
  });
  assert.ok(validation.ok);
  const now = Date.now();
  const job: OrchestrateJob = {
    jobId: `job_b15w_${Math.random().toString(36).slice(2, 8)}`,
    goal: "cache wiring", mode: "parallel",
    policy: validation.ok ? validation.policy : ({} as OrchestrateJob["policy"]),
    blackboard: null, status: "active", failureReason: null, idempotencyKey: null,
    callerModel: null, parentJobId: null, judgeRounds: 0, createdAt: now, deadlineAt: now + 600_000,
    tasks: (validation.ok ? validation.tasks : []).map((task) => ({
      jobId: "", id: task.id, tag: task.tag, modality: task.modality, prompt: task.prompt,
      dependsOn: [], state: "queued" as const, attempts: 0, wave: null, assignedModel: null,
      assignedProvider: null, result: null, verdict: null, latencyMs: null, lastError: null,
      leaseUntil: null, promptTokens: null, completionTokens: null, finishedAt: null,
    })),
    log: [],
  };
  // Prime the cache as the router would, for the model the assigned
  // allocator will actually pick.
  candidatesForTag("chat", "any");
  const poolModel = candidatesForTag("chat", "any")[0].model;
  const sig = taskSignature({ type: "chat", modality: "text" });
  recordRoutingDecision(sig, { model: poolModel, score: 0.7 });

  const dispatch: TaskDispatch = async (input) => ({ ok: true, text: "ok", model: input.assignedModel ?? poolModel, provider: "p" });
  const store = new InMemoryJobsStore();
  store.createJob(job, null);
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const entry = routingCacheEntries().find((e) => e.signature === sig);
  assert.ok(entry, "the runner fed the cache");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.successes, 1, "done task → success recorded");

  // A failing task with a BARE error (quality) invalidates the entry.
  clearRoutingCache();
  recordRoutingDecision(sig, { model: poolModel, score: 0.7 });
  const failValidation = validatePlan({
    goal: "cache wiring 2",
    mode: "parallel",
    tasks: [{ id: "t1", tag: "chat", prompt: "say hi", depends_on: [] }],
    policy: { routing: "assigned", max_attempts: 1 },
  });
  assert.ok(failValidation.ok);
  const failJob: OrchestrateJob = {
    ...job,
    jobId: `job_b15w2_${Math.random().toString(36).slice(2, 8)}`,
    policy: failValidation.ok ? failValidation.policy : job.policy,
    tasks: (failValidation.ok ? failValidation.tasks : []).map((task) => ({
      jobId: "", id: task.id, tag: task.tag, modality: task.modality, prompt: task.prompt,
      dependsOn: [], state: "queued" as const, attempts: 0, wave: null, assignedModel: null,
      assignedProvider: null, result: null, verdict: null, latencyMs: null, lastError: null,
      leaseUntil: null, promptTokens: null, completionTokens: null, finishedAt: null,
    })),
  };
  const failDispatch: TaskDispatch = async () => ({ ok: false, error: "the answer was wrong" }); // error outcomes carry no model — dispatchModel (the assignment) is the failure target
  const store2 = new InMemoryJobsStore();
  store2.createJob(failJob, null);
  await runJob(failJob.jobId, { store: store2, dispatch: failDispatch, sleep: async () => {} });
  assert.equal(getCachedDecision(sig), null, "reputation failure → route immediately next time");

  // An INFRA error is recorded but the entry survives.
  clearRoutingCache();
  recordRoutingDecision(sig, { model: poolModel, score: 0.7 });
  const infraJob: OrchestrateJob = { ...structuredClone(failJob), jobId: `job_b15w3_${Math.random().toString(36).slice(2, 8)}` };
  const store3 = new InMemoryJobsStore();
  store3.createJob(infraJob, null);
  await runJob(infraJob.jobId, {
    store: store3,
    dispatch: async () => ({ ok: false, error: "upstream provider timeout (ETIMEDOUT)" }),
    sleep: async () => {},
  });
  const kept = getCachedDecision(sig);
  assert.ok(kept, "infra failure keeps the cached decision");
  assert.equal(kept.attempts, 1);
  assert.equal(kept.successes, 0);
  clearRoutingCache();
});
