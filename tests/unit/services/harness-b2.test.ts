/**
 * Harness B2 (Guide 1 /quick + Guide 2 Hermes contract) — plan task type,
 * budget tiers, and the orchestrateQuick service.
 *
 * Coverage: `plan` as a first-class task type/alias/classifier class (Guide
 * 2's exact capability strings all work), `alias:best` / `alias:cheap`
 * budget suffixes with relaxation, and /quick's shape mapping — tag
 * validation, budget→model rewrite, images→vision content parts, response
 * mapping from X-OmniRoute-* headers, 503 no_active_models, image_gen via
 * the images dispatch — with stub dispatches (no HTTP).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b2-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b2-test-secret";

const { TASK_TYPES, TASK_TYPE_TO_QUERY, isTaskType } = await import(
  "../../../open-sse/services/modelTags/index.ts"
);
const { classifyRequestBody } = await import(
  "../../../open-sse/services/harness/classifier.ts"
);
const {
  buildCapabilityAliasCombo,
  CAPABILITY_ALIASES,
  CAPABILITY_ALIAS_BEST_SIZE,
} = await import("../../../open-sse/services/harness/capabilityAliases.ts");
const { orchestrateQuick } = await import("../../../open-sse/services/harness/quick.ts");

// ── plan: the Guide 2 Hermes contract string ────────────────────────────────

test("plan: first-class task type, alias, and classifier class", () => {
  assert.ok(isTaskType("plan"));
  assert.ok(TASK_TYPES.includes("plan"));
  assert.equal(TASK_TYPE_TO_QUERY.plan.category, undefined, "whole-registry ranking");
  assert.equal(TASK_TYPE_TO_QUERY.plan.axes[0], "gpqa");
  // Guide 2's capability reference — every string is a real alias now:
  // vision · image_gen · code · research · plan · chat
  for (const contract of ["vision", "code", "research", "plan", "chat"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CAPABILITY_ALIASES, contract) || contract === "image_gen",
      `contract string ${contract} exists`
    );
  }
  assert.ok(buildCapabilityAliasCombo("plan"), "plan alias resolves");
  assert.equal(classifyRequestBody({ messages: [{ role: "user", content: "break this down into a plan with milestones" }] }).type, "plan");
  assert.equal(classifyRequestBody({ messages: [{ role: "user", content: "decompose the migration into a roadmap" }] }).type, "plan");
});

// ── Budget tiers ────────────────────────────────────────────────────────────

test("budget: alias:best keeps only the top tier", () => {
  const best = buildCapabilityAliasCombo("code:best");
  assert.ok(best, "code:best resolves");
  assert.ok(best.models.length <= CAPABILITY_ALIAS_BEST_SIZE);
  // Top SWE-bench seed leads, same as plain code.
  const plain = buildCapabilityAliasCombo("code");
  assert.ok(plain);
  assert.equal(best.models[0].model, plain.models[0].model);

  // math:best on the math500 axis — the leading seeds (95+) only.
  const mathBest = buildCapabilityAliasCombo("math:best");
  assert.ok(mathBest);
  assert.ok(mathBest.models.length >= 2 && mathBest.models.length <= CAPABILITY_ALIAS_BEST_SIZE);
});

test("budget: alias:cheap keeps only fast-tier names, relaxing when empty", () => {
  const cheap = buildCapabilityAliasCombo("chat:cheap");
  assert.ok(cheap);
  const FAST = /(flash|mini|air|haiku|lite|nano|small|instant|turbo|fast|\d+b)/i;
  for (const step of cheap.models) {
    assert.match(step.model, FAST, `${step.model} is fast-tier`);
  }
  // Unknown tier suffix → NOT an alias (falls through to ordinary resolution).
  assert.equal(buildCapabilityAliasCombo("code:deluxe"), null);
  assert.equal(buildCapabilityAliasCombo("code:"), null);
  // Provider-prefixed strings never parse as budget aliases.
  assert.equal(buildCapabilityAliasCombo("openai/code:best"), null);
  // `any` is the same as the plain alias.
  const anyAlias = buildCapabilityAliasCombo("code:any");
  const plainAlias = buildCapabilityAliasCombo("code");
  assert.deepEqual(anyAlias?.models, plainAlias?.models);
});

test("budget: getComboForModel seam resolves plan and budget aliases", async () => {
  const { getComboForModel } = await import("../../../src/sse/services/model.ts");
  const plan = await getComboForModel("plan");
  assert.ok(plan, "plan resolves through the seam");
  assert.equal((plan as { _capabilityAlias?: boolean })._capabilityAlias, true);
  const best = await getComboForModel("math:best");
  assert.ok(best, "math:best resolves through the seam");
  assert.ok((best as { models: unknown[] }).models.length <= CAPABILITY_ALIAS_BEST_SIZE);
  assert.equal(await getComboForModel("plan:ultimate"), null);
});

// ── orchestrateQuick ────────────────────────────────────────────────────────

type Dispatch = (body: Record<string, unknown>) => Promise<{
  status: number;
  headers: Record<string, string>;
  json: unknown;
}>;

function okChatDispatch(capture?: Array<Record<string, unknown>>): Dispatch {
  return async (body) => {
    capture?.push(body);
    return {
      status: 200,
      headers: {
        "x-omniroute-model": "openai/gpt-5.6",
        "x-omniroute-provider": "openai",
        "x-omniroute-decision": JSON.stringify({ strategy: "priority", provider: "openai" }),
      },
      json: { model: "code", choices: [{ message: { role: "assistant", content: "here is the fix" } }] },
    };
  };
}

test("quick: happy path maps the guide response shape", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const result = await orchestrateQuick(
    { tag: "code", prompt: "fix the failing test" },
    { dispatchChat: okChatDispatch(captured), dispatchImages: async () => { throw new Error("unused"); } }
  );
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.model, "openai/gpt-5.6");
  assert.equal(result.payload.provider, "openai");
  assert.equal(result.payload.text, "here is the fix");
  assert.equal(typeof result.payload.latency_ms, "number");
  assert.equal((result.payload.score as number) >= 0 && (result.payload.score as number) <= 1, true);
  assert.deepEqual(result.payload.decision, { strategy: "priority", provider: "openai" });
  // Dispatched through the alias with stream forced off.
  assert.equal(captured[0].model, "code");
  assert.equal(captured[0].stream, false);
  assert.deepEqual(captured[0].messages, [
    { role: "user", content: "fix the failing test" },
  ]);
});

test("quick: budget rewrites the model to alias:budget", async () => {
  const captured: Array<Record<string, unknown>> = [];
  await orchestrateQuick(
    { tag: "math", prompt: "prove it", policy: { budget: "best" } },
    { dispatchChat: okChatDispatch(captured), dispatchImages: async () => { throw new Error("unused"); } }
  );
  assert.equal(captured[0].model, "math:best");
});

test("quick: images become vision content parts", async () => {
  const captured: Array<Record<string, unknown>> = [];
  await orchestrateQuick(
    { tag: "vision", prompt: "what is in this picture", images: ["data:image/png;base64,xx", "https://x/y.png"] },
    { dispatchChat: okChatDispatch(captured), dispatchImages: async () => { throw new Error("unused"); } }
  );
  const message = (captured[0].messages as Array<{ content: unknown }>)[0];
  assert.ok(Array.isArray(message.content));
  const parts = message.content as Array<{ type: string }>;
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
});

test("quick: validation errors are guide-shaped 400s", async () => {
  const dispatch = okChatDispatch();
  const result = await orchestrateQuick(
    { tag: "spreadsheets", prompt: "", policy: { budget: "deluxe" } },
    { dispatchChat: dispatch, dispatchImages: dispatch }
  );
  assert.equal(result.status, 400);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, "invalid_request");
  const details = result.payload.details as string[];
  assert.ok(details.some((d) => d.startsWith("tag ")));
  assert.ok(details.some((d) => d.startsWith("prompt ")));
  assert.ok(details.some((d) => d.includes("budget")));
});

test("quick: upstream 503 maps to no_active_models", async () => {
  const fail: Dispatch = async () => ({ status: 503, headers: {}, json: { error: { message: "all candidates failed" } } });
  const result = await orchestrateQuick(
    { tag: "vision", prompt: "describe" },
    { dispatchChat: fail, dispatchImages: fail }
  );
  assert.equal(result.status, 503);
  assert.deepEqual(result.payload, { ok: false, error: "no_active_models", tag: "vision" });
});

test("quick: dispatch throw maps to no_active_models, never a 500", async () => {
  const throwing: Dispatch = async () => {
    throw new Error("network gone");
  };
  const result = await orchestrateQuick(
    { tag: "code", prompt: "x" },
    { dispatchChat: throwing, dispatchImages: throwing }
  );
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, "no_active_models");
});

test("quick: image_gen dispatches the images API with the top specialist", async () => {
  const capturedImages: Array<Record<string, unknown>> = [];
  const result = await orchestrateQuick(
    { tag: "image_gen", prompt: "a red scarf hero" },
    {
      dispatchChat: async () => { throw new Error("unused"); },
      dispatchImages: async (body) => {
        capturedImages.push(body);
        return {
          status: 200,
          headers: {},
          json: { created: 1, data: [{ url: "https://img/1.png" }] },
        };
      },
    }
  );
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.ok(String(result.payload.model).includes("/"), "explicit image model id");
  assert.ok(Array.isArray(result.payload.images));
  assert.equal(capturedImages[0].prompt, "a red scarf hero");
  assert.equal(typeof capturedImages[0].model, "string");
});

test("quick: image_gen with no image models is a clean 503", async () => {
  // search-grounded tag that has candidates in the live index, so the image
  // dispatch is the distinguishing factor: use image_gen with a failing
  // images dispatch and verify the no_active_models shape.
  const fail: Dispatch = async () => ({ status: 503, headers: {}, json: null });
  const result = await orchestrateQuick(
    { tag: "image_gen", prompt: "x" },
    { dispatchChat: fail, dispatchImages: fail }
  );
  assert.equal(result.status, 503);
  assert.deepEqual(result.payload, { ok: false, error: "no_active_models", tag: "image_gen" });
});
