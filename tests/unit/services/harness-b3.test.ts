/**
 * Harness B3 (Guide 1 Parts 3+5+6) — orchestrator core: plan admission,
 * planner waves, task state machine, and the wave runner end-to-end with an
 * in-memory store + scripted dispatches (no HTTP, no SQLite — the SQL store
 * is a thin mapping over the same interface).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b3-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b3-test-secret";

const {
  validatePlan,
  nextWave,
  buildTaskMessages,
  runJob,
  jobToApi,
  aliasForTag,
  InMemoryJobsStore,
  UPSTREAM_TRUNCATE,
} = await import("../../../open-sse/services/harness/orchestrator.ts");
import type {
  OrchestrateJob,
  OrchestrateTask,
  TaskDispatch,
} from "../../../open-sse/services/harness/orchestrator.ts";

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    goal: "test goal",
    mode: "parallel",
    tasks: [
      { id: "t1", tag: "code", prompt: "write fib", depends_on: [] },
      { id: "t2", tag: "chat", prompt: "summarize", depends_on: ["t1"] },
    ],
    ...overrides,
  };
}

function makeJob(overrides: Partial<OrchestrateJob> = {}): OrchestrateJob {
  const validation = validatePlan(planBody());
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    jobId: "job_test",
    goal: validation.goal,
    mode: validation.mode,
    policy: validation.policy,
    blackboard: null,
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "job_test",
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
    })),
    log: [],
    ...overrides,
  };
}

const okDispatch: TaskDispatch = async ({ alias }) => ({
  ok: true,
  text: `done via ${alias}`,
  model: "openai/gpt-5.6",
  provider: "openai",
});

// ── Admission validation ────────────────────────────────────────────────────

test("plan: valid plan normalizes tags, defaults policy", () => {
  const result = validatePlan(planBody());
  assert.ok(result.ok);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.mode, "parallel");
  assert.equal(result.policy.max_attempts, 3);
  assert.equal(result.policy.max_concurrency, 8);
  assert.equal(result.policy.deadline_s, 600);
  assert.equal(result.policy.budget, "any");
});

test("plan: admission errors are per-task and specific", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...planBody(), tasks: [] }, "non-empty"],
    [{ ...planBody(), tasks: [{ id: "t1", tag: "spreadsheets", prompt: "x" }] }, "unknown tag"],
    [{ ...planBody(), tasks: [{ id: "t1", tag: "code", prompt: "x" }, { id: "t1", tag: "code", prompt: "y" }] }, "duplicate task id"],
    [{ ...planBody(), tasks: [{ id: "t1", tag: "code", prompt: "x", depends_on: ["ghost"] }] }, "unknown task \"ghost\""],
    [{ ...planBody(), tasks: [{ id: "t1", tag: "code", prompt: "x", depends_on: ["t2"] }, { id: "t2", tag: "code", prompt: "y", depends_on: ["t1"] }] }, "cycle"],
    [{ ...planBody(), mode: "swarm" }, "swarm"],
    [{ ...planBody(), goal: " " }, "goal"],
  ];
  for (const [body, needle] of cases) {
    const result = validatePlan(body);
    assert.ok(!result.ok, JSON.stringify(body));
    assert.ok(
      result.errors.some((e) => e.toLowerCase().includes(needle.toLowerCase().split(" ")[0])),
      `expected an error mentioning "${needle}", got: ${JSON.stringify(result.errors)}`
    );
  }
});

test("plan: policy values are clamped to sane ranges", () => {
  const result = validatePlan(
    planBody({ policy: { max_attempts: 99, max_concurrency: 0, deadline_s: -5, budget: "deluxe" } })
  );
  assert.ok(result.ok);
  assert.equal(result.policy.max_attempts, 5);
  assert.equal(result.policy.max_concurrency, 1);
  assert.equal(result.policy.deadline_s, 1);
  assert.equal(result.policy.budget, "any");
});

// ── Planner ─────────────────────────────────────────────────────────────────

test("planner: readiness, waiting, and blocked-by-failure", () => {
  const job = makeJob();
  // t1 ready immediately; t2 waits on t1.
  let wave = nextWave(job.tasks);
  assert.deepEqual(wave.ready, ["t1"]);
  assert.deepEqual(wave.blocked, [{ id: "t2", reason: "waiting on: t1" }]);

  // t1 done → t2 ready.
  const t1 = job.tasks.find((t) => t.id === "t1") as OrchestrateTask;
  t1.state = "done";
  wave = nextWave(job.tasks);
  assert.deepEqual(wave.ready, ["t2"]);
  assert.deepEqual(wave.blocked, []);

  // t1 failed instead → t2 is blocked with the failure surfaced.
  t1.state = "failed";
  wave = nextWave(job.tasks);
  assert.deepEqual(wave.ready, []);
  assert.deepEqual(wave.blocked, [{ id: "t2", reason: "upstream failed: t1" }]);
});

test("planner: upstream outputs are injected, truncated to 800 chars", () => {
  const job = makeJob();
  const t1 = job.tasks.find((t) => t.id === "t1") as OrchestrateTask;
  t1.state = "done";
  t1.result = "x".repeat(UPSTREAM_TRUNCATE + 500);
  const t2 = job.tasks.find((t) => t.id === "t2") as OrchestrateTask;
  const byId = new Map(job.tasks.map((t) => [t.id, t]));
  const messages = buildTaskMessages(t2, byId);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /^Upstream outputs:\n\[t1\]: x{800}…/);
  assert.match(messages[0].content, /summarize$/);
  // No deps → plain prompt.
  assert.deepEqual(buildTaskMessages(t1, byId), [{ role: "user", content: "write fib" }]);
});

// ── Runner (in-memory store, scripted dispatch) ─────────────────────────────

test("runner: two-wave plan, upstream output reaches the dependent", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob();
  store.createJob(job, null);
  const seen: string[] = [];
  const dispatch: TaskDispatch = async ({ alias, messages }) => {
    seen.push(`${alias}:${String(messages[0].content).slice(0, 80)}`);
    return { ok: true, text: `output of ${alias}`, model: "openai/gpt-5.6", provider: "openai" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.equal(final.failureReason, null);
  assert.equal(final.tasks.find((t) => t.id === "t1")?.wave, 1);
  assert.equal(final.tasks.find((t) => t.id === "t2")?.wave, 2);
  // t2's dispatch carried t1's output (upstream injection).
  assert.ok(seen[1].startsWith("chat:Upstream outputs:") && seen[1].includes("output of"), `t2 saw upstream output: ${seen[1]}`);
  // Every transition is in the audit log.
  const events = final.log.map((l) => l.event);
  assert.ok(events.includes("job_created"));
  assert.ok(events.includes("wave_start"));
  assert.ok(events.includes("task_done"));
});

test("runner: transient failure requeues, then succeeds", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob({ tasks: makeJob().tasks.filter((t) => t.id === "t1") });
  store.createJob(job, null);
  let calls = 0;
  const dispatch: TaskDispatch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, error: "provider hiccup" };
    return { ok: true, text: "recovered", model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const t1 = final.tasks[0];
  assert.equal(t1.state, "done");
  assert.equal(t1.attempts, 2);
  assert.ok(final.log.some((l) => l.event === "task_requeued"));
});

test("runner: attempts exhausted → task failed, blocked dependent → job failed", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob();
  store.createJob(job, null);
  const dispatch: TaskDispatch = async () => ({ ok: false, error: "always down" });
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  // t1 exhausted its attempts; t2 is blocked by the failure → job failed.
  const t1 = final.tasks.find((t) => t.id === "t1");
  const t2 = final.tasks.find((t) => t.id === "t2");
  assert.equal(t1?.state, "failed");
  assert.equal(t1?.attempts, 3);
  assert.equal(t2?.state, "queued", "blocked dependent stays queued — never guessed around");
  assert.equal(final.status, "failed");
  assert.equal(final.failureReason, "blocked");
  assert.ok(final.log.some((l) => l.event === "task_failed" && /attempts exhausted/.test(l.detail ?? "")));
});

test("runner: deadline exceeded → partial results, queued tasks untouched", async () => {
  const store = new InMemoryJobsStore();
  const validation = validatePlan(planBody());
  assert.ok(validation.ok);
  const base = makeJob();
  // Tight deadline: exceeded while wave 1 is still running.
  const job: OrchestrateJob = {
    ...base,
    deadlineAt: base.createdAt + validation.policy.deadline_s * 1000,
  };
  store.createJob(job, null);
  let clock = base.createdAt;
  const dispatch: TaskDispatch = async () => {
    clock += validation.policy.deadline_s * 1000 + 1; // time passes during the task
    return { ok: true, text: "made it", model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, now: () => clock, sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "failed");
  assert.equal(final.failureReason, "deadline");
  // t1 completed inside the deadline; t2 never ran and stays queued.
  assert.equal(final.tasks.find((t) => t.id === "t1")?.state, "done");
  assert.equal(final.tasks.find((t) => t.id === "t2")?.state, "queued");
  assert.ok(final.log.some((l) => l.event === "job_deadline"));
});

test("runner: idempotency conflict is the store's job", () => {
  const store = new InMemoryJobsStore();
  const job = makeJob({ idempotencyKey: "key-1" });
  const first = store.createJob(job, "key-1");
  assert.ok(first !== "conflict");
  const second = store.createJob(makeJob({ idempotencyKey: "key-1", jobId: "job_other" }), "key-1");
  assert.equal(second, "conflict");
  assert.ok(store.findByIdempotencyKey("key-1"));
  assert.equal(store.findByIdempotencyKey("key-1")?.jobId, "job_test");
});

test("runner: alias mapping respects the job budget and image_gen", () => {
  assert.equal(aliasForTag("code", "any"), "code");
  assert.equal(aliasForTag("code", "best"), "code:best");
  assert.equal(aliasForTag("plan", "cheap"), "plan:cheap");
  assert.equal(aliasForTag("image_gen", "any"), "chat", "image tasks route via chat in B3");
});

test("runner: jobToApi exposes waves, tasks, and the log tail", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob();
  store.createJob(job, null);
  await runJob(job.jobId, { store, dispatch: okDispatch, sleep: async () => {} });
  const api = jobToApi(store.getJob(job.jobId) as OrchestrateJob);
  assert.equal(api.status, "done");
  assert.deepEqual(api.waves, [{ n: 1, tasks: ["t1"] }, { n: 2, tasks: ["t2"] }]);
  const tasks = api.tasks as Array<Record<string, unknown>>;
  assert.equal(tasks[0].model, "openai/gpt-5.6");
  assert.equal(tasks[0].state, "done");
  assert.ok(Array.isArray(api.log));
});
