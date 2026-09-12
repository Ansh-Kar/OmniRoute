/**
 * Harness B14 — the embeddings classifier stage: exemplar centroids,
 * cosine matching with margin discipline, the cheapest-first ladder
 * (heuristics → embeddings → model), per-model centroid caching, the
 * request-text LRU, and the never-break failure contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b14-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b14-test-secret";

import {
  EMBEDDING_CLASSIFIABLE_TYPES,
  EMBEDDING_EXEMPLARS,
  buildCentroid,
  clearEmbeddingClassifierCaches,
  cosineSimilarity,
  matchByEmbedding,
  type EmbedFn,
} from "../../../open-sse/services/harness/embeddingClassifier.ts";
import { classifyRequestBody, classifyRequest } from "../../../open-sse/services/harness/classifier.ts";

type Body = Record<string, unknown>;

// ── The fake embedding source: one basis axis per type ─────────────────────
// Exemplar texts map to their type's axis; any other text maps to the
// test-controlled `requestVector`. Deterministic geometry, no network.

const AXES: Record<string, number[]> = {
  code: [1, 0, 0, 0, 0, 0, 0],
  research: [0, 1, 0, 0, 0, 0, 0],
  math: [0, 0, 1, 0, 0, 0, 0],
  reasoning: [0, 0, 0, 1, 0, 0, 0],
  plan: [0, 0, 0, 0, 1, 0, 0],
  search: [0, 0, 0, 0, 0, 1, 0],
  chat: [0, 0, 0, 0, 0, 0, 1],
};

const exemplarTypeByText = new Map<string, string>();
for (const type of EMBEDDING_CLASSIFIABLE_TYPES) {
  for (const text of EMBEDDING_EXEMPLARS[type]) exemplarTypeByText.set(text, type);
}

let requestVector: number[] = AXES.code!;

function fakeEmbed(model = "fake-embed"): EmbedFn & { calls: number; texts: number } {
  let calls = 0;
  let texts = 0;
  const fn = async (batch: string[]): Promise<{ model: string; vectors: number[][] } | null> => {
    calls += 1;
    texts += batch.length;
    return { model, vectors: batch.map((text) => (exemplarTypeByText.has(text) ? AXES[exemplarTypeByText.get(text)!]! : requestVector).slice()) };
  };
  // Object.assign would snapshot getter VALUES (always 0) — install live
  // getters on the function instead.
  Object.defineProperty(fn, "calls", { get: () => calls, enumerable: true });
  Object.defineProperty(fn, "texts", { get: () => texts, enumerable: true });
  return fn as EmbedFn & { calls: number; texts: number };
}

function chatBody(text: string, extra: Body = {}): Body {
  return { messages: [{ role: "user", content: text }], ...extra };
}

/** A prompt the keyword heuristics score ZERO on — low confidence, the
 *  exact case the embeddings stage exists for. */
const VAGUE = "hey so about that thing from before";

// ── Exemplar integrity ──────────────────────────────────────────────────────

test("exemplars: every classifiable type has >=6 unique non-empty exemplars", () => {
  assert.deepEqual([...EMBEDDING_CLASSIFIABLE_TYPES], ["code", "research", "math", "reasoning", "plan", "search", "chat"]);
  const seen = new Set<string>();
  for (const type of EMBEDDING_CLASSIFIABLE_TYPES) {
    const exemplars = EMBEDDING_EXEMPLARS[type];
    assert.ok(exemplars.length >= 6, `${type} needs >=6 exemplars (has ${exemplars.length})`);
    for (const exemplar of exemplars) {
      assert.ok(typeof exemplar === "string" && exemplar.trim().length > 5, `${type}: thin exemplar "${exemplar}"`);
      assert.ok(!seen.has(exemplar), `duplicate exemplar across types: "${exemplar}"`);
      seen.add(exemplar);
    }
  }
  // Media/body-shape types are NEVER embedding-classifiable.
  for (const excluded of ["vision", "image_gen", "audio_speech", "music_gen", "video_gen"]) {
    assert.ok(!(EMBEDDING_CLASSIFIABLE_TYPES as readonly string[]).includes(excluded));
  }
});

// ── Vector math ─────────────────────────────────────────────────────────────

test("math: cosine + centroid (mean, L2-normalized, zero-safe)", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-12, "orthogonal → 0");
  assert.ok(Math.abs(cosineSimilarity([2, 0], [5, 0]) - 1) < 1e-12, "parallel → 1");
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0, "dimension mismatch → 0");
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, "zero vector → 0");
  assert.deepEqual(buildCentroid([[3, 0], [4, 0]]), [1, 0], "mean 3.5 → unit");
  assert.deepEqual(buildCentroid([[0, 2], [0, -2]]), [0, 0], "degenerate mean → zero vector, never NaN");
  assert.deepEqual(buildCentroid([]), [], "empty → empty");
});

// ── Matching: winner / ambiguity / out-of-distribution ─────────────────────

test("match: decisive winner → {type, similarity, margin, runnerUp}", async () => {
  clearEmbeddingClassifierCaches();
  requestVector = [0.95, 0.05, 0, 0, 0, 0, 0]; // strongly code-ish
  const match = await matchByEmbedding("classify me please", fakeEmbed());
  assert.ok(match);
  assert.equal(match.type, "code");
  assert.ok(match.similarity > 0.98);
  assert.equal(match.runnerUp, "research", "second-highest axis is research (index 1)");
  assert.ok(match.margin > 0.08, "high-margin band");
});

test("match: ambiguous between two types → null (heuristic verdict is more honest)", async () => {
  clearEmbeddingClassifierCaches();
  requestVector = [1, 0, 1, 0, 0, 0, 0].map((v) => v / Math.SQRT2); // code == math
  assert.equal(await matchByEmbedding("classify me please", fakeEmbed()), null);
});

