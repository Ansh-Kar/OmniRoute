/**
 * Model tag index — taxonomy, inference, seeds, retrieval, panel building.
 *
 * Fork(parallel-execution) coverage for open-sse/services/modelTags. The
 * module under test is pure (no DB), so these tests build fixture indexes
 * instead of touching the live provider registry — the live assembly is
 * smoke-covered by fusion-tag-panel.test.ts through the real dispatcher.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  buildFusionPanelFromTags,
  buildModelTagIndex,
  findModelsByTags,
  inferModelCategories,
  isModelCategory,
  lookupBenchmarkSeed,
  parseTagPanelSpec,
  TAG_PANEL_MAX_SIZE,
} = await import("../../../open-sse/services/modelTags/index.ts");

// ── Taxonomy ────────────────────────────────────────────────────────────────

test("taxonomy: isModelCategory accepts the closed vocabulary, rejects junk", () => {
  for (const category of ["chat", "coder", "vision", "image-gen", "speech-to-text"]) {
    assert.equal(isModelCategory(category), true, category);
  }
  assert.equal(isModelCategory("coding"), false);
  assert.equal(isModelCategory(""), false);
  assert.equal(isModelCategory(null), false);
  assert.equal(isModelCategory(42), false);
});

// ── Category inference ──────────────────────────────────────────────────────

test("inference: media ids get their modality and lose the chat base", () => {
  assert.deepEqual(inferModelCategories("whisper-large-v3"), ["speech-to-text"]);
  assert.deepEqual(inferModelCategories("tts-1-hd"), ["text-to-speech"]);
  assert.deepEqual(inferModelCategories("gpt-image-2"), ["image-gen"]);
  assert.deepEqual(inferModelCategories("text-embedding-3-large"), ["embedding"]);
  assert.deepEqual(inferModelCategories("qwen3-vl-8b"), ["chat", "vision"]);
});

test("inference: capability flags overlay the chat base", () => {
  assert.deepEqual(
    inferModelCategories("some-model", { supportsVision: true, supportsReasoning: true }),
    ["chat", "reasoning", "vision"]
  );
  assert.deepEqual(inferModelCategories("kimi-k2.7-code"), ["chat", "coder"]);
  // Case-insensitive: registry ids may carry vendor casing.
  assert.deepEqual(inferModelCategories("Kimi-K2.7-Code"), ["chat", "coder"]);
});

test("inference: no false coder positive on substrings like 'encoder'", () => {
  assert.deepEqual(inferModelCategories("video-encoder-3000"), ["chat"]);
});

// ── Benchmark seeds ─────────────────────────────────────────────────────────

test("seeds: case-insensitive bare-id lookup, full-id fallback, null for unknown", () => {
  const coder = lookupBenchmarkSeed("coder", { model: "Kimi-K2.7-Code" });
  assert.ok(coder);
  assert.equal(coder.score, 88);
  const image = lookupBenchmarkSeed("image-gen", { model: "gpt-image-2", id: "openai/gpt-image-2" });
  assert.ok(image);
  assert.equal(image.score, 90);
  assert.equal(lookupBenchmarkSeed("coder", { model: "never-shipped-model" }), null);
  assert.equal(lookupBenchmarkSeed("upscale", { model: "anything" }), null);
});

// ── Index build ─────────────────────────────────────────────────────────────

function fixtureIndex() {
  return buildModelTagIndex(
    {
      anthropic: [
        {
          id: "claude-opus-5",
          toolCalling: true,
          supportsVision: true,
          contextLength: 200000,
        },
      ],
      openai: [{ id: "gpt-5.6", supportsReasoning: true, contextLength: 400000 }],
      moonshot: [{ id: "kimi-k2.7-code", toolCalling: true }],
      relay: [{ id: "claude-opus-5", toolCalling: true, supportsVision: true }],
    },
    [
      {
        id: "openai/gpt-image-2",
        provider: "openai",
        model: "gpt-image-2",
        category: "image-gen",
      },
    ]
  );
}

test("index: builds categories, provider buckets and lookups", () => {
  const index = fixtureIndex();
  assert.deepEqual(
    (index.byCategory.get("coder") ?? []).map((e) => e.id),
    ["moonshot/kimi-k2.7-code"]
  );
  assert.deepEqual(
    (index.byCategory.get("vision") ?? []).map((e) => e.model).sort(),
    ["claude-opus-5", "claude-opus-5"]
  );
  assert.deepEqual(
    (index.byCategory.get("image-gen") ?? []).map((e) => e.id),
    ["openai/gpt-image-2"]
  );
  assert.equal(index.lookup("openai/gpt-5.6")?.model, "gpt-5.6");
  assert.equal(index.lookup("kimi-k2.7-code")?.provider, "moonshot");
  assert.equal(index.lookup("nope/nope"), undefined);
});

// ── Retrieval ───────────────────────────────────────────────────────────────

test("retrieval: minBenchmark floors out unscored models", () => {
  const index = fixtureIndex();
  const coders = findModelsByTags(index, { category: "coder", minBenchmark: 80 });
  assert.deepEqual(coders.map((e) => e.id), ["moonshot/kimi-k2.7-code"]);
  // Without a floor the unscored coder still shows up (no evidence ≠ absent).
  const all = findModelsByTags(index, { category: "coder" });
  assert.equal(all.length, 1);
});

test("retrieval: distinctModels collapses relays onto the canonical provider", () => {
  const index = fixtureIndex();
  const distinct = findModelsByTags(index, { distinctModels: true });
  const opus = distinct.filter((e) => e.model === "claude-opus-5");
  assert.deepEqual(opus.map((e) => e.provider), ["anthropic"]);
});

test("retrieval: capability and context filters compose", () => {
  const index = fixtureIndex();
  assert.deepEqual(
    findModelsByTags(index, { requireTools: true }).map((e) => e.model).sort(),
    ["claude-opus-5", "claude-opus-5", "kimi-k2.7-code"]
  );
  assert.deepEqual(
    findModelsByTags(index, { minContextLength: 300000 }).map((e) => e.model),
    ["gpt-5.6"]
  );
  assert.deepEqual(
    findModelsByTags(index, { provider: "moonshot" }).map((e) => e.model),
    ["kimi-k2.7-code"]
  );
});

test("retrieval: scoreLookup overrides seeds and is marked runtime", () => {
  const index = buildModelTagIndex(
    { moonshot: [{ id: "kimi-k2.7-code" }] },
    [],
    {
      scoreLookup: (category) => (category === "chat" ? 42 : null),
    }
  );
  const entry = index.lookup("moonshot/kimi-k2.7-code");
  assert.ok(entry?.benchmark);
  assert.equal(entry.benchmark.score, 42);
  assert.equal(entry.benchmark.source, "runtime");
});

test("retrieval: diverseProviders round-robins across providers", () => {
  const index = buildModelTagIndex({
    a: [{ id: "m1" }, { id: "m2" }],
    b: [{ id: "m3" }],
  });
  const order = findModelsByTags(index, { diverseProviders: true }).map((e) => e.model);
  assert.deepEqual(order, ["m1", "m3", "m2"]);
});

// ── Fusion panel construction ───────────────────────────────────────────────

test("panel: distinct models from distinct providers, size clamped", () => {
  const index = buildModelTagIndex({
    a: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    b: [{ id: "m4" }, { id: "m5" }],
    c: [{ id: "m6" }],
  });
  const panel = buildFusionPanelFromTags(index, { category: "chat", size: 100 });
  assert.equal(panel.requestedSize, TAG_PANEL_MAX_SIZE);
  // perProvider defaults to 1 — a HARD cap. Three providers ⇒ three members,
  // one best model each, even though 40 were requested.
  assert.deepEqual(panel.models, ["a/m1", "b/m4", "c/m6"]);
  assert.equal(panel.truncated, true);
  assert.equal(new Set(panel.models).size, panel.models.length);

  // Raising perProvider lets one provider contribute more distinct models.
  const wider = buildFusionPanelFromTags(index, {
    category: "chat",
    size: 100,
    perProvider: 2,
  });
  assert.deepEqual(wider.models, ["a/m1", "b/m4", "c/m6", "a/m2", "b/m5"]);
  assert.equal(wider.truncated, true);
});

test("panel: perProvider caps same-provider picks; size 1 clamps to 2", () => {
  const index = buildModelTagIndex({
    a: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }],
  });
  const capped = buildFusionPanelFromTags(index, {
    category: "chat",
    size: 4,
    perProvider: 2,
  });
  assert.deepEqual(capped.models, ["a/m1", "a/m2"]);
  assert.equal(capped.truncated, true);
  const tiny = buildFusionPanelFromTags(index, { category: "chat", size: 1 });
  assert.equal(tiny.requestedSize, 2);
});

test("panel: providers allowlist and excludeProviders", () => {
  const index = buildModelTagIndex({
    a: [{ id: "m1" }],
    b: [{ id: "m2" }],
    c: [{ id: "m3" }],
  });
  assert.deepEqual(
    buildFusionPanelFromTags(index, {
      category: "chat",
      size: 2,
      providers: ["a", "c"],
    }).models.sort(),
    ["a/m1", "c/m3"]
  );
  assert.deepEqual(
    buildFusionPanelFromTags(index, {
      category: "chat",
      size: 2,
      excludeProviders: ["a"],
    }).models.sort(),
    ["b/m2", "c/m3"]
  );
});

// ── panelFromTags parsing ───────────────────────────────────────────────────

test("parseTagPanelSpec: accepts and coerces, rejects junk", () => {
  assert.deepEqual(
    parseTagPanelSpec({ category: "vision", size: "4", minBenchmark: "70" }),
    { category: "vision", size: 4, minBenchmark: 70 }
  );
  assert.deepEqual(parseTagPanelSpec({ category: "coder" }), { category: "coder" });
  assert.equal(parseTagPanelSpec({ category: "nope" }), null);
  assert.equal(parseTagPanelSpec({ size: 4 }), null);
  assert.equal(parseTagPanelSpec(null), null);
  assert.equal(parseTagPanelSpec("coder"), null);
  assert.deepEqual(
    parseTagPanelSpec({
      category: "chat",
      providers: ["a", "", 3],
      excludeProviders: ["b"],
      requireTools: true,
    }),
    { category: "chat", providers: ["a"], excludeProviders: ["b"], requireTools: true }
  );
});
