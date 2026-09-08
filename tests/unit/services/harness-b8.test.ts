/**
 * Harness B8 (cross-cutting hardening) — tests for:
 *
 *   1. Guide 2 quick retry: policy.retry_503_after_ms retries ONCE after
 *      the wait when the tag's candidates exhaust; second failure is the
 *      honest 503; other errors pass through; validation.
 *   2. Swarm context compression (policy.compress_context): Caveman/lite
 *      over the worker's shared context, code preserved, log event; off
 *      by default.
 *   3. Liveness canaries: 2-consecutive-failure dead marking, recovery,
 *      freshness gate, and the findModelsByTags skip.
 *   4. Benchmark wiring: DB-backed taskFitness (user override) flows into
 *      the tag index via the scoreLookup hook (coder/reasoning only).
 *   5. model "auto" (Guide 2 Part 2): the classifier decision the direct
 *      chat path now applies — vision body → vision alias, code → code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b8-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b8-test-secret";

const { orchestrateQuick } = await import("../../../open-sse/services/harness/quick.ts");
const { validatePlan, runJob, InMemoryJobsStore } = await import(
  "../../../open-sse/services/harness/orchestrator.ts"
);
import type { OrchestrateJob, TaskDispatch } from "../../../open-sse/services/harness/orchestrator.ts";
const { classifyRequest } = await import("../../../open-sse/services/harness/classifier.ts");
const { setUserFitnessOverride, clearUserFitnessOverride } = await import(
  "../../../open-sse/services/autoCombo/taskFitness.ts"
);

type Dispatch = (body: Record<string, unknown>) => Promise<{
  status: number;
  headers: Record<string, string>;
  json: unknown;
}>;

function chatDispatch(statuses: number[]): Dispatch {
  let call = 0;
  return async () => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    return {
      status,
      headers: status === 200 ? { "x-omniroute-model": "openai/gpt-5.6", "x-omniroute-provider": "openai" } : {},
      json: status === 200 ? { choices: [{ message: { content: "the answer" } }] } : { error: { message: "no candidates" } },
    };
  };
}

// ── Guide 2: quick 503 → retry once ────────────────────────────────────────

test("quick: retry_503_after_ms retries once after the wait, then succeeds", async () => {
  const sleeps: number[] = [];
  const result = await orchestrateQuick(
    { tag: "code", prompt: "fix it", policy: { retry_503_after_ms: 20_000 } },
    {
      dispatchChat: chatDispatch([503, 200]),
      dispatchImages: async () => { throw new Error("unused"); },
      sleep: async (ms) => { sleeps.push(ms); },
    }
  );
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.retried, true);
  assert.deepEqual(sleeps, [20_000], "exactly one wait, exactly the policy delay");
});

test("quick: second exhaustion is the honest 503 (retried flagged)", async () => {
  const sleeps: number[] = [];
  const result = await orchestrateQuick(
    { tag: "vision", prompt: "describe", policy: { retry_503_after_ms: 5_000 } },
    {
      dispatchChat: chatDispatch([503, 502]),
      dispatchImages: async () => { throw new Error("unused"); },
      sleep: async (ms) => { sleeps.push(ms); },
    }
  );
  assert.equal(result.status, 503);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, "no_active_models");
  assert.equal(result.payload.retried, true);
  assert.deepEqual(sleeps, [5_000]);
});

test("quick: default (no retry policy) fails immediately — B2 behavior unchanged", async () => {
  const sleeps: number[] = [];
  const result = await orchestrateQuick(
    { tag: "chat", prompt: "hi" },
    {
      dispatchChat: chatDispatch([503]),
      dispatchImages: async () => { throw new Error("unused"); },
      sleep: async (ms) => { sleeps.push(ms); },
    }
  );
  assert.equal(result.status, 503);
  assert.equal(result.payload.retried, undefined);
  assert.deepEqual(sleeps, []);
});

test("quick: non-exhausted upstream errors pass through without a retry", async () => {
  const sleeps: number[] = [];
  const result = await orchestrateQuick(
    { tag: "chat", prompt: "hi", policy: { retry_503_after_ms: 20_000 } },
    {
      dispatchChat: chatDispatch([500]),
      dispatchImages: async () => { throw new Error("unused"); },
      sleep: async (ms) => { sleeps.push(ms); },
    }
  );
  assert.equal(result.status, 500);
  assert.equal(result.payload.ok, false);
  assert.deepEqual(sleeps, [], "a 500 is not the guide's 503 — no retry");
});

test("quick: retry_503_after_ms validation + clamp", async () => {
  const bad = await orchestrateQuick(
    { tag: "chat", prompt: "hi", policy: { retry_503_after_ms: -5 } },
    { dispatchChat: chatDispatch([200]), dispatchImages: async () => { throw new Error("unused"); } }
  );
  assert.equal(bad.status, 400);
  assert.match(bad.payload.details?.[0] ?? "", /non-negative/);

  const huge = await orchestrateQuick(
    { tag: "chat", prompt: "hi", policy: { retry_503_after_ms: 999_999 } },
    {
      dispatchChat: chatDispatch([503, 200]),
      dispatchImages: async () => { throw new Error("unused"); },
      sleep: async (ms) => { assert.ok(ms <= 120_000, "clamped to 120s"); },
    }
  );
  assert.equal(huge.status, 200);
});

// ── Swarm context compression ──────────────────────────────────────────────

function swarmJob(policy: Record<string, unknown>, prompt: string): OrchestrateJob {
  const validation = validatePlan({
    goal: "write the song",
    mode: "swarm",
    tasks: [{ id: "t1", tag: "chat", prompt, depends_on: [] }],
    blackboard: { canon: "hero=Ravi", _locked: ["canon"] },
    policy,
  });
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    jobId: "job_b8",
    goal: validation.goal,
    mode: validation.mode,
    policy: validation.policy,
    blackboard: validation.blackboard,
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    judgeRounds: 0,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "job_b8",
      id: task.id,
      tag: task.tag,
      modality: task.modality,
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
  } as unknown as OrchestrateJob;
}

const FILLER_PROMPT =
  "Please kindly make sure to explain the bridge section of the song. It is important that you also cover the chorus and the hook. Thank you so much for your help with this task!";

test("compression: off by default — prompt verbatim, no log", async () => {
  const store = new InMemoryJobsStore();
  const job = swarmJob({ judge: false }, FILLER_PROMPT);
  store.createJob(job, null);
  const prompts: string[] = [];
  const dispatch: TaskDispatch = async (input) => {
    prompts.push(input.prompt);
    return { ok: true, text: "done", model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  assert.match(prompts[0], /Please kindly make sure/);
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.log.filter((entry) => entry.event === "context_compressed").length, 0);
});

test("compression: policy on — context compressed, event logged, job still done", async () => {
  // Control run (policy off) gives the uncompressed wrapped prompt to
  // compare against — the swarm wrapper itself is hundreds of chars, so
  // only the same-policy comparison proves the compression.
  const controlStore = new InMemoryJobsStore();
  const controlJob = swarmJob({ judge: false }, FILLER_PROMPT);
  controlStore.createJob(controlJob, null);
  const controlPrompts: string[] = [];
  await runJob(controlJob.jobId, {
    store: controlStore,
    dispatch: async (input) => {
      controlPrompts.push(input.prompt);
      return { ok: true, text: "done", model: "m", provider: "p" };
    },
    sleep: async () => {},
  });

  const store = new InMemoryJobsStore();
  const job = swarmJob({ judge: false, compress_context: true }, FILLER_PROMPT);
  store.createJob(job, null);
  const prompts: string[] = [];
  const dispatch: TaskDispatch = async (input) => {
    prompts.push(input.prompt);
    return { ok: true, text: "done", model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const events = final.log.filter((entry) => entry.event === "context_compressed");
  assert.equal(events.length, 1);
  assert.match(events[0].detail ?? "", /→/, "token delta in the log");
  assert.notEqual(prompts[0].includes("Please kindly make sure"), true, "filler stripped");
  assert.ok(
    prompts[0].length < controlPrompts[0].length,
    `compressed ${prompts[0].length} < control ${controlPrompts[0].length}`
  );
});

test("compression: policy default is false and clamps to boolean", () => {
  const base = validatePlan({ goal: "g", mode: "swarm", tasks: [{ id: "t1", tag: "chat", prompt: "p", depends_on: [] }], policy: {} });
  assert.ok(base.ok);
  assert.equal(base.policy.compress_context, false);
  const on = validatePlan({ goal: "g", mode: "swarm", tasks: [{ id: "t1", tag: "chat", prompt: "p", depends_on: [] }], policy: { compress_context: true } });
  assert.ok(on.ok);
  assert.equal(on.policy.compress_context, true);
  const junk = validatePlan({ goal: "g", mode: "swarm", tasks: [{ id: "t1", tag: "chat", prompt: "p", depends_on: [] }], policy: { compress_context: "yes" } });
  assert.ok(junk.ok);
  assert.equal(junk.policy.compress_context, false, "non-boolean is not truthy-coerced");
});

// ── Liveness canaries ──────────────────────────────────────────────────────

const { runCanaryRound, canaryAllows, getCanarySnapshot, resetCanaries, deadModelIds, makeHttpCanaryProbe, CANARY_DEAD_THRESHOLD } =
  await import("../../../open-sse/services/modelTags/canary.ts");

const okProbe = async () => ({ ok: true as const, latencyMs: 12 });
const failProbe = async () => ({ ok: false as const, error: "connection refused" });

test("canary: two consecutive failures mark dead; one does not; success recovers", async () => {
  resetCanaries();
  const entry = { id: "prov/model-a", provider: "prov" };
  await runCanaryRound([entry], failProbe);
  assert.equal(canaryAllows(entry.id), true, "first failure is not death");
  await runCanaryRound([entry], failProbe);
  assert.equal(canaryAllows(entry.id), false, `dead at ${CANARY_DEAD_THRESHOLD} consecutive failures`);
  assert.deepEqual(deadModelIds(), [entry.id]);
  const summary = await runCanaryRound([entry], okProbe);
  assert.equal(summary.recovered, 1);
  assert.equal(canaryAllows(entry.id), true);
  assert.deepEqual(deadModelIds(), []);
  const snapshot = getCanarySnapshot()[entry.id];
  assert.equal(snapshot.alive, true);
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.latencyMs, 12);
  resetCanaries();
});

test("canary: stale dead verdicts stop filtering (a canary outage never culls a model)", async () => {
  resetCanaries();
  const entry = { id: "prov/model-b", provider: "prov" };
  await runCanaryRound([entry], failProbe);
  await runCanaryRound([entry], failProbe);
  assert.equal(canaryAllows(entry.id), false);
  const stale = Date.now() + 11 * 60_000;
  assert.equal(canaryAllows(entry.id, stale), true, "11-minute-old dead verdict no longer filters");
  assert.deepEqual(deadModelIds(stale), []);
  resetCanaries();
});

test("canary: rankings skip fresh-dead models; empty state changes nothing", async () => {
  resetCanaries();
  const { getModelTagIndex } = await import("../../../open-sse/services/modelTags/liveIndex.ts");
  const { findModelsByTags } = await import("../../../open-sse/services/modelTags/tagIndex.ts");
  const index = getModelTagIndex();
  const before = findModelsByTags(index, { category: "chat", distinctModels: true, limit: 5 });
  assert.ok(before.length >= 2, "registry has chat candidates");
  // Empty canary state: identical results.
  assert.deepEqual(
    findModelsByTags(index, { category: "chat", distinctModels: true, limit: 5 }).map((e) => e.id),
    before.map((e) => e.id)
  );
  // Mark the second candidate dead — it disappears from the ranking.
  const victim = before[1];
  await runCanaryRound([{ id: victim.id, provider: victim.provider }], failProbe);
  await runCanaryRound([{ id: victim.id, provider: victim.provider }], failProbe);
  const after = findModelsByTags(index, { category: "chat", distinctModels: true, limit: 5 }).map((e) => e.id);
  assert.ok(!after.includes(victim.id), "fresh-dead model is skipped by rankings");
  resetCanaries();
});

test("canary: default HTTP probe — any response is alive, only network errors die", async () => {
  resetCanaries();
  const probe = makeHttpCanaryProbe(
    (provider) => (provider === "good" ? "https://good.example" : provider === "bad" ? "https://bad.example" : null),
    (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("good.example")) return new Response("unauthorized", { status: 401 });
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch
  );
  const unprobeable = await probe({ id: "none/m", provider: "no-such-provider" });
  assert.deepEqual(unprobeable, { ok: true, latencyMs: 0 }, "no base URL → skipped as ok");
  const alive = await probe({ id: "good/m", provider: "good" });
  assert.equal(alive.ok, true, "401 still proves reachability");
  assert.equal(typeof (alive as { latencyMs: number }).latencyMs, "number");
  const dead = await probe({ id: "bad/m", provider: "bad" });
  assert.equal(dead.ok, false);
  assert.match((dead as { error: string }).error, /ENOTFOUND/);
  resetCanaries();
});

// ── Benchmark wiring ───────────────────────────────────────────────────────

test("benchmark wiring: user fitness override surfaces as a runtime score", async () => {
  const { getModelTagIndex, resetModelTagIndexCache } = await import(
    "../../../open-sse/services/modelTags/liveIndex.ts"
  );
  resetModelTagIndexCache();
  const index = getModelTagIndex();
  const coder = (index.byCategory.get("coder") ?? [])[0];
  assert.ok(coder, "registry has a coder-category model");
  try {
    setUserFitnessOverride(coder.model, "coding", 0.87);
    resetModelTagIndexCache();
    const rebuilt = getModelTagIndex();
    const entry = (rebuilt.byCategory.get("coder") ?? []).find((candidate) => candidate.model === coder.model);
    assert.ok(entry);
    assert.deepEqual(entry.benchmarkOverlays?.coder, {
      score: 87,
      source: "runtime",
      basis: "runtime score lookup",
    });
  } finally {
    clearUserFitnessOverride(coder.model, "coding");
    resetModelTagIndexCache();
  }
});

test("benchmark wiring: unmapped categories stay null (chat keeps its seeds/axes)", async () => {
  const { taskFitnessScoreLookup } = await import("../../../open-sse/services/modelTags/runtimeScores.ts");
  assert.equal(taskFitnessScoreLookup("chat", { model: "whatever", id: "p/whatever", provider: "p" }), null);
  assert.equal(taskFitnessScoreLookup("image-gen", { model: "whatever", id: "p/whatever", provider: "p" }), null);
});

// ── model "auto" (Guide 2 Part 2) ─────────────────────────────────────────

test("auto: the classifier decision the direct chat path applies", async () => {
  const vision = await classifyRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "what is in this picture" }, { type: "image_url", image_url: { url: "data:image/png;base64,xx" } }] }],
  });
  assert.equal(vision.type, "vision");
  assert.equal(vision.alias, "vision");

  const code = await classifyRequest({
    messages: [{ role: "user", content: "refactor this function to fix the failing unit test in the repo" }],
  });
  assert.equal(code.type, "code");
  assert.equal(code.alias, "code");

  const plain = await classifyRequest({ messages: [{ role: "user", content: "hello there" }] });
  assert.equal(plain.alias, "chat");
});