test("match: unlike anything (orthogonal / foreign dimension) → null", async () => {
  clearEmbeddingClassifierCaches();
  requestVector = [0, 0, 0, 0, 0, 0, 0, 1]; // 8-dim — no 7-dim axis matches
  assert.equal(await matchByEmbedding("classify me please", fakeEmbed()), null);
  requestVector = [0, 0, 0, 0, 0, 0, 0]; // zero vector
  assert.equal(await matchByEmbedding("classify me please", fakeEmbed()), null);
});

// ── The ladder inside classifyRequest ───────────────────────────────────────

test("ladder: low-confidence + decisive embedding → stage 'embeddings'", async () => {
  clearEmbeddingClassifierCaches();
  requestVector = [0.95, 0.05, 0, 0, 0, 0, 0];
  assert.equal(classifyRequestBody(chatBody(VAGUE)).confidence, "low", "fixture must be low-confidence");
  const result = await classifyRequest(chatBody(VAGUE), { embed: fakeEmbed() });
  assert.equal(result.stage, "embeddings");
  assert.equal(result.type, "code");
  assert.equal(result.alias, "code");
  assert.equal(result.confidence, "high");
  assert.match(result.reason, /embedding match: code \(cos (0\.9\d+|1\.00), margin 0\.9\d+ vs research\)/);
});

test("ladder: medium band — smaller margin yields confidence 'medium'", async () => {
  clearEmbeddingClassifierCaches();
  const norm = Math.hypot(0.62, 0.58);
  requestVector = [0, 0, 0, 0, 0.62 / norm, 0.58 / norm, 0]; // plan vs search, margin ≈ 0.047
  const result = await classifyRequest(chatBody(VAGUE), { embed: fakeEmbed() });
  assert.equal(result.stage, "embeddings");
  assert.equal(result.type, "plan");
  assert.equal(result.confidence, "medium");
});

test("ladder: embeddings BEFORE the model stage; a match skips the model call", async () => {
  clearEmbeddingClassifierCaches();
  requestVector = AXES.math!;
  let modelCalls = 0;
  const dispatch = async () => {
    modelCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"chat"}' } }] }), { status: 200 });
  };
  const result = await classifyRequest(chatBody(VAGUE), { embed: fakeEmbed(), dispatch });
  assert.equal(result.stage, "embeddings", "embeddings wins, model not consulted");
  assert.equal(modelCalls, 0);

  // Embedding source unavailable → degrades DOWN to the model stage.
  clearEmbeddingClassifierCaches();
  const fellThrough = await classifyRequest(chatBody(VAGUE), { embed: async () => null, dispatch });
  assert.equal(fellThrough.stage, "model", "null embed → stage 2 runs");
  assert.equal(modelCalls, 1);
});

test("ladder: high-confidence heuristics and body-shape vision NEVER embed", async () => {
  clearEmbeddingClassifierCaches();
  const embed = fakeEmbed();
  const strong = await classifyRequest(chatBody("fix the python bug in the regex"), { embed });
  assert.equal(strong.stage, "heuristics");
  assert.equal(embed.calls, 0, "keyword-strong request: zero embedding calls");

  const vision = await classifyRequest(
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }, { type: "text", text: "hmm" }] }] },
    { embed }
  );
  assert.equal(vision.type, "vision");
  assert.equal(embed.calls, 0, "body-shape vision: zero embedding calls");
});

test("ladder: throwing embed degrades to heuristics, never errors", async () => {
  clearEmbeddingClassifierCaches();
  const boom = (async () => {
    throw new Error("provider exploded");
  }) as EmbedFn;
  const result = await classifyRequest(chatBody(VAGUE), { embed: boom });
  assert.equal(result.stage, "heuristics");
  assert.equal(result.type, "chat");
});

// ── Caches ──────────────────────────────────────────────────────────────────

test("caches: exemplars embedded once per model; repeated request text hits the LRU", async () => {
  clearEmbeddingClassifierCaches();
  const embed = fakeEmbed();
  requestVector = AXES.search!;
  const exemplarCount = EMBEDDING_CLASSIFIABLE_TYPES.reduce((sum, type) => sum + EMBEDDING_EXEMPLARS[type].length, 0);

  await matchByEmbedding("first vague text", embed);
  assert.equal(embed.texts, exemplarCount + 1, "centroid batch + the request text");

  await matchByEmbedding("first vague text", embed);
  assert.equal(embed.texts, exemplarCount + 1, "same text + fresh centroids → zero new calls");

  await matchByEmbedding("second vague text", embed);
  assert.equal(embed.texts, exemplarCount + 2, "new text → one call; exemplars still cached");

  // A DIFFERENT model = a different vector space = centroids rebuilt.
  await matchByEmbedding("first vague text", fakeEmbed("other-embed"));
  const other = EMBEDDING_CLASSIFIABLE_TYPES.reduce((sum, type) => sum + EMBEDDING_EXEMPLARS[type].length, 0);
  assert.equal(other, exemplarCount, "sanity: exemplar count is stable");
});

test("caches: model race between text embed and centroid build → null, not garbage", async () => {
  clearEmbeddingClassifierCaches();
  requestVector = AXES.code!;
  let call = 0;
  const racing = async (texts: string[]) => {
    call += 1;
    const model = call === 1 ? "m1" : "m2"; // text embedded as m1, exemplars as m2
    return { model, vectors: texts.map((text) => (exemplarTypeByText.has(text) ? AXES[exemplarTypeByText.get(text)!]! : requestVector).slice()) };
  };
  assert.equal(await matchByEmbedding("vague", racing), null, "mismatched vector spaces never match");
});
