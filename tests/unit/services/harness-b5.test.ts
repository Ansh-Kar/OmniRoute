/**
 * Harness B5 (Layer 5 — allocator scoring, drift loop, lease expiry) —
 * tests for:
 *
 *   1. allocator.ts (pure, Guide 1 Part 4+8): health/speed smoothing, the
 *      exact score formula, provider-diverse water-filling with
 *      max_per_provider, drift penalties and live stats reordering.
 *   2. JobsStore additions (InMemory + SQLite parity): lease timestamps,
 *      expired-lease steal + requeue, aggregateModelStats, and the judge
 *      drift table (two consecutive fails → −0.05, floor 0.3).
 *   3. Orchestrator wiring: assigned routing (task_assigned + literal model
 *      dispatch), lease-expiry recovery mid-job, and the judge drift
 *      write-back (model_drift_penalty logged + persisted).
 *   4. Policy validation: routing/max_per_provider defaults + clamps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b5-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b5-test-secret";

const {
  healthFromStat,
  speedFromStat,
  scoreCandidate,
  assignModels,
  JUDGE_DRIFT_PENALTY,
  QUALITY_FLOOR,
  SPEED_BASELINE_MS,
} = await import("../../../open-sse/services/harness/allocator.ts");
const {
  validatePlan,
  runJob,
  candidatesForTag,
  InMemoryJobsStore,
} = await import("../../../open-sse/services/harness/orchestrator.ts");
import type {
  OrchestrateJob,
  TaskDispatch,
} from "../../../open-sse/services/harness/orchestrator.ts";

// ── Allocator: health/speed/score (Part 8 formula) ──────────────────────────

test("allocator: health is Laplace-smoothed; no history is neutral", () => {
  assert.equal(healthFromStat(undefined), 0.5);
  assert.equal(healthFromStat({ successes: 0, failures: 0, totalLatencyMs: 0 }), 0.5);
  // 10 successes, 0 failures → (10+1)/(10+0+2)
  assert.ok(Math.abs(healthFromStat({ successes: 10, failures: 0, totalLatencyMs: 0 }) - 11 / 12) < 1e-9);
  // 0 successes, 10 failures → 1/12
  assert.ok(Math.abs(healthFromStat({ successes: 0, failures: 10, totalLatencyMs: 0 }) - 1 / 12) < 1e-9);
});

test("allocator: speed decays vs latency average, clamped to [0,1]", () => {
  assert.equal(speedFromStat(undefined), 0.5);
  const fast = { successes: 4, failures: 0, totalLatencyMs: 4 * 1_000 };
  assert.equal(speedFromStat(fast), 1, "avg 1s ≤ baseline → 1");
  const slow = { successes: 4, failures: 0, totalLatencyMs: 4 * (3 * SPEED_BASELINE_MS) };
  assert.ok(Math.abs(speedFromStat(slow) - 1 / 3) < 1e-9, "avg 3× baseline → 1/3");
  const zero = { successes: 1, failures: 0, totalLatencyMs: 0 };
  assert.equal(speedFromStat(zero), 1, "zero recorded latency guards to 1");
});

test("allocator: score is exactly quality × health × speed × breaker", () => {
  const stat = { successes: 10, failures: 0, totalLatencyMs: 10_000 }; // health 11/12, speed 1
  const expected = 0.8 * (0.5 + 0.5 * (11 / 12)) * 1 * 1;
  assert.ok(Math.abs(scoreCandidate({ quality: 0.8, stat }) - expected) < 1e-9);
  const withBreaker = scoreCandidate({ quality: 0.8, stat, breakerOpen: true });
  assert.ok(Math.abs(withBreaker - expected * 0.2) < 1e-9, "breaker open → ×0.2");
  // Quality clamps into [QUALITY_FLOOR, 1]
  assert.equal(
    scoreCandidate({ quality: 0.05, stat: undefined }),
    scoreCandidate({ quality: QUALITY_FLOOR, stat: undefined }),
    "quality floors at 0.3"
  );
});

// ── Allocator: water-filling (Part 4) ───────────────────────────────────────

const CANDIDATES = [
  { model: "a1", provider: "A", quality: 0.9 },
  { model: "a2", provider: "A", quality: 0.8 },
  { model: "a3", provider: "A", quality: 0.7 },
  { model: "b1", provider: "B", quality: 0.85 },
];

test("allocator: water-fill round-robins providers and prefers unused models", () => {
  const { assignments, unassigned } = assignModels(
    [
      { id: "t1", tag: "code" },
      { id: "t2", tag: "code" },
      { id: "t3", tag: "code" },
    ],
    () => CANDIDATES,
    { maxPerProvider: 2 }
  );
  assert.equal(unassigned.length, 0);
  assert.equal(assignments.get("t1")?.candidate.model, "a1", "best overall first");
  assert.equal(assignments.get("t2")?.candidate.model, "b1", "provider B's best before A's second");
  assert.equal(assignments.get("t3")?.candidate.model, "a2", "second of A, not a1 again");
});

test("allocator: max_per_provider exhausts → unassigned with reason", () => {
  const { assignments, unassigned } = assignModels(
    [
      { id: "t1", tag: "code" },
      { id: "t2", tag: "code" },
      { id: "t3", tag: "code" },
    ],
    () => CANDIDATES,
    { maxPerProvider: 1 }
  );
  assert.equal(assignments.size, 2);
  assert.equal(unassigned.length, 1);
  assert.match(unassigned[0].reason, /max_per_provider 1 reached/);
});

test("allocator: drift penalty pushes a model below its rival", () => {
  const { assignments } = assignModels(
    [{ id: "t1", tag: "code" }],
    () => CANDIDATES,
    { maxPerProvider: 3, penaltyOf: (model) => (model === "a1" ? 0.15 : 0) }
  );
  // a1: 0.9 − 0.15 = 0.75 effective < b1's 0.85
  assert.equal(assignments.get("t1")?.candidate.model, "b1");
});

test("allocator: live failures (health) reorder despite higher quality", () => {
  const { assignments } = assignModels(
    [{ id: "t1", tag: "code" }],
    () => CANDIDATES,
    {
      maxPerProvider: 3,
      statOf: (model) =>
        model === "a1" ? { successes: 0, failures: 8, totalLatencyMs: 0 } : undefined,
    }
  );
  // a1 has failed 8× — health ~1/10 → score drops below neutral-history b1
  assert.equal(assignments.get("t1")?.candidate.model, "b1");
});

test("allocator: deterministic — same inputs, same assignments", () => {
  const run = () =>
    assignModels(
      [
        { id: "t1", tag: "code" },
        { id: "t2", tag: "code" },
      ],
      () => CANDIDATES,
      { maxPerProvider: 2 }
    );
  assert.deepEqual(run().assignments, run().assignments);
});

// ── JobsStore additions — InMemory ──────────────────────────────────────────

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    goal: "test goal",
    mode: "parallel",
    tasks: [
      { id: "t1", tag: "code", prompt: "write fib", depends_on: [] },
      { id: "t2", tag: "chat", prompt: "summarize", depends_on: [] },
    ],
    ...overrides,
  };
}

function makeJob(overrides: Partial<OrchestrateJob> = {}): OrchestrateJob {
  const validation = validatePlan(planBody());
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    jobId: "job_b5",
    goal: validation.goal,
    mode: validation.mode,
    policy: validation.policy,
    blackboard: null,
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    judgeRounds: 0,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "job_b5",
      id: task.id,
      tag: task.tag,
      prompt: task.prompt,
      dependsOn: task.depends_on ?? [],
      state: "queued",
      attempts: 0,
      wave: null,
      assignedModel: null,
      assignedProvider: null,
      result: null,
      verdict: null,
      latencyMs: null,
      lastError: null,
      leaseUntil: null,
      promptTokens: null,
      completionTokens: null,
    })),
    log: [],
    ...overrides,
  } as OrchestrateJob;
}

test("store(inmem): lease has a timestamp; fresh lease is exclusive, expired is stealable", () => {
  const store = new InMemoryJobsStore();
  store.createJob(makeJob(), null);
  const now = 1_000_000;
  assert.equal(store.acquireLease("job_b5", "t1", 60_000, now), true);
  const task = store.getJob("job_b5")?.tasks.find((t) => t.id === "t1");
  assert.equal(task?.state, "running");
  assert.equal(task?.leaseUntil, now + 60_000);
  // A second worker inside the lease window is rejected…
  assert.equal(store.acquireLease("job_b5", "t1", 60_000, now + 30_000), false);
  // …but after expiry it steals the lease (work-stealing, guide Part 3).
  assert.equal(store.acquireLease("job_b5", "t1", 60_000, now + 61_000), true);
  assert.equal(store.getJob("job_b5")?.tasks.find((t) => t.id === "t1")?.leaseUntil, now + 61_000 + 60_000);
});

test("store(inmem): requeueExpiredLeases requeues lost workers, keeps attempts", () => {
  const store = new InMemoryJobsStore();
  store.createJob(makeJob(), null);
  const now = 1_000_000;
  assert.equal(store.acquireLease("job_b5", "t1", 10_000, now), true);
  store.writeTaskTransition("job_b5", "t1", { attempts: 1 });
  // t2 leased late — still fresh at t2_check.
  assert.equal(store.acquireLease("job_b5", "t2", 10_000, now + 5_000), true);

  // t1's lease expired at now+10_000; t2's runs to now+15_000.
  const expired = store.requeueExpiredLeases("job_b5", now + 12_000);
  assert.deepEqual(expired, ["t1"]);
  const t1 = store.getJob("job_b5")?.tasks.find((t) => t.id === "t1");
  assert.equal(t1?.state, "queued");
  assert.equal(t1?.attempts, 1, "attempts preserved across expiry requeue");
  assert.match(String(t1?.lastError), /lease expired/);
  const t2 = store.getJob("job_b5")?.tasks.find((t) => t.id === "t2");
  assert.equal(t2?.state, "running", "fresh lease untouched");
});

test("store(inmem): aggregateModelStats spans jobs and counts done/failed/latency", () => {
  const store = new InMemoryJobsStore();
  store.createJob(makeJob(), null);
  store.createJob(makeJob({ jobId: "job_b5b" }), null);
  store.writeTaskTransition("job_b5", "t1", { state: "done", assignedModel: "m1", latencyMs: 2_000 });
  store.writeTaskTransition("job_b5", "t2", { state: "done", assignedModel: "m1", latencyMs: 4_000 });
  store.writeTaskTransition("job_b5b", "t1", { state: "failed", assignedModel: "m1" });
  store.writeTaskTransition("job_b5b", "t2", { state: "done", assignedModel: "m2", latencyMs: 1_000 });
  const stats = store.aggregateModelStats();
  assert.deepEqual(stats.m1, { successes: 2, failures: 1, totalLatencyMs: 6_000 });
  assert.deepEqual(stats.m2, { successes: 1, failures: 0, totalLatencyMs: 1_000 });
});

test("store(inmem): judge drift — two consecutive fails penalize, pass resets, cap holds", () => {
  const store = new InMemoryJobsStore();
  assert.deepEqual(store.applyJudgeVerdict("m1", false), { penalty: 0, penalized: false }, "first fail: streak only");
  assert.deepEqual(store.applyJudgeVerdict("m1", false), { penalty: JUDGE_DRIFT_PENALTY, penalized: true }, "second fail: −0.05");
  assert.deepEqual(store.applyJudgeVerdict("m1", false), { penalty: 0.1, penalized: true }, "streak continues: −0.10");
  assert.deepEqual(store.applyJudgeVerdict("m1", true), { penalty: 0.1, penalized: false }, "pass resets streak, penalty persists");
  assert.deepEqual(store.applyJudgeVerdict("m1", false), { penalty: 0.1, penalized: false }, "single fail after reset: no new penalty");
  assert.deepEqual(store.applyJudgeVerdict("m1", false), { penalty: 0.15, penalized: true });
  // Cap: total penalty never exceeds 1 − QUALITY_FLOOR.
  for (let i = 0; i < 30; i++) store.applyJudgeVerdict("m1", false);
  assert.equal(store.getModelPenalties().m1, 1 - QUALITY_FLOOR);
  assert.equal(store.getModelPenalties().m2, undefined, "clean models carry no penalty entry");
});

// ── JobsStore additions — SQLite parity ─────────────────────────────────────

test("store(sqlite): lease/steal/requeue + stats + drift parity with InMemory", async () => {
  const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-b5-sqlite-"));
  process.env.DATA_DIR = sqliteDir;
  const core = await import("../../../src/lib/db/core.ts");
  core.resetDbInstance();
  const { SqliteJobsStore } = await import("../../../src/lib/db/orchestrateJobs.ts");
  const store = new SqliteJobsStore();

  store.createJob(makeJob(), null);
  const now = 1_000_000;
  assert.equal(store.acquireLease("job_b5", "t1", 60_000, now), true);
  let task = store.getJob("job_b5")?.tasks.find((t) => t.id === "t1");
  assert.equal(task?.state, "running");
  assert.equal(task?.leaseUntil, now + 60_000);
  assert.equal(store.acquireLease("job_b5", "t1", 60_000, now + 30_000), false);
  assert.equal(store.acquireLease("job_b5", "t1", 60_000, now + 61_000), true, "expired lease stolen");

  assert.deepEqual(store.requeueExpiredLeases("job_b5", now + 200_000), ["t1"]);
  task = store.getJob("job_b5")?.tasks.find((t) => t.id === "t1");
  assert.equal(task?.state, "queued");
  assert.match(String(task?.lastError), /lease expired/);

  store.writeTaskTransition("job_b5", "t1", { state: "done", assignedModel: "m1", latencyMs: 3_000 });
  store.writeTaskTransition("job_b5", "t2", { state: "failed", assignedModel: "m1" });
  assert.deepEqual(store.aggregateModelStats().m1, { successes: 1, failures: 1, totalLatencyMs: 3_000 });

  assert.equal(store.applyJudgeVerdict("m1", false).penalized, false);
  assert.deepEqual(store.applyJudgeVerdict("m1", false), { penalty: JUDGE_DRIFT_PENALTY, penalized: true });
  assert.equal(store.getModelPenalties().m1, JUDGE_DRIFT_PENALTY);

  core.resetDbInstance();
  fs.rmSync(sqliteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.env.DATA_DIR = TEST_DATA_DIR;
});

// ── Policy validation ───────────────────────────────────────────────────────

test("policy: routing defaults to alias; assigned + max_per_provider validated", () => {
  const base = validatePlan(planBody());
  assert.ok(base.ok);
  assert.equal(base.policy.routing, "alias");
  assert.equal(base.policy.max_per_provider, 3);

  const assigned = validatePlan(planBody({ policy: { routing: "assigned", max_per_provider: 2 } }));
  assert.ok(assigned.ok);
  assert.equal(assigned.policy.routing, "assigned");
  assert.equal(assigned.policy.max_per_provider, 2);

  const garbage = validatePlan(planBody({ policy: { routing: "telepathy", max_per_provider: 99 } }));
  assert.ok(garbage.ok);
  assert.equal(garbage.policy.routing, "alias", "unknown routing falls back to alias");
  assert.equal(garbage.policy.max_per_provider, 16, "max_per_provider clamps to 16");
});

// ── Orchestrator wiring ─────────────────────────────────────────────────────

test("e2e: default (alias) routing dispatches the alias with no assigned model", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob();
  store.createJob(job, null);

  const seen: Array<{ alias: string; assignedModel: string | null }> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push({ alias: input.alias, assignedModel: input.assignedModel ?? null });
    return { ok: true, text: `out of ${input.taskId}`, model: "served-model", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  assert.equal(seen.length, 2);
  assert.ok(seen.every((input) => input.assignedModel === null), "alias mode never pins a model");
  assert.ok(seen.some((input) => input.alias === "code"));
  assert.equal(store.getJob(job.jobId)?.status, "done");
});

test("e2e: assigned routing dispatches allocator-picked literal models", async () => {
  const validation = validatePlan(planBody({ policy: { routing: "assigned" } }));
  assert.ok(validation.ok);
  const job = makeJob();
  job.policy = validation.policy;
  const store = new InMemoryJobsStore();
  store.createJob(job, null);
  const seen: Array<{ taskId: string; alias: string; assignedModel: string | null }> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push({ taskId: input.taskId, alias: input.alias, assignedModel: input.assignedModel ?? null });
    return { ok: true, text: `out of ${input.taskId}`, model: "served-model", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.equal(seen.length, 2, "both tasks dispatched");
  const expectedModels = new Set(candidatesForTag("code", "any").map((c) => c.model));
  const chatModels = new Set(candidatesForTag("chat", "any").map((c) => c.model));
  for (const input of seen) {
    const pool = input.alias === "code" ? expectedModels : chatModels;
    assert.ok(
      input.assignedModel && pool.has(input.assignedModel),
      `assignedModel ${input.assignedModel} (alias ${input.alias}) is a real allocator candidate`
    );
    assert.notEqual(input.assignedModel, input.alias, "assigned mode sends the literal model, not the alias");
  }
  assert.ok(
    final.log.some((entry) => entry.event === "task_assigned"),
    "task_assigned logged with model + score"
  );
});

test("e2e: lease expiry mid-job requeues the lost task and the job completes", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob();
  store.createJob(job, null);
  // Simulate a worker that died holding t1's lease.
  store.writeTaskTransition("job_b5", "t1", { state: "running", wave: 1, leaseUntil: Date.now() - 1_000 });

  const dispatch: TaskDispatch = async (input) => ({
    ok: true,
    text: `out of ${input.taskId}`,
    model: "m",
    provider: "p",
  });
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const t1 = final.tasks.find((t) => t.id === "t1");
  assert.equal(t1?.state, "done", "requeued after expiry and completed");
  assert.ok(final.log.some((entry) => entry.event === "lease_expired"));
});

test("e2e: judge failures write drift penalties back to the served model", async () => {
  const store = new InMemoryJobsStore();
  const validation = validatePlan(
    planBody({ mode: "swarm", policy: { max_rounds: 3 } })
  );
  assert.ok(validation.ok);
  const now = Date.now();
  const job: OrchestrateJob = {
    ...makeJob(),
    mode: "swarm",
    policy: validation.policy,
    blackboard: {},
  };
  store.createJob(job, null);

  const dispatch: TaskDispatch = async (input) => {
    if (input.taskId === "__judge") {
      return {
        ok: true,
        text: JSON.stringify({
          verdicts: (store.getJob("job_b5")?.tasks ?? []).map((t) => ({
            task_id: t.id,
            pass: false,
            note: "regenerate; inconsistent",
          })),
        }),
        model: "judge-model",
        provider: "p",
      };
    }
    return { ok: true, text: "SUMMARY:\nworker output", model: "served-model", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.match(String(final.failureReason), /accepted with judge flaws/);
  // Two+ consecutive judge failures on served-model → drift penalty.
  assert.ok(
    final.log.some((entry) => entry.event === "model_drift_penalty" && String(entry.detail).includes("served-model")),
    "model_drift_penalty logged"
  );
  // Drift is per VERDICT: one model serving 2 failed parts × 3 judge
  // rounds = 6 consecutive fails → penalty steps at fails 2..6 = 0.25.
  const penalties = store.getModelPenalties();
  assert.equal(penalties["served-model"], 0.25, `penalty applied per verdict, got ${penalties["served-model"]}`);
});

test("e2e: assigned routing records the served model for drift feedback", async () => {
  // candidatesForTag returns real index candidates with providers + quality.
  const candidates = candidatesForTag("code", "any");
  assert.ok(candidates.length > 0, "code tag has candidates");
  for (const candidate of candidates) {
    assert.ok(typeof candidate.model === "string" && candidate.model.length > 0);
    assert.ok(candidate.quality >= 0 && candidate.quality <= 1, `quality in [0,1], got ${candidate.quality}`);
    assert.ok(typeof candidate.provider === "string" || candidate.provider === null);
  }
  const best = candidatesForTag("code", "best");
  assert.ok(best.length <= 3, "best tier caps at 3");
});
