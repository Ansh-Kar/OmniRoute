/**
 * Harness B12 — the capability registry: descriptor assembly, hard
 * capability filtering, unified ranking (benchmark × empirical × reliability
 * / cost / latency), PRIMARY/SECONDARY/FALLBACK tiers, equal-scoring
 * self-assessment, and the per-(model × category) closed loop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b12-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b12-test-secret";

const registry = await import("../../../open-sse/services/harness/capabilityRegistry.ts");
const {
  buildModelDescriptors,
  filterCandidates,
  rankCandidates,
  unifiedScore,
  selfAssess,
  rankedToApi,
} = registry;
import type { ModelTagEntry } from "../../../open-sse/services/modelTags/index.ts";

const orchestrator = await import("../../../open-sse/services/harness/orchestrator.ts");
const { validatePlan, runJob, candidatesForTag, InMemoryJobsStore } = orchestrator;
import type { OrchestrateJob, OrchestrateTask, TaskDispatch } from "../../../open-sse/services/harness/orchestrator.ts";
import { assignModels, type AllocatorCandidate } from "../../../open-sse/services/harness/allocator.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

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
  entry({
    id: "alibaba/qwen3-vl-32b",
    categories: ["chat", "vision"],
    vision: true,
    tools: true,
    contextLength: 128_000,
    axes: { swe_bench: { score: 84, source: "seed", basis: "test" }, gpqa: { score: 87, source: "seed", basis: "test" } },
    benchmark: { score: 88, source: "seed", basis: "test" },
  }),
  entry({
    id: "deep/coder-x",
    categories: ["chat", "coder"],
    tools: true,
    contextLength: 64_000,
    axes: { humaneval: { score: 90, source: "seed", basis: "test" } },
    benchmark: { score: 86, source: "seed", basis: "test" },
  }),
  entry({
    id: "basic/plain-chat",
    categories: ["chat"],
    contextLength: 8_000,
  }),
  entry({
    id: "media/artist",
    categories: ["image-gen"],
  }),
];

// ── Descriptor assembly ─────────────────────────────────────────────────────

test("descriptors: capabilities, specializations, benchmarks, preferred_for", () => {
  const descriptors = buildModelDescriptors({ entries: ENTRIES });
  const qwen = descriptors.find((d) => d.id === "alibaba/qwen3-vl-32b");
  assert.ok(qwen);
  assert.deepEqual(
    { vision: qwen.capabilities.vision, tool_calling: qwen.capabilities.tool_calling, code: qwen.capabilities.code, image_generation: qwen.capabilities.image_generation },
    { vision: true, tool_calling: true, code: true, image_generation: false },
    "capability matrix derived from registry flags + categories + axes"
  );
  assert.equal(qwen.operational.context_window, 128_000);
  const specNames = qwen.specializations.map((spec) => spec.name);
  assert.ok(specNames.includes("swe_tasks"), "swe_bench axis → swe_tasks specialization");
  assert.ok(specNames.includes("visual_reasoning"), "vision flag → visual_reasoning");
  assert.equal(qwen.benchmarks.swe_bench, 84);
  assert.equal(qwen.benchmarks.composite, 88);
  assert.equal(qwen.preferred_for.length, Math.min(3, qwen.specializations.length));

  const plain = descriptors.find((d) => d.id === "basic/plain-chat");
  assert.ok(plain);
  assert.equal(plain.capabilities.vision, false);
  assert.equal(plain.reliability.samples, 0, "unobserved → no samples");
  assert.equal(plain.reliability.success_rate, null);
  assert.equal(plain.operational.latency_p50_ms, null);
});

test("descriptors: enrichment overrides specializations + cost", () => {
  const descriptors = buildModelDescriptors({
    entries: ENTRIES,
    enrichment: {
      "qwen3-vl-32b": { specializations: { ocr: 0.96, ui_understanding: 0.91 }, cost_per_million_tokens: 0.4 },
    },
  });
  const qwen = descriptors.find((d) => d.id === "alibaba/qwen3-vl-32b");
  assert.ok(qwen);
  const ocr = qwen.specializations.find((spec) => spec.name === "ocr");
  assert.ok(ocr);
  assert.equal(ocr.score, 0.96);
  assert.equal(qwen.operational.cost_per_million_tokens, 0.4);
  assert.ok(qwen.preferred_for.includes("ocr"), "enriched specialization becomes a routing hint");
});

// ── Stage 1: hard filter ────────────────────────────────────────────────────

test("filter: modality/capability/tool_calling/min_context are hard eliminations", () => {
  const descriptors = buildModelDescriptors({ entries: ENTRIES });

  const vision = filterCandidates(descriptors, { modality: "image" });
  assert.deepEqual(
    vision.candidates.map((d) => d.id),
    ["alibaba/qwen3-vl-32b"],
    "only the vision model accepts image input"
  );
  assert.equal(vision.eliminated, 3, "100 → 17, deterministically");

  const tools = filterCandidates(descriptors, { tool_calling: true });
  assert.deepEqual(
    tools.candidates.map((d) => d.id).sort(),
    ["alibaba/qwen3-vl-32b", "deep/coder-x"]
  );

  const code = filterCandidates(descriptors, { capability: "code" });
  assert.ok(code.candidates.every((d) => d.capabilities.code));

  const ctx = filterCandidates(descriptors, { min_context: 100_000 });
  assert.deepEqual(
    ctx.candidates.map((d) => d.id),
    ["alibaba/qwen3-vl-32b"]
  );

  const none = filterCandidates(descriptors, { modality: "audio" });
  assert.equal(none.candidates.length, 0, "no audio models in the fixture — empty, not an error");
});

// ── Stage 2: unified score ──────────────────────────────────────────────────

test("unified score: neutral multipliers for unknown evidence, exact math", () => {
  const descriptors = buildModelDescriptors({ entries: ENTRIES });
  const qwen = descriptors.find((d) => d.id === "alibaba/qwen3-vl-32b");
  assert.ok(qwen);
  // category absent → composite 88/100; no stats → historical 0.75,
  // reliability 0.75; no cost/latency → penalties 1.
  const { score, breakdown } = unifiedScore(qwen, {});
  assert.ok(Math.abs(score - (1 * 0.88 * 0.75 * 0.75) / (1 * 1)) < 1e-9, `exact neutral math (got ${score})`);
  assert.equal(breakdown.capability_match, 1);
  assert.equal(breakdown.historical_success, 0.75);
  assert.equal(breakdown.cost_penalty, 1);
  assert.equal(breakdown.latency_penalty, 1);

  // Specialization feeds capability_match.
  const withSpec = unifiedScore(qwen, { specialization: "swe_tasks" });
  assert.equal(withSpec.breakdown.capability_match, 0.84);

  // Cost penalty ≥ 1 and directionally correct.
  const costly = buildModelDescriptors({
    entries: ENTRIES,
    enrichment: { "qwen3-vl-32b": { cost_per_million_tokens: 2 } },
  });
  const costlyQwen = costly.find((d) => d.id === "alibaba/qwen3-vl-32b");
  assert.ok(costlyQwen);
  const costlyScore = unifiedScore(costlyQwen, {});
  assert.equal(costlyScore.breakdown.cost_penalty, 3, "1 + cost/base with base=1");
  assert.ok(costlyScore.score < score, "costlier ranks lower");
});

test("unified score: empirical per-category success is the closed loop", () => {
  const stats = {
    "alibaba/qwen3-vl-32b": { successes: 90, failures: 10, totalLatencyMs: 90_000 },
  };
  const statsByCategory = {
    "alibaba/qwen3-vl-32b|coder": { successes: 0, failures: 12, totalLatencyMs: 0 }, // catastrophic at code
  };
  const descriptors = buildModelDescriptors({ entries: ENTRIES, stats, statsByCategory });
  const qwen = descriptors.find((d) => d.id === "alibaba/qwen3-vl-32b");
  assert.ok(qwen);

  const global = unifiedScore(qwen, {});
  assert.equal(global.breakdown.historical_success, 0.75, "no category context → global neutral shape via smoothed 0.91");

  const atCode = unifiedScore(qwen, { category: "coder" });
  // laplace((0,12)) = 1/14 ≈ 0.0714 → 0.5 + 0.5×0.0714 ≈ 0.536
  assert.ok(Math.abs(atCode.breakdown.historical_success - (0.5 + 0.5 * (1 / 14))) < 1e-9,
    "per-category failure collapses the multiplier (the workload outvotes the benchmark)");
  assert.ok(atCode.score < global.score, "bad empirical evidence ranks the model down for THAT task");
});

// ── Tiers ───────────────────────────────────────────────────────────────────

test("ranking: PRIMARY/SECONDARY/FALLBACK, all candidates retained", () => {
  const descriptors = buildModelDescriptors({ entries: ENTRIES });
  const { candidates } = filterCandidates(descriptors, {});
  const ranked = rankCandidates(candidates, {}, 3);
  assert.equal(ranked.length, 4, "every filtered candidate stays visible");
  assert.equal(ranked.filter((candidate) => candidate.tier === "primary").length, 1);
  assert.equal(ranked.filter((candidate) => candidate.tier === "secondary").length, 2);
  assert.equal(ranked.filter((candidate) => candidate.tier === "fallback").length, 1);
  // Monotone scores, stable ties.
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, `rank ${i} ≥ rank ${i + 1}`);
  }
  assert.equal(ranked[0].rank, 1);

  const api = ranked.map(rankedToApi);
  assert.ok(api[0].score_breakdown && api[0].capabilities && api[0].specializations && api[0].preferred_for,
    "serialized candidates carry the full metadata Hermes reasons over");
});

// ── Equal-scoring self-assessment ───────────────────────────────────────────

test("self-assessment: the caller competes under the IDENTICAL score", () => {
  const descriptors = buildModelDescriptors({ entries: ENTRIES });
  const { candidates } = filterCandidates(descriptors, {});
  const ranked = rankCandidates(candidates, {}, 3);

  // The strongest candidate names itself → it legitimately wins.
  const winner = ranked[0].descriptor.id;
  const winnerSelf = selfAssess(winner, ranked, []);
  assert.equal(winnerSelf.status, "ranked");
  assert.equal(winnerSelf.rank, 1);
  assert.equal(winnerSelf.would_win, true, "won the same scoring function — no rule against self here");

  // A weaker caller is ranked honestly, never boosted.
  const loser = ranked[ranked.length - 1].descriptor.id;
  const loserSelf = selfAssess(loser, ranked, []);
  assert.equal(loserSelf.would_win, false);
  assert.ok(loserSelf.rank !== null && loserSelf.rank > 1);

  // Filtered out → honest status.
  const filteredSelf = selfAssess("basic/plain-chat", filterCandidates(descriptors, { modality: "image" }).candidates.length ? [] : ranked, descriptors);
  // (plain-chat IS filtered by the image rule in the second list)
  const imageRanked = rankCandidates(filterCandidates(descriptors, { modality: "image" }).candidates, {}, 3);
  const filtered = selfAssess("basic/plain-chat", imageRanked, descriptors);
  assert.equal(filtered.status, "filtered");

  // Not in the registry at all.
  const unknown = selfAssess("ghost/model-9", ranked, descriptors);
  assert.equal(unknown.status, "unregistered");
});

// ── Closed loop through the allocator ───────────────────────────────────────

test("allocator: per-category stats route the task to the model that wins THAT category", () => {
  const pool: AllocatorCandidate[] = [
    { model: "m1", provider: "a", quality: 0.9 },
    { model: "m2", provider: "b", quality: 0.88 },
  ];
  const statsByCategory = {
    "m1|code": { successes: 0, failures: 10, totalLatencyMs: 0 },
    "m2|code": { successes: 10, failures: 0, totalLatencyMs: 30_000 },
    "m1|chat": { successes: 10, failures: 0, totalLatencyMs: 20_000 },
    "m2|chat": { successes: 0, failures: 10, totalLatencyMs: 0 },
  };
  const statOf = (model: string, tag?: string) => (tag !== undefined ? statsByCategory[`${model}|${tag}`] : undefined);

  const code = assignModels([{ id: "t1", tag: "code" }], () => pool, { maxPerProvider: 3, statOf });
  assert.equal(code.assignments.get("t1")?.candidate.model, "m2", "m1 is a code disaster in OUR workload — m2 wins code");

  const chat = assignModels([{ id: "t2", tag: "chat" }], () => pool, { maxPerProvider: 3, statOf });
  assert.equal(chat.assignments.get("t2")?.candidate.model, "m1", "m1 is a chat specialist in OUR workload — m1 wins chat");
});

test("e2e: the store's per-category stats change a real allocation (P(success|model,task) beats the prior)", async () => {
  candidatesForTag("code", "any"); // warm the tag index
  const chatPool = candidatesForTag("chat", "any");
  assert.ok(chatPool.length >= 2, "needs a chat pool with alternatives");
  // Pick an adjacent pair whose quality ratio can't overwhelm the evidence.
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
      goal: "closed loop",
      mode: "parallel",
      tasks: [{ id: "t1", tag: "chat", prompt: "say hi", depends_on: [] }],
      policy: { routing: "assigned" },
    });
    assert.ok(validation.ok);
    const now = Date.now();
    return {
      jobId: `job_cl_${Math.random().toString(36).slice(2, 8)}`,
      goal: "closed loop",
      mode: "parallel",
      policy: validation.ok ? validation.policy : ({} as OrchestrateJob["policy"]),
      blackboard: null,
      status: "active",
      failureReason: null,
      idempotencyKey: null,
      callerModel: null,
      parentJobId: null,
      judgeRounds: 0,
      createdAt: now,
      deadlineAt: now + 600_000,
      tasks: (validation.ok ? validation.tasks : []).map(
        (task) =>
          ({
            jobId: "",
            id: task.id,
            tag: task.tag,
            modality: task.modality,
            prompt: task.prompt,
            dependsOn: [],
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
          }) as OrchestrateTask
      ),
      log: [],
    };
  };

  const dispatch: TaskDispatch = async (input) => ({
    ok: true,
    text: "ok",
    model: input.assignedModel ?? "served",
    provider: "p",
  });

  // Control run: no history — the higher-quality pool model (m1) wins.
  const storeA = new InMemoryJobsStore();
  const jobA = makeJob();
  storeA.createJob(jobA, null);
  await runJob(jobA.jobId, { store: storeA, dispatch, sleep: async () => {} });
  const control = storeA.getJob(jobA.jobId)?.tasks[0].assignedModel;
  assert.equal(control, m1, "control: the prior (pool order) picks m1");

  // Workload history: m1 fails at chat repeatedly; m2 succeeds.
  const storeB = new InMemoryJobsStore();
  const history = makeJob();
  history.status = "done";
  history.tasks = [];
  for (let i = 0; i < 10; i += 1) {
    history.tasks.push({
      ...({} as OrchestrateTask),
      jobId: history.jobId,
      id: `h_f${i}`,
      tag: "chat",
      prompt: "x",
      dependsOn: [],
      state: "failed",
      attempts: 1,
      wave: 1,
      assignedModel: m1,
      assignedProvider: null,
      result: null,
      verdict: null,
      latencyMs: null,
      lastError: "bad",
      leaseUntil: null,
      promptTokens: null,
      completionTokens: null,
    });
    history.tasks.push({
      ...({} as OrchestrateTask),
      jobId: history.jobId,
      id: `h_s${i}`,
      tag: "chat",
      prompt: "x",
      dependsOn: [],
      state: "done",
      attempts: 1,
      wave: 1,
      assignedModel: m2,
      assignedProvider: null,
      result: "ok",
      verdict: null,
      latencyMs: 1_000,
      lastError: null,
      leaseUntil: null,
      promptTokens: null,
      completionTokens: null,
    });
  }
  storeB.createJob(history, null);
  const statsByCat = storeB.aggregateModelStatsByCategory();
  assert.equal(statsByCat[`${m1}|chat`].failures, 10, "per-category key present (model|tag)");
  assert.equal(statsByCat[`${m2}|chat`].successes, 10);

  const jobB = makeJob();
  storeB.createJob(jobB, null);
  await runJob(jobB.jobId, { store: storeB, dispatch, sleep: async () => {} });
  const flipped = storeB.getJob(jobB.jobId)?.tasks[0].assignedModel;
  assert.equal(flipped, m2, "the workload outvoted the benchmark prior — m1's chat failures route the task to m2");
});
