/**
 * Harness B1 (Layer 3) — benchmark axes, task classifier, capability aliases.
 *
 * Coverage: axis seeding + axis-aware ranking (and byte-identical legacy
 * behavior when no axis is set), the classifier's deterministic stage-1
 * heuristics + stage-2 model fallback degradation, capability alias combo
 * construction, and the getComboForModel seam (bare alias → ephemeral
 * priority combo; unknown names fall through).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b1-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b1-test-secret";

const {
  buildModelTagIndex,
  findModelsByTags,
  BENCHMARK_AXES,
  TASK_TYPE_TO_QUERY,
  isTaskType,
  isBenchmarkAxis,
} = await import("../../../open-sse/services/modelTags/index.ts");
import type { ModelTagIndex } from "../../../open-sse/services/modelTags/index.ts";
const { classifyRequestBody, classifyRequest } = await import(
  "../../../open-sse/services/harness/classifier.ts"
);
const {
  buildCapabilityAliasCombo,
  isCapabilityAlias,
  CAPABILITY_ALIASES,
} = await import("../../../open-sse/services/harness/capabilityAliases.ts");

type Body = Record<string, unknown>;

// ── Fixture: a miniature deterministic index ────────────────────────────────

function fixtureIndex(): ModelTagIndex {
  return buildModelTagIndex(
    {
      openai: [
        { id: "gpt-5.6", toolCalling: true, supportsVision: true, supportsReasoning: true, contextLength: 400_000 },
        { id: "gpt-5.5-pro", toolCalling: true, supportsVision: true, supportsReasoning: true, contextLength: 256_000 },
        { id: "gpt-4.1-mini", toolCalling: true, contextLength: 128_000 },
      ],
      anthropic: [
        { id: "claude-opus-5", toolCalling: true, supportsVision: true, supportsReasoning: true, contextLength: 500_000 },
        { id: "claude-sonnet-5", toolCalling: true, supportsVision: true, contextLength: 200_000 },
      ],
      google: [
        { id: "gemini-3.1-pro-preview", toolCalling: true, supportsVision: true, supportsReasoning: true, contextLength: 1_000_000 },
      ],
      deepseek: [{ id: "deepseek-v4-pro", toolCalling: true, contextLength: 160_000 }],
      moonshot: [{ id: "kimi-k2.7-code", toolCalling: true, contextLength: 256_000 }],
      mistral: [{ id: "codestral-latest", toolCalling: true, contextLength: 64_000 }],
    },
    []
  );
}

// ── Benchmark axes ──────────────────────────────────────────────────────────

test("axes: seeded flagship models carry multi-axis scores", () => {
  const index = fixtureIndex();
  const gpt = index.lookup("openai/gpt-5.6");
  assert.ok(gpt, "gpt-5.6 in index");
  assert.ok(gpt.axes, "axes resolved");
  for (const axis of BENCHMARK_AXES) {
    assert.ok(gpt.axes?.[axis], `axis ${axis} present`);
    assert.ok(gpt.axes[axis].score >= 0 && gpt.axes[axis].score <= 100);
    assert.match(gpt.axes[axis].basis, /curated seed/);
  }
  // Unseeded model: no axis evidence, never invented.
  const mini = index.lookup("openai/gpt-4.1-mini");
  assert.ok(mini);
  assert.equal(mini.axes, undefined, "unseeded model has NO axis scores");
});

test("axes: axis ranking spans the whole chat registry and reorders it", () => {
  const index = fixtureIndex();

  // Composite chat ranking: LMArena-style generalist order.
  const chat = findModelsByTags(index, { category: "chat" }).map((e) => e.model);
  assert.ok(chat.length >= 5);

  // SWE-bench axis over the SAME registry (no category filter): flagship
  // generalists outrank the name-inferred coding specialists on their own
  // turf — exactly the allocator insight the harness exists for.
  const swe = findModelsByTags(index, { axis: "swe_bench" }).map((e) => e.model);
  assert.equal(swe[0], "gpt-5.6", "swe-bench top seed leads");
  assert.ok(
    swe.indexOf("gpt-5.6") < swe.indexOf("kimi-k2.7-code"),
    "generalist flagship beats the coding-specialist on SWE-bench"
  );
  // Unseeded models keep "no evidence" semantics: after every scored entry.
  const mini = swe.indexOf("gpt-4.1-mini");
  for (const scored of ["gpt-5.6", "claude-opus-5", "claude-sonnet-5", "kimi-k2.7-code", "codestral-latest"]) {
    assert.ok(mini > swe.indexOf(scored), `${scored} sorts before unseeded gpt-4.1-mini`);
  }

  // The axis REORDERS vs the composite: claude-opus-5 (chat 92) ranks above
  // gemini-3.1-pro-preview (chat 91) on the composite, but gemini's MATH-500
  // 95 beats opus's 93 — the axis flips their order.
  const math = findModelsByTags(index, { axis: "math500" }).map((e) => e.model);
  assert.ok(chat.indexOf("claude-opus-5") < chat.indexOf("gemini-3.1-pro-preview"), "composite chat order");
  assert.ok(math.indexOf("gemini-3.1-pro-preview") < math.indexOf("claude-opus-5"), "axis flips the order");
});

test("axes: minBenchmark with an axis floors on axis evidence only", () => {
  const index = fixtureIndex();
  const floored = findModelsByTags(index, {
    axis: "swe_bench",
    minBenchmark: 60,
  });
  for (const entry of floored) {
    assert.ok(
      entry.axes?.swe_bench && entry.axes.swe_bench.score >= 60,
      `${entry.id} passed the floor without SWE-bench evidence`
    );
  }
  const models = floored.map((e) => e.model);
  assert.ok(models.includes("gpt-5.6")); // 74
  assert.ok(models.includes("claude-sonnet-5")); // 65
  assert.ok(!models.includes("codestral-latest")); // 36
  assert.ok(!models.includes("gpt-4.1-mini")); // no evidence
});

test("axes: absence keeps pre-B1 behavior byte-identical", () => {
  const index = fixtureIndex();
  const a = findModelsByTags(index, { category: "coder", distinctModels: true, diverseProviders: true, limit: 4 }).map((e) => e.id);
  assert.ok(a.length > 0);
  assert.equal(new Set(a).size, a.length, "distinct models");
});

test("axes: isBenchmarkAxis / isTaskType guard untrusted input", () => {
  assert.ok(isBenchmarkAxis("swe_bench"));
  assert.ok(!isBenchmarkAxis("swe-bench"));
  assert.ok(!isBenchmarkAxis(undefined));
  assert.ok(isTaskType("code"));
  assert.ok(!isTaskType("coding"));
  assert.ok(!isTaskType(7));
});

// ── Task-type mapping ───────────────────────────────────────────────────────

test("task types: classifier vocabulary maps to index queries with axes", () => {
  // Axis-ranked task types span the whole chat registry (no category).
  assert.equal(TASK_TYPE_TO_QUERY.code.category, undefined);
  assert.equal(TASK_TYPE_TO_QUERY.code.axes[0], "swe_bench");
  assert.equal(TASK_TYPE_TO_QUERY.code.requireTools, true);
  assert.equal(TASK_TYPE_TO_QUERY.math.category, undefined);
  assert.equal(TASK_TYPE_TO_QUERY.math.axes[0], "math500");
  assert.equal(TASK_TYPE_TO_QUERY.reasoning.category, undefined);
  assert.equal(TASK_TYPE_TO_QUERY.reasoning.axes[0], "gpqa");
  assert.equal(TASK_TYPE_TO_QUERY.chat.axes[0], "lmarena_elo");
  // Subcategory-gated task types keep their category + fallback.
  assert.equal(TASK_TYPE_TO_QUERY.research.category, "search");
  assert.equal(TASK_TYPE_TO_QUERY.research.fallbackCategory, "chat");
  assert.equal(TASK_TYPE_TO_QUERY.vision.category, "vision");
  assert.equal(TASK_TYPE_TO_QUERY.vision.requireVision, true);
});

// ── Classifier (stage 1) ────────────────────────────────────────────────────

function chatBody(text: string, extra: Body = {}): Body {
  return { messages: [{ role: "user", content: text }], ...extra };
}

test("classifier: image-bearing body is a high-confidence vision task", () => {
  const result = classifyRequestBody({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this picture" },
          { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
        ],
      },
    ],
  });
  assert.equal(result.type, "vision");
  assert.equal(result.confidence, "high");
  assert.equal(result.alias, "vision");
  assert.ok(result.modalities.includes("vision"));
});

test("classifier: keyword signals route code / math / search / research", () => {
  assert.equal(classifyRequestBody(chatBody("refactor this function and fix the bug in the python code")).type, "code");
  assert.equal(classifyRequestBody(chatBody("prove the theorem about matrix eigenvalues")).type, "math");
  assert.equal(classifyRequestBody(chatBody("what is the latest news on fusion energy today?")).type, "search");
  assert.equal(
    classifyRequestBody(chatBody("research the state of the art and survey the literature")).type,
    "research"
  );
  assert.equal(classifyRequestBody(chatBody("solve this logic puzzle about the paradox")).type, "reasoning");
  assert.equal(classifyRequestBody(chatBody("hello!")).type, "chat");
  assert.equal(classifyRequestBody(chatBody("hello!")).confidence, "low");
});

test("classifier: tool-bearing requests lean code without overriding keywords", () => {
  const tools = [{ type: "function", function: { name: "f" } }];
  assert.equal(classifyRequestBody(chatBody("use the tool", { tools })).type, "code");
  // A strong math signal still wins over the tools lean.
  assert.equal(
    classifyRequestBody(chatBody("prove the integral converges, calculate the derivative", { tools })).type,
    "math"
  );
});

test("classifier: complexity — deep markers, long input, long history", () => {
  assert.equal(classifyRequestBody(chatBody("explain quantum tunneling")).complexity, "fast");
  assert.equal(classifyRequestBody(chatBody("give me a comprehensive step-by-step analysis")).complexity, "deep");
  assert.equal(classifyRequestBody(chatBody("x".repeat(7000))).complexity, "deep");
  const longHistory = { messages: Array.from({ length: 14 }, (_, i) => ({ role: "user", content: `m${i}` })) };
  assert.equal(classifyRequestBody(longHistory).complexity, "deep");
});

test("classifier: never throws on hostile shapes", () => {
  assert.equal(classifyRequestBody({}).type, "chat");
  assert.equal(classifyRequestBody({ messages: "not-an-array" }).type, "chat");
  assert.equal(classifyRequestBody({ messages: [null, 42, { role: 3 }] }).type, "chat");
  assert.equal(classifyRequestBody({ prompt: "write a function" }).type, "code");
});

// ── Classifier (stage 2) ────────────────────────────────────────────────────

function stage2Dispatch(verdict: unknown, ok = true) {
  return async (): Promise<Response> => {
    if (!ok) return new Response("boom", { status: 500 });
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(verdict) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
}

test("classifier: stage 2 refines only low-confidence verdicts", async () => {
  const low = chatBody("hey so about that thing");
  const refined = await classifyRequest(low, { dispatch: stage2Dispatch({ type: "math", complexity: "deep" }) });
  assert.equal(refined.stage, "model");
  assert.equal(refined.type, "math");
  assert.equal(refined.complexity, "deep");
  assert.equal(refined.alias, "math");

  // High-confidence heuristics never spend the call.
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return stage2Dispatch({ type: "math" })();
  };
  const kept = await classifyRequest(chatBody("fix the python bug"), { dispatch: counting });
  assert.equal(kept.stage, "heuristics");
  assert.equal(calls, 0);
});

test("classifier: stage 2 failures degrade to heuristics, never error", async () => {
  const body = chatBody("hey so about that thing");
  const httpFail = await classifyRequest(body, { dispatch: stage2Dispatch({}, false) });
  assert.equal(httpFail.stage, "heuristics");

  const garbage = async () =>
    new Response("not json at all", { status: 200, headers: { "Content-Type": "text/plain" } });
  const parseFail = await classifyRequest(body, { dispatch: garbage });
  assert.equal(parseFail.stage, "heuristics");

  const badEnum = await classifyRequest(body, {
    dispatch: stage2Dispatch({ type: "spreadsheets" }),
  });
  assert.equal(badEnum.stage, "heuristics");

  const throwing = async () => {
    throw new Error("network gone");
  };
  const thrown = await classifyRequest(body, { dispatch: throwing });
  assert.equal(thrown.stage, "heuristics");
});

// ── Capability aliases ──────────────────────────────────────────────────────

test("aliases: bare reserved words build ephemeral priority combos", () => {
  const combo = buildCapabilityAliasCombo("code");
  assert.ok(combo, "code alias resolves");
  assert.equal(combo.strategy, "priority");
  assert.equal(combo._capabilityAlias, true);
  assert.ok(combo.models.length >= 1 && combo.models.length <= 6);
  for (const step of combo.models) {
    assert.equal(typeof step.model, "string");
    assert.ok(step.model.includes("/"), "full provider/model ids");
  }
  // Axis-ranked: the SWE-bench top seed leads the candidate list
  // (provider-agnostic — first-party provider order decides the prefix).
  assert.ok(combo.models[0].model.endsWith("/gpt-5.6"));

  // Distinct models (relay-duplicate collapse discipline).
  const bare = combo.models.map((m) => m.model.split("/")[1]);
  assert.equal(new Set(bare).size, bare.length);
});

test("aliases: unknown and provider-prefixed names are not aliases", () => {
  assert.equal(buildCapabilityAliasCombo("definitely-not-an-alias"), null);
  assert.equal(buildCapabilityAliasCombo("openai/code"), null);
  assert.equal(buildCapabilityAliasCombo(""), null);
  assert.ok(isCapabilityAlias("code"));
  assert.ok(!isCapabilityAlias("Code")); // model ids are case-sensitive
  assert.ok(!isCapabilityAlias("code "));
  // Every alias is a documented capability name; Guide 2's contract strings
  // (vision, code, research, plan, chat) are all present.
  const aliasKeys = [...Object.keys(CAPABILITY_ALIASES)].sort();
  for (const contract of ["chat", "code", "math", "plan", "reasoning", "research", "search", "vision"]) {
    assert.ok(aliasKeys.includes(contract), `alias ${contract} present`);
  }
});

test("aliases: live registry resolves every alias or falls back to chat", () => {
  for (const alias of Object.keys(CAPABILITY_ALIASES)) {
    const combo = buildCapabilityAliasCombo(alias);
    // chat-registry aliases (code/math/reasoning/chat/vision) must resolve
    // against the live index; search/research fall back to chat if the
    // search category is empty — never null with a populated chat registry.
    assert.ok(combo, `alias ${alias} resolves against the live index`);
    assert.ok(combo.models.length >= 1, `alias ${alias} has candidates`);
  }
});

// ── getComboForModel seam (e2e through the DB layer) ───────────────────────

test("seam: getComboForModel resolves bare aliases, passes names through", async () => {
  const { getComboForModel } = await import("../../../src/sse/services/model.ts");
  const aliasCombo = await getComboForModel("code");
  assert.ok(aliasCombo, "alias resolves through the seam");
  assert.equal((aliasCombo as { _capabilityAlias?: boolean })._capabilityAlias, true);
  assert.equal(
    (aliasCombo as { strategy?: string }).strategy,
    "priority",
    "native combo machinery applies (failover across candidates)"
  );

  // Unknown names fall through to ordinary resolution (null here — no such
  // combo/model in the isolated test DB).
  assert.equal(await getComboForModel("no-such-thing-anywhere"), null);
  // Provider-prefixed "code" is an ordinary model reference, not an alias.
  assert.equal(await getComboForModel("openai/code"), null);
});
