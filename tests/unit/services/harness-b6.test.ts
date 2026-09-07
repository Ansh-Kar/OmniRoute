/**
 * Harness B6 (cross-cutting: cost budgets) — tests for:
 *
 *   1. Per-task token usage accounting: the dispatch outcome's usage lands
 *      on the task row (both stores) and aggregates into jobToApi.usage.
 *   2. `policy.max_total_tokens` — the abort-unstarted-on-breach contract:
 *      once the budget is hit, unstarted tasks fail with a budget reason,
 *      deferred tasks are swept, and the job ends failed(budget_exhausted)
 *      with partial results visible.
 *   3. Policy validation: default 0 (unlimited), clamps.
 *   4. parseUsage discipline (dispatch.ts): OpenAI-style usage objects only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b6-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b6-test-secret";

const { validatePlan, runJob, jobToApi, InMemoryJobsStore } = await import(
  "../../../open-sse/services/harness/orchestrator.ts"
);
import type { OrchestrateJob, TaskDispatch } from "../../../open-sse/services/harness/orchestrator.ts";

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    goal: "test goal",
    mode: "parallel",
    tasks: [
      { id: "t1", tag: "chat", prompt: "one", depends_on: [] },
      { id: "t2", tag: "chat", prompt: "two", depends_on: [] },
      { id: "t3", tag: "chat", prompt: "three", depends_on: [] },
    ],
    ...overrides,
  };
}

function makeJob(policy: Record<string, unknown> = {}): OrchestrateJob {
  const validation = validatePlan(planBody({ policy }));
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    jobId: "job_b6",
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
      jobId: "job_b6",
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
  } as OrchestrateJob;
}

const USAGE = { prompt_tokens: 100, completion_tokens: 60 }; // 160 per task

function usageDispatch(): TaskDispatch {
  return async (input) => ({
    ok: true,
    text: `out of ${input.taskId}`,
    model: "m",
    provider: "p",
    usage: { ...USAGE },
  });
}

// ── Policy validation ───────────────────────────────────────────────────────

test("policy: max_total_tokens defaults to 0 (unlimited) and clamps", () => {
  const base = validatePlan(planBody());
  assert.ok(base.ok);
  assert.equal(base.policy.max_total_tokens, 0);

  const set = validatePlan(planBody({ policy: { max_total_tokens: 5_000 } }));
  assert.ok(set.ok);
  assert.equal(set.policy.max_total_tokens, 5_000);

  const negative = validatePlan(planBody({ policy: { max_total_tokens: -5 } }));
  assert.ok(negative.ok);
  assert.equal(negative.policy.max_total_tokens, 0);

  const huge = validatePlan(planBody({ policy: { max_total_tokens: 9_999_999_999 } }));
  assert.ok(huge.ok);
  assert.equal(huge.policy.max_total_tokens, 1_000_000_000);
});

// ── Usage accounting ────────────────────────────────────────────────────────

test("e2e: task usage lands on rows and aggregates into jobToApi.usage", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob();
  store.createJob(job, null);
  await runJob(job.jobId, { store, dispatch: usageDispatch(), sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  for (const task of final.tasks) {
    assert.equal(task.promptTokens, USAGE.prompt_tokens);
    assert.equal(task.completionTokens, USAGE.completion_tokens);
  }
  const api = jobToApi(final) as { usage: Record<string, number | null> };
  assert.deepEqual(api.usage, {
    prompt_tokens: 3 * USAGE.prompt_tokens,
    completion_tokens: 3 * USAGE.completion_tokens,
    total_tokens: 3 * 160,
    budget_tokens: null, // no budget set
  });
  const tasks = api.tasks as Array<{ prompt_tokens: number | null; completion_tokens: number | null }>;
  assert.ok(tasks.every((t) => t.prompt_tokens === USAGE.prompt_tokens));
});

test("store(sqlite): usage columns round-trip (parity)", async () => {
  const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-b6-sqlite-"));
  process.env.DATA_DIR = sqliteDir;
  const core = await import("../../../src/lib/db/core.ts");
  core.resetDbInstance();
  const { SqliteJobsStore } = await import("../../../src/lib/db/orchestrateJobs.ts");
  const store = new SqliteJobsStore();
  store.createJob(makeJob(), null);
  store.writeTaskTransition("job_b6", "t1", {
    state: "done",
    assignedModel: "m1",
    promptTokens: 123,
    completionTokens: 45,
  });
  const task = store.getJob("job_b6")?.tasks.find((t) => t.id === "t1");
  assert.equal(task?.promptTokens, 123);
  assert.equal(task?.completionTokens, 45);
  const api = jobToApi(store.getJob("job_b6") as OrchestrateJob) as {
    usage: Record<string, number | null>;
  };
  assert.equal(api.usage.total_tokens, 168);
  core.resetDbInstance();
  fs.rmSync(sqliteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.env.DATA_DIR = TEST_DATA_DIR;
});

// ── Budget breach ───────────────────────────────────────────────────────────

test("e2e: budget breach aborts unstarted + deferred tasks, job fails budget_exhausted", async () => {
  const store = new InMemoryJobsStore();
  // max_concurrency 1 → t1 runs alone, its 160 tokens exhaust the 150
  // budget; t2 aborts in-wave and t3 (deferred) is swept.
  const job = makeJob({ max_concurrency: 1, max_total_tokens: 150 });
  store.createJob(job, null);
  await runJob(job.jobId, { store, dispatch: usageDispatch(), sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "failed");
  assert.equal(final.failureReason, "budget_exhausted");

  const t1 = final.tasks.find((t) => t.id === "t1");
  const t2 = final.tasks.find((t) => t.id === "t2");
  const t3 = final.tasks.find((t) => t.id === "t3");
  assert.equal(t1?.state, "done", "in-flight task completed and stays visible");
  assert.equal(t1?.promptTokens, 100);
  assert.equal(t2?.state, "failed");
  assert.match(String(t2?.lastError), /budget exhausted/);
  assert.equal(t3?.state, "failed", "deferred task swept, not left queued");
  assert.match(String(t3?.lastError), /budget exhausted/);

  assert.ok(final.log.some((entry) => entry.event === "task_budget_aborted"));
  assert.ok(final.log.some((entry) => entry.event === "job_budget_exhausted"));

  const api = jobToApi(final) as { usage: Record<string, number | null> };
  assert.equal(api.usage.total_tokens, 160, "only the dispatched task's usage counted");
  assert.equal(api.usage.budget_tokens, 150);
});

test("e2e: no budget (default) never aborts despite usage", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob(); // max_total_tokens 0 = unlimited
  store.createJob(job, null);
  await runJob(job.jobId, { store, dispatch: usageDispatch(), sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.ok(final.tasks.every((t) => t.state === "done"));
});

test("e2e: budget large enough — all tasks complete", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob({ max_total_tokens: 1_000 }); // 3 × 160 = 480 < 1000
  store.createJob(job, null);
  await runJob(job.jobId, { store, dispatch: usageDispatch(), sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const api = jobToApi(final) as { usage: Record<string, number | null> };
  assert.equal(api.usage.total_tokens, 480);
  assert.equal(api.usage.budget_tokens, 1_000);
});

test("e2e: usage-less dispatches never trip the budget", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob({ max_total_tokens: 1 }); // would trip on any usage
  store.createJob(job, null);
  const noUsage: TaskDispatch = async (input) => ({
    ok: true,
    text: `out of ${input.taskId}`,
    model: "m",
    provider: "p",
    usage: null,
  });
  await runJob(job.jobId, { store, dispatch: noUsage, sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done", "unreported usage is not fabricated");
  assert.ok(final.tasks.every((t) => t.promptTokens === null));
});
