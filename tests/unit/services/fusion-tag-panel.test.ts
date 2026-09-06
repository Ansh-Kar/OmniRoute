/**
 * Fusion tag panels — end-to-end dispatch through the real combo engine.
 *
 * Fork(parallel-execution) coverage for `combo.config.panelFromTags`: a
 * fusion combo whose panel is resolved at dispatch time from the model tag
 * index must fan out to DISTINCT models across DISTINCT providers (the
 * fork's whole point), synthesize via the judge, and fall back to the
 * literal model list when the spec is malformed. Uses the LIVE provider
 * registry — the tag index is assembled from static build-time config, so
 * resolution is deterministic without network or DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-fusion-tags-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "fusion-tags-test-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { createComboSchema, updateComboSchema } = await import(
  "../../../src/shared/validation/schemas.ts"
);
const { buildFusionPanelFromTags, getModelTagIndex } = await import(
  "../../../open-sse/services/modelTags/index.ts"
);

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("fusion tag panel: fans out to distinct models across distinct providers", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`ans-${m}`);
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: {
      name: "tag-panel-fusion",
      strategy: "fusion",
      models: [],
      config: { panelFromTags: { category: "chat", size: 4, minBenchmark: 85 } },
    },
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);

  // The judge is the first panel member when unset, so total calls = panel + 1.
  const panel = seen.slice(0, -1);
  const judge = seen[seen.length - 1];
  assert.equal(panel.length, 4, `panel should have 4 members, saw ${JSON.stringify(seen)}`);
  assert.equal(judge, panel[0], "judge defaults to the first panel member");

  // Distinct models from distinct providers — the fork's core guarantee.
  assert.equal(new Set(panel).size, panel.length, "panel members must be distinct models");
  const providers = panel.map((m) => m.slice(0, m.indexOf("/")));
  assert.equal(new Set(providers).size, providers.length, "panel must span distinct providers");

  // Resolution is deterministic: the same spec must reproduce the same panel.
  const expected = buildFusionPanelFromTags(getModelTagIndex(), {
    category: "chat",
    size: 4,
    minBenchmark: 85,
  });
  assert.deepEqual(panel, expected.models);
});

test("fusion tag panel: malformed spec falls back to the literal model list", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`ans-${m}`);
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: {
      name: "malformed-tag-panel",
      strategy: "fusion",
      models: [{ model: "p/a" }],
      config: { panelFromTags: { category: "not-a-category", size: 4 } },
    },
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  // Single-member panel answers directly (nothing to fuse, no judge turn).
  assert.deepEqual(seen, ["p/a"]);
});

test("fusion tag panel: non-fusion strategy ignores panelFromTags", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`ans-${m}`);
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: {
      name: "priority-with-tag-panel",
      strategy: "priority",
      models: [{ model: "p/a" }],
      config: { panelFromTags: { category: "chat", size: 4 } },
    },
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["p/a"]);
});

// ── Schema: empty models allowed only with panelFromTags ────────────────────

test("schema: createComboSchema allows empty models only with panelFromTags", () => {
  const tagPanelCombo = {
    name: "tag-panel-combo",
    strategy: "fusion",
    models: [],
    config: { panelFromTags: { category: "coder", size: 4, minBenchmark: 80 } },
  };
  assert.equal(createComboSchema.safeParse(tagPanelCombo).success, true);

  const emptyWithoutTags = { name: "bad", strategy: "fusion", models: [] };
  const failed = createComboSchema.safeParse(emptyWithoutTags);
  assert.equal(failed.success, false);

  const badCategory = {
    name: "bad-category",
    strategy: "fusion",
    models: [],
    config: { panelFromTags: { category: "coding", size: 4 } },
  };
  assert.equal(createComboSchema.safeParse(badCategory).success, false);

  // Legacy shape (no panelFromTags, populated models) still parses.
  assert.equal(
    createComboSchema.safeParse({
      name: "legacy",
      strategy: "fusion",
      models: ["p/a"],
    }).success,
    true
  );
});

test("schema: updateComboSchema allows clearing models when panelFromTags rides along", () => {
  const clearing = {
    models: [],
    config: { panelFromTags: { category: "chat", size: 3 } },
  };
  assert.equal(updateComboSchema.safeParse(clearing).success, true);

  const clearingWithoutTags = { models: [] };
  assert.equal(updateComboSchema.safeParse(clearingWithoutTags).success, false);

  const leaving = { name: "renamed" };
  assert.equal(updateComboSchema.safeParse(leaving).success, true);
});
