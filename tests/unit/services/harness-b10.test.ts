/**
 * Harness B10 (OpenResearch adaptation) — objective orchestration for the
 * brain (Hermes): tag inference for tag-less tasks, the caller-model bias
 * guard, stream (per-completion) scheduling, task refill, and spawn lineage.
 * In-memory store + scripted dispatches, same shape as the B3 suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b10-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b10-test-secret";

const {
  validatePlan,
  objectiveToPlanBody,
  spawnToPlanBody,
  inferTaskTag,
  pickBiasAvoidModel,
  biasGuardActive,
  runJob,
  jobToApi,
  candidatesForTag,
  normalizeAppendTasks,
  taskRowsFromSpecs,
  InMemoryJobsStore,
} = await import("../../../open-sse/services/harness/orchestrator.ts");
import type {
  OrchestrateJob,
  OrchestrateTask,
  TaskDispatch,
} from "../../../open-sse/services/harness/orchestrator.ts";
import { assignModels, type AllocatorCandidate } from "../../../open-sse/services/harness/allocator.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

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
    jobId: "job_b10",
    goal: validation.goal,
    mode: validation.mode,
    policy: validation.policy,
    blackboard: validation.blackboard,
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    callerModel: null,
    parentJobId: null,
    judgeRounds: 0,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "job_b10",
      id: task.id,
      tag: task.tag,
      modality: task.modality,
      prompt: task.prompt,
      dependsOn: task.depends_on ?? [],
      state: "queued" as const,
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
  };
}

function jobFromTasks(
  tasks: Array<{ id: string; prompt: string; tag?: string; depends_on?: string[] }>,
  policyOverrides: Record<string, unknown> = {}
): OrchestrateJob {
  const validation = validatePlan({
    goal: "stream goal",
    mode: "parallel",
    tasks: tasks.map((task) => ({ id: task.id, tag: task.tag ?? "chat", prompt: task.prompt, depends_on: task.depends_on ?? [] })),
    policy: policyOverrides,
  });
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    ...makeJob(),
    jobId: "job_stream",
    goal: "stream goal",
    policy: validation.policy,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "job_stream",
      id: task.id,
      tag: task.tag,
      modality: task.modality,
      prompt: task.prompt,
      dependsOn: task.depends_on ?? [],
      state: "queued" as const,
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
  };
}

const okDispatch = (text = (id: string) => `out of ${id}`): TaskDispatch => async (input) => ({
  ok: true,
  text: text(input.taskId),
  model: "served-model",
  provider: "p",
});

// ── Tag inference ───────────────────────────────────────────────────────────

test("inferTaskTag: code / math / search / default-chat", () => {
  assert.equal(inferTaskTag("Refactor this typescript function and fix the bug in the regex").tag, "code");
  assert.equal(inferTaskTag("Prove the theorem: every eigenvalue of a symmetric matrix is real").tag, "math");
  assert.equal(inferTaskTag("What is the latest news on the stock price of ACME?").tag, "search");
  assert.equal(inferTaskTag("Hello there, friend!").tag, "chat");
  assert.ok(typeof inferTaskTag("write code").reason === "string" && inferTaskTag("write code").reason.length > 0);
});

test("validatePlan: tag-less tasks validate and carry inferred tags", () => {
  const validation = validatePlan(
    planBody({
      tasks: [
        { id: "t1", prompt: "Implement the JWT token issuer in typescript", depends_on: [] },
        { id: "t2", prompt: "Summarize the result for the user", depends_on: ["t1"] },
      ],
    })
  );
  assert.ok(validation.ok);
  if (!validation.ok) return;
  assert.equal(validation.tasks[0].tag, "code", "code prompt inferred as code");
  assert.equal(validation.tasks[1].tag, "chat");
  assert.equal(validation.inferredTags.length, 2);
  assert.equal(validation.inferredTags[0].id, "t1");
  assert.equal(validation.inferredTags[0].tag, "code");
  assert.ok(validation.inferredTags[0].reason.length > 0, "inference carries the classifier's reason");
});

test("validatePlan: explicit tags still win and are not re-inferred", () => {
  const validation = validatePlan(planBody()); // both tasks tagged
  assert.ok(validation.ok);
  if (!validation.ok) return;
  assert.equal(validation.inferredTags.length, 0);
  assert.equal(validation.tasks[0].tag, "code");
});

test("validatePlan: unknown tag is still an error (never silently re-inferred)", () => {
  const validation = validatePlan(planBody({ tasks: [{ id: "t1", tag: "telepathy", prompt: "x", depends_on: [] }] }));
  assert.ok(!validation.ok);
  if (validation.ok) return;
  assert.ok(validation.errors.some((error) => error.includes("unknown tag")));
});

// ── Objective-first entry ───────────────────────────────────────────────────

test("objectiveToPlanBody: bare objective becomes a single task", () => {
  const { plan, errors } = objectiveToPlanBody({ objective: "Build and verify a JWT auth module" });
  assert.deepEqual(errors, []);
  assert.ok(plan);
  if (!plan) return;
  assert.equal(plan.goal, "Build and verify a JWT auth module");
  const planTasks = plan.tasks ?? [];
  assert.equal(planTasks.length, 1);
  assert.equal(planTasks[0].id, "t1");
  assert.equal((planTasks[0] as { prompt: string }).prompt, "Build and verify a JWT auth module");
});

test("objectiveToPlanBody: subtasks with generated ids, optional tags, caller_model passthrough", () => {
  const { plan } = objectiveToPlanBody({
    objective: "Ship the auth module",
    subtasks: [
      { prompt: "Write the token issuer in python" },
      { prompt: "Review for SQL injection", tag: "code" },
    ],
    caller_model: "gpt-4o",
    policy: { scheduling: "stream" },
  });
  assert.ok(plan);
  if (!plan) return;
  const planTasks = plan.tasks ?? [];
  assert.equal(planTasks.length, 2);
  assert.equal(planTasks[0].id, "t1");
  assert.equal(planTasks[1].id, "t2");
  assert.equal((planTasks[1] as { tag?: string }).tag, "code");
  assert.equal((plan as { caller_model?: string }).caller_model, "gpt-4o");
  // The full body flows through validatePlan unchanged.
  const validation = validatePlan(plan);
  assert.ok(validation.ok);
  if (validation.ok) {
    assert.equal(validation.policy.scheduling, "stream");
    assert.equal(validation.callerModel, "gpt-4o");
    assert.equal(validation.inferredTags[0].tag, "code", "first subtask tag inferred");
  }
});

test("objectiveToPlanBody: shape errors", () => {
  assert.ok(objectiveToPlanBody({}).errors.some((e) => e.includes("objective")));
  assert.ok(objectiveToPlanBody({ objective: "x", subtasks: [] }).errors.some((e) => e.includes("subtasks")));
  assert.ok(
    objectiveToPlanBody({ objective: "x", subtasks: [{ prompt: "" }] }).errors.some((e) => e.includes("prompt"))
  );
});

// ── Bias guard ──────────────────────────────────────────────────────────────

test("biasGuardActive: only when the caller named its model and policy allows", () => {
  const job = makeJob();
  assert.equal(biasGuardActive(job), false, "no caller model — no guard");
  assert.equal(biasGuardActive({ ...job, callerModel: "some-model" }), true);
  assert.equal(biasGuardActive({ ...job, callerModel: "some-model", policy: { ...job.policy, bias_guard: false } }), false, "explicit opt-out");
});

test("pickBiasAvoidModel: strict tolerance avoids; default is lenient (near-ties only)", () => {
  candidatesForTag("code", "any"); // warm the tag index (first read can race lazy init)
  const codeCandidates = candidatesForTag("code", "any");
  assert.ok(codeCandidates.length >= 2, "test needs a code pool with alternatives");
  const callerModel = codeCandidates[0].model;
  // B11 strict mode (tolerance 0 = B10 behavior): always avoids when the
  // caller is viable.
  const avoided = pickBiasAvoidModel("code", "any", callerModel, 0);
  assert.ok(avoided !== null);
  assert.notEqual(avoided, callerModel);
  assert.ok(codeCandidates.some((c) => c.model === avoided), "avoid pick is from the same viability pool");
  // Default (lenient): a near-tie diversifies; clear superiority wins —
  // either a pool member ≠ caller, or null (caller keeps the task).
  const lenient = pickBiasAvoidModel("code", "any", callerModel);
  assert.ok(
    lenient === null || (lenient !== callerModel && codeCandidates.some((c) => c.model === lenient)),
    "lenient pick is a pool member or null"
  );
  // A model the tag never routes to → nothing to avoid.
  assert.equal(pickBiasAvoidModel("code", "any", "definitely-not-a-real-model-xyz"), null);
});

test("allocator: avoidModel is a penalty, not a ban", () => {
  const candidates: AllocatorCandidate[] = [
    { model: "caller-model", provider: "a", quality: 0.95 },
    { model: "other-model", provider: "b", quality: 0.9 },
  ];
  const { assignments } = assignModels([{ id: "t1", tag: "code" }], () => candidates, {
    maxPerProvider: 3,
    avoidModel: "caller-model",
  });
  assert.equal(assignments.get("t1")?.candidate.model, "other-model", "viable alternative wins despite lower quality");

  const solo: AllocatorCandidate[] = [{ model: "caller-model", provider: "a", quality: 0.95 }];
  const soloResult = assignModels([{ id: "t1", tag: "code" }], () => solo, {
    maxPerProvider: 3,
    avoidModel: "caller-model",
  });
  assert.equal(soloResult.assignments.get("t1")?.candidate.model, "caller-model", "no alternative → still assigned (flagged, never deadlocked)");
});

test("e2e: alias routing + caller_model avoids the caller's model", async () => {
  const codeCandidates = candidatesForTag("code", "any");
  const callerModel = codeCandidates[0].model;
  const store = new InMemoryJobsStore();
  const job = jobFromTasks([{ id: "t1", prompt: "write fib in python" }], { routing: "alias", bias_tolerance: 0 });
  job.jobId = "job_bias";
  for (const task of job.tasks) task.jobId = "job_bias";
  job.callerModel = callerModel;
  store.createJob(job, null);

  const seen: Array<string | null | undefined> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push(input.assignedModel);
    return { ok: true, text: "ok", model: input.assignedModel ?? "served", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  assert.equal(seen.length, 1);
  assert.ok(seen[0] !== null && seen[0] !== undefined);
  assert.notEqual(seen[0], callerModel, "dispatch pinned a non-caller model");
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.ok(final.log.some((entry) => entry.event === "bias_avoided"), "bias_avoided is logged");
  const api = jobToApi(final) as { tasks: Array<{ bias_same_model: boolean }> };
  assert.equal(api.tasks[0].bias_same_model, false);
});

test("e2e: assigned routing passes the caller model to the allocator (avoided)", async () => {
  const codeCandidates = candidatesForTag("code", "any");
  const callerModel = codeCandidates[0].model;
  const store = new InMemoryJobsStore();
  const job = jobFromTasks([{ id: "t1", prompt: "write fib in rust" }], { routing: "assigned", bias_tolerance: 0 });
  job.jobId = "job_bias2";
  for (const task of job.tasks) task.jobId = "job_bias2";
  job.callerModel = callerModel;
  store.createJob(job, null);

  const seen: Array<string | null | undefined> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push(input.assignedModel);
    return { ok: true, text: "ok", model: input.assignedModel ?? "served", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], callerModel, "allocator avoided the caller model when a viable alternative exists");
});

test("e2e: no caller model → dispatch is exactly the alias (B3–B9 behavior)", async () => {
  const store = new InMemoryJobsStore();
  const job = jobFromTasks([{ id: "t1", prompt: "write fib in go" }]);
  store.createJob(job, null);
  const seen: Array<string | null | undefined> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push(input.assignedModel);
    return { ok: true, text: "ok", model: "served", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  assert.deepEqual(seen, [null], "no bias guard without a named caller");
});

// ── Stream scheduling (per-completion admission) ────────────────────────────

test("e2e: stream scheduling refills the freed slot WITHOUT waiting for the wave", async () => {
  const store = new InMemoryJobsStore();
  const job = jobFromTasks(
    [
      { id: "t1", prompt: "fast task" },
      { id: "t2", prompt: "slow task" },
      { id: "t3", prompt: "third task" },
    ],
    { scheduling: "stream", max_concurrency: 2 }
  );
  store.createJob(job, null);

  const events: Array<{ taskId: string; phase: "start" | "end"; at: number }> = [];
  const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const dispatch: TaskDispatch = async (input) => {
    events.push({ taskId: input.taskId, phase: "start", at: Date.now() });
    await realSleep(input.taskId === "t2" ? 160 : 20);
    events.push({ taskId: input.taskId, phase: "end", at: Date.now() });
    return { ok: true, text: `out of ${input.taskId}`, model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.ok(final.tasks.every((task) => task.state === "done"), "all three tasks completed");

  const t1end = events.find((e) => e.taskId === "t1" && e.phase === "end")!.at;
  const t2end = events.find((e) => e.taskId === "t2" && e.phase === "end")!.at;
  const t3start = events.find((e) => e.taskId === "t3" && e.phase === "start")!.at;
  // THE assertion: t3 started after t1 freed a slot but BEFORE t2 finished —
  // a wave barrier would hold t3 until t2end.
  assert.ok(t3start >= t1end, `t3 started after t1 ended (${t3start} >= ${t1end})`);
  assert.ok(t3start < t2end, `t3 started before t2 ended (${t3start} < ${t2end}) — no barrier`);
  // Distinct dispatch ordinals surfaced as task.wave.
  const waves = new Set(final.tasks.map((task) => task.wave));
  assert.equal(waves.size, 3, "stream ordinals are per-task, distinct");
  assert.ok(final.log.some((entry) => entry.event === "stream_admit"), "admissions logged");
});

test("e2e: wave scheduling still barriers (the default, unchanged)", async () => {
  const store = new InMemoryJobsStore();
  const job = jobFromTasks(
    [
      { id: "t1", prompt: "fast task" },
      { id: "t2", prompt: "slow task" },
      { id: "t3", prompt: "third task" },
    ],
    { max_concurrency: 2 } // scheduling unset → wave (default)
  );
  store.createJob(job, null);

  const events: Array<{ taskId: string; phase: "start" | "end"; at: number }> = [];
  const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const dispatch: TaskDispatch = async (input) => {
    events.push({ taskId: input.taskId, phase: "start", at: Date.now() });
    await realSleep(input.taskId === "t2" ? 160 : 20);
    events.push({ taskId: input.taskId, phase: "end", at: Date.now() });
    return { ok: true, text: "ok", model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const t2end = events.find((e) => e.taskId === "t2" && e.phase === "end")!.at;
  const t3start = events.find((e) => e.taskId === "t3" && e.phase === "start")!.at;
  assert.ok(t3start >= t2end, `t3 waits for the wave barrier (${t3start} >= ${t2end})`);
});

test("e2e: stream mode requeues failures and retries", async () => {
  const store = new InMemoryJobsStore();
  const job = jobFromTasks([{ id: "t1", prompt: "flaky task" }], { scheduling: "stream", max_attempts: 3 });
  store.createJob(job, null);

  let calls = 0;
  const dispatch: TaskDispatch = async (input) => {
    calls += 1;
    if (calls === 1) return { ok: false, error: "transient" };
    return { ok: true, text: "second try", model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.equal(final.tasks[0].state, "done");
  assert.equal(final.tasks[0].attempts, 1, "first attempt failed, second succeeded");
});

test("e2e: stream mode enforces the deadline", async () => {
  const store = new InMemoryJobsStore();
  const job = jobFromTasks([{ id: "t1", prompt: "never runs" }], { scheduling: "stream" });
  job.deadlineAt = Date.now() - 1; // already past
  store.createJob(job, null);
  await runJob(job.jobId, { store, dispatch: okDispatch(), sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "failed");
  assert.equal(final.failureReason, "deadline");
});

test("e2e: stream mode aborts unstarted tasks on budget exhaustion", async () => {
  const store = new InMemoryJobsStore();
  const job = jobFromTasks(
    [
      { id: "t1", prompt: "costly" },
      { id: "t2", prompt: "costly too" },
    ],
    { scheduling: "stream", max_concurrency: 1, max_total_tokens: 50 }
  );
  store.createJob(job, null);
  const dispatch: TaskDispatch = async () => ({
    ok: true,
    text: "ok",
    model: "m",
    provider: "p",
    usage: { prompt_tokens: 30, completion_tokens: 30 }, // 60 > 50 budget after ONE task
  });
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "failed");
  assert.equal(final.failureReason, "budget_exhausted");
  assert.equal(final.tasks[0].state, "done", "in-flight task finished");
  assert.equal(final.tasks[1].state, "failed", "unstarted task aborted");
  assert.ok(final.tasks[1].lastError?.includes("budget exhausted"));
});

test("e2e: stream swarm mode merges the blackboard per completion", async () => {
  const store = new InMemoryJobsStore();
  const validation = validatePlan({
    goal: "swarm goal",
    mode: "swarm",
    tasks: [
      { id: "t1", prompt: "first part", tag: "chat", depends_on: [] },
      { id: "t2", prompt: "second part", tag: "chat", depends_on: [] },
    ],
    policy: { scheduling: "stream" },
  });
  assert.ok(validation.ok);
  const now = Date.now();
  const job: OrchestrateJob = {
    jobId: "job_sswarm",
    goal: "swarm goal",
    mode: "swarm",
    policy: validation.ok ? validation.policy : makeJob().policy,
    blackboard: {},
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    callerModel: null,
    parentJobId: null,
    judgeRounds: 0,
    createdAt: now,
    deadlineAt: now + 600_000,
    tasks: (validation.ok ? validation.tasks : []).map((task) => ({
      jobId: "job_sswarm",
      id: task.id,
      tag: task.tag,
      modality: task.modality,
      prompt: task.prompt,
      dependsOn: [],
      state: "queued" as const,
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
  };
  store.createJob(job, null);

  const dispatch: TaskDispatch = async (input) => ({
    ok: true,
    text: `SUMMARY:${input.taskId} did the work`,
    model: "m",
    provider: "p",
  });
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.equal(final.log.filter((entry) => entry.event === "blackboard_append").length, 2, "one append per completion");
});

// ── Refill (append tasks to a live job) ─────────────────────────────────────

test("appendTasks (in-memory): active job appends; terminal rejects; dup ids reject", () => {
  const store = new InMemoryJobsStore();
  const job = makeJob();
  store.createJob(job, null);

  const rows = taskRowsFromSpecs([{ id: "t3", tag: "code", prompt: "follow-up", depends_on: ["t1"] }], job.jobId);
  const appended = store.appendTasks(job.jobId, rows);
  assert.ok(appended && appended !== "job_terminal" && appended !== "duplicate_id");
  assert.equal(appended.tasks.length, 3);

  assert.equal(store.appendTasks(job.jobId, rows), "duplicate_id");

  store.setJobStatus(job.jobId, "done", null);
  assert.equal(store.appendTasks(job.jobId, rows), "job_terminal");

  assert.equal(store.appendTasks("job_missing", rows), null);
});

test("normalizeAppendTasks: inference, live-job deps, generated ids, validation", () => {
  const job = makeJob(); // has t1 (code), t2 (chat, depends t1)
  const good = normalizeAppendTasks(
    { tasks: [{ prompt: "write the python integration test", depends_on: ["t1"] }, { id: "custom", prompt: "explicit id" }] },
    job
  );
  assert.ok(good.ok);
  if (!good.ok) return;
  assert.equal(good.specs.length, 2);
  assert.equal(good.specs[0].tag, "code", "appended task tag inferred");
  assert.deepEqual(good.specs[0].depends_on, ["t1"], "deps against existing job tasks are legal");
  assert.equal(good.specs[1].id, "custom");
  assert.equal(good.inferred.length, 2, "both appends were inferred (no tags given)");

  const bad = normalizeAppendTasks({ tasks: [{ prompt: "x", depends_on: ["nope"] }] }, job);
  assert.ok(!bad.ok);
  if (bad.ok) return;
  assert.ok(bad.errors.some((e) => e.includes("unknown task \"nope\"")));

  const dup = normalizeAppendTasks({ tasks: [{ id: "t1", prompt: "x" }] }, job);
  assert.ok(!dup.ok);

  const empty = normalizeAppendTasks({}, job);
  assert.ok(!empty.ok);
});

test("taskRowsFromSpecs: queued rows, modality from tag when omitted", () => {
  const rows = taskRowsFromSpecs([{ id: "a", tag: "code", prompt: "p" }, { id: "b", tag: "image_gen", prompt: "p", modality: "image" }], "job_x");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "queued");
  assert.equal(rows[0].modality, "text");
  assert.equal(rows[1].modality, "image");
  assert.equal(rows[0].jobId, "job_x");
});

// ── Spawn lineage ───────────────────────────────────────────────────────────

test("spawnToPlanBody: self-contained brief, caller_model inheritance, context verbatim", () => {
  const parent = makeJob();
  parent.callerModel = "hermes-model";

  const { plan } = spawnToPlanBody(
    { brief: "Survey the auth codebase and report the token flow. Read-only. Output: 10 lines." },
    parent
  );
  assert.ok(plan);
  if (!plan) return;
  assert.equal((plan.goal ?? "").startsWith("helper:"), true);
  assert.equal((plan.tasks ?? []).length, 1);
  assert.equal((plan as { caller_model?: string }).caller_model, "hermes-model", "bias guard propagates to the helper");

  const withContext = spawnToPlanBody(
    { brief: "b", title: "T", context: { api_spec: "typed" }, caller_model: "override-model" },
    parent
  );
  assert.ok(withContext.plan);
  if (!withContext.plan) return;
  assert.equal(withContext.plan.goal ?? "", "T");
  assert.deepEqual(withContext.plan.blackboard, { api_spec: "typed" }, "context copied verbatim, never derived");
  assert.equal((withContext.plan as { caller_model?: string }).caller_model, "override-model");

  const noParentModel = makeJob();
  const inherited = spawnToPlanBody({ brief: "b" }, noParentModel);
  assert.ok(inherited.plan);
  assert.equal((inherited.plan as { caller_model?: string }).caller_model, undefined, "parent without caller_model → child unnamed too");

  assert.ok(!spawnToPlanBody({} as { brief?: string }, parent).plan, "brief is required");
});

test("listChildJobs (in-memory): lineage ordering and filtering", () => {
  const store = new InMemoryJobsStore();
  const parent = makeJob();
  parent.jobId = "job_parent";
  for (const task of parent.tasks) task.jobId = "job_parent";
  store.createJob(parent, null);

  const childA = makeJob();
  childA.jobId = "job_childA";
  childA.parentJobId = "job_parent";
  childA.goal = "first helper";
  childA.createdAt = Date.now();
  for (const task of childA.tasks) task.jobId = "job_childA";
  store.createJob(childA, null);

  const childB = makeJob();
  childB.jobId = "job_childB";
  childB.parentJobId = "job_parent";
  childB.goal = "second helper";
  childB.createdAt = Date.now() + 5;
  for (const task of childB.tasks) task.jobId = "job_childB";
  store.createJob(childB, null);

  const unrelated = makeJob();
  unrelated.jobId = "job_other";
  for (const task of unrelated.tasks) task.jobId = "job_other";
  store.createJob(unrelated, null);

  const children = store.listChildJobs("job_parent");
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((child) => child.jobId), ["job_childA", "job_childB"], "oldest first");
});

// ── jobToApi surface ────────────────────────────────────────────────────────

test("jobToApi: caller_model, parent_job_id, bias_same_model flags", () => {
  const job = makeJob();
  job.callerModel = "hermes-model";
  job.parentJobId = "job_parent";
  job.tasks[0].assignedModel = "hermes-model";
  job.tasks[1].assignedModel = "other-model";
  const api = jobToApi(job) as {
    caller_model: string | null;
    parent_job_id: string | null;
    tasks: Array<{ bias_same_model: boolean; model: string | null }>;
  };
  assert.equal(api.caller_model, "hermes-model");
  assert.equal(api.parent_job_id, "job_parent");
  assert.equal(api.tasks[0].bias_same_model, true, "task on the caller's model is flagged");
  assert.equal(api.tasks[1].bias_same_model, false);

  const plain = jobToApi(makeJob()) as { caller_model: string | null };
  assert.equal(plain.caller_model, null, "unnamed callers see the pre-B10 shape");
});
