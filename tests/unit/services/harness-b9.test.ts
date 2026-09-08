/**
 * Harness B9 (breaker feed) — tests for:
 *
 *   1. Allocator: breakerOf receives (model, provider); an open provider's
 *      candidate scores ×0.2 and loses to an equal-quality healthy one;
 *      without the predicate nothing changes (B5 behavior).
 *   2. Feed semantics: registry OPEN/HALF_OPEN → penalty; DEGRADED/CLOSED/
 *      unknown/null → no penalty; persisted-state fallback on a cold
 *      registry; peek never creates registry entries.
 *   3. Runner wiring: runJob with deps.breakerOpen steers assigned routing
 *      away from the open provider (falls to the next candidate or the
 *      alias fallback — never assigns the open provider's model).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b9-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b9-test-secret";

const { assignModels, scoreCandidate } = await import("../../../open-sse/services/harness/allocator.ts");
const { validatePlan, runJob, InMemoryJobsStore, candidatesForTag } = await import(
  "../../../open-sse/services/harness/orchestrator.ts"
);
import type { OrchestrateJob, TaskDispatch } from "../../../open-sse/services/harness/orchestrator.ts";
const { providerBreakerOpen } = await import("../../../src/lib/harness/breakerFeed.ts");
const { getCircuitBreaker, peekCircuitBreaker, STATE, resetAllCircuitBreakers } = await import(
  "../../../src/shared/utils/circuitBreaker.ts"
);
const { saveCircuitBreakerState } = await import("../../../src/lib/db/domainState.ts");

// ── Allocator: the breaker predicate ───────────────────────────────────────

test("allocator: breakerOf gets (model, provider); open provider loses to healthy", () => {
  const seen: Array<[string, string | null]> = [];
  const { assignments } = assignModels(
    [{ id: "t1", tag: "chat" }],
    () => [
      { model: "m-top", provider: "prov-open", quality: 0.9 },
      { model: "m-second", provider: "prov-ok", quality: 0.7 },
    ],
    {
      maxPerProvider: 3,
      breakerOf: (model, provider) => {
        seen.push([model, provider]);
        return provider === "prov-open";
      },
    }
  );
  assert.deepEqual(seen, [
    ["m-top", "prov-open"],
    ["m-second", "prov-ok"],
  ], "predicate receives the candidate's provider");
  assert.equal(assignments.get("t1")?.candidate.model, "m-second", "0.9×0.2 < 0.7");
});

test("allocator: no predicate = B5 behavior (top quality wins)", () => {
  const { assignments } = assignModels(
    [{ id: "t1", tag: "chat" }],
    () => [
      { model: "m-top", provider: "prov-open", quality: 0.9 },
      { model: "m-second", provider: "prov-ok", quality: 0.7 },
    ],
    { maxPerProvider: 3 }
  );
  assert.equal(assignments.get("t1")?.candidate.model, "m-top");
});

test("allocator: score math — breaker multiplier is exactly 0.2", () => {
  const closed = scoreCandidate({ quality: 0.5, breakerOpen: false });
  const open = scoreCandidate({ quality: 0.5, breakerOpen: true });
  assert.ok(Math.abs(open - closed * 0.2) < 1e-9, `${open} vs ${closed}×0.2`);
});

// ── Feed semantics ─────────────────────────────────────────────────────────

test("feed: registry OPEN and HALF_OPEN penalize; DEGRADED/CLOSED/unknown do not", async () => {
  resetAllCircuitBreakers();
  try {
    const breaker = getCircuitBreaker("feed-prov", { failureThreshold: 1, resetTimeout: 60_000 });
    assert.equal(providerBreakerOpen("feed-prov"), false, "fresh breaker is closed");
    // Drive it OPEN through the public API: one failing execute (threshold 1).
    await assert.rejects(breaker.execute(async () => { throw new Error("boom"); }));
    assert.equal(breaker.state, STATE.OPEN);
    assert.equal(providerBreakerOpen("feed-prov"), true, "OPEN penalizes");
    // HALF_OPEN: force the state directly (probe window) — still penalizes.
    (breaker as unknown as { state: string }).state = STATE.HALF_OPEN;
    assert.equal(providerBreakerOpen("feed-prov"), true, "HALF_OPEN penalizes");
    (breaker as unknown as { state: string }).state = STATE.DEGRADED;
    assert.equal(providerBreakerOpen("feed-prov"), false, "DEGRADED passes by design");
    (breaker as unknown as { state: string }).state = STATE.CLOSED;
    assert.equal(providerBreakerOpen("feed-prov"), false, "CLOSED is healthy");
  } finally {
    resetAllCircuitBreakers();
  }
});

test("feed: cold registry falls back to the persisted state; peek never creates", async () => {
  resetAllCircuitBreakers();
  try {
    // Persisted OPEN for a provider with no live instance.
    saveCircuitBreakerState("cold-prov", { state: STATE.OPEN, failureCount: 5, lastFailureTime: Date.now(), options: null });
    assert.equal(peekCircuitBreaker("cold-prov"), undefined, "no instance was created by the feed");
    assert.equal(providerBreakerOpen("cold-prov"), true, "persisted OPEN is honored after a restart");

    saveCircuitBreakerState("cold-prov-ok", { state: STATE.CLOSED, failureCount: 0, lastFailureTime: null, options: null });
    assert.equal(providerBreakerOpen("cold-prov-ok"), false);

    assert.equal(providerBreakerOpen(null), false);
    assert.equal(providerBreakerOpen("never-seen-anywhere"), false);
    assert.equal(peekCircuitBreaker("never-seen-anywhere"), undefined, "unknown names never get instances");
  } finally {
    resetAllCircuitBreakers();
  }
});

// ── Runner wiring ──────────────────────────────────────────────────────────

function chatJob(policy: Record<string, unknown>): OrchestrateJob {
  const validation = validatePlan({
    goal: "g",
    mode: "parallel",
    tasks: [{ id: "t1", tag: "chat", prompt: "say hi", depends_on: [] }],
    policy,
  });
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    jobId: "job_b9",
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
      jobId: "job_b9",
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

test("runner: deps.breakerOpen steers assigned routing away from the open provider", async () => {
  resetAllCircuitBreakers();
  // Find the current top chat candidate's provider and mark IT open.
  const top = candidatesForTag("chat", "any")[0];
  assert.ok(top, "registry has chat candidates");
  const store = new InMemoryJobsStore();
  const job = chatJob({ routing: "assigned", max_attempts: 1 });
  store.createJob(job, null);
  const models: Array<string | null> = [];
  const dispatch: TaskDispatch = async (input) => {
    models.push(input.assignedModel ?? null);
    return { ok: true, text: "hi back", model: input.assignedModel ?? "alias", provider: "p" };
  };
  await runJob(job.jobId, {
    store,
    dispatch,
    sleep: async () => {},
    breakerOpen: (provider) => provider === top.provider,
  });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const task = final.tasks[0];
  // Either a different provider's model was assigned, or the allocator
  // fell back to the alias — the open provider's model is never assigned.
  assert.notEqual(task.assignedModel, top.model, `top candidate ${top.model} (${top.provider}) must not win while its breaker is open`);
  const assignedLog = final.log.find((entry) => entry.event === "task_assigned");
  if (assignedLog) {
    assert.ok(!assignedLog.detail?.includes(top.provider ?? "??"), "assignment log names a healthy provider");
  }
});

test("runner: without the feed, assigned routing keeps B5 behavior", async () => {
  const top = candidatesForTag("chat", "any")[0];
  assert.ok(top);
  const store = new InMemoryJobsStore();
  const job = chatJob({ routing: "assigned", max_attempts: 1 });
  store.createJob(job, null);
  await runJob(job.jobId, {
    store,
    dispatch: async (input) => ({ ok: true, text: "ok", model: input.assignedModel ?? "alias", provider: "p" }),
    sleep: async () => {},
  });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  // The allocator's top candidate wins when no feed is passed.
  assert.equal(final.tasks[0].assignedModel, top.model);
});
