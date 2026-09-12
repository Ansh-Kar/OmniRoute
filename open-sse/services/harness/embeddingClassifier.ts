/**
 * Embedding classifier (harness Layer 3, build B14) — the classifier's
 * stage 1.5. Embeds the request text via the provider /v1/embeddings
 * surface and matches it against per-task-type EXEMPLAR CENTROIDS:
 * nearest centroid wins when the margin is decisive.
 *
 * Why this shape:
 * - The classifier ladder stays cheapest-first: heuristics (free) →
 *   embeddings (one cheap non-generative call, cache-friendly) → model
 *   (one cheap generative call). Embeddings sit BEFORE the model stage.
 * - Same contract as every classifier stage: REFINE only, never break.
 *   Every failure path returns null and the caller degrades downward.
 * - Body-shape facts (vision/audio content) are decided by stage 1 and
 *   never re-decided here; media types (image_gen, audio_speech,
 *   music_gen, video_gen, vision) are NOT embedding-classifiable.
 * - Centroids live in the EMBEDDING MODEL's vector space, so they are
 *   cached PER MODEL (a model switch rebuilds) with the same 6h freshness
 *   discipline as the B13 registry. Request-text vectors get a small LRU
 *   so repeated classifications of the same prompt cost zero calls.
 *
 * Pure module: the embedding source is an injected `EmbedFn` (the route
 * side wires it to OmniRoute's own /v1/embeddings via self-fetch, which
 * runs the FULL native pipeline — provider selection, failover, keys).
 */

import type { TaskType } from "../modelTags/index.ts";

/** The result of one embedding-source call. `model` identifies the vector
 *  space (centroids and vectors are only comparable within one model). */
export type EmbedResult = { model: string; vectors: number[][] } | null;
export type EmbedFn = (texts: string[]) => Promise<EmbedResult>;

/** Task types decided by TEXT SEMANTICS. Media/body-shape types (vision,
 *  image_gen, audio_speech, music_gen, video_gen) are excluded on purpose:
 *  stage 1's body-shape rules are authoritative for them. */
export const EMBEDDING_CLASSIFIABLE_TYPES = [
  "code",
  "research",
  "math",
  "reasoning",
  "plan",
  "search",
  "chat",
] as const satisfies readonly TaskType[];

export type EmbeddingClassifiableType = (typeof EMBEDDING_CLASSIFIABLE_TYPES)[number];

/**
 * Exemplar prompts per type — the classifier's semantic anchor set. Short,
 * canonical phrasings; embedding-averaged into one centroid per type.
 * (Never seen by the keyword heuristics — a different information source
 * by construction, which is exactly why the two stages disagree usefully.)
 */
export const EMBEDDING_EXEMPLARS: Record<EmbeddingClassifiableType, string[]> = {
  code: [
    "fix the failing unit test in the auth module",
    "write a python function that parses a csv file",
    "why does this stack trace point to a null pointer",
    "refactor this class into smaller functions",
    "add docker support to the repository",
    "write a sql query to join users and orders",
    "review this typescript pull request",
  ],
  research: [
    "survey the literature on transformer efficiency",
    "compare the trade-offs of sql and nosql databases",
    "deep dive analysis of the electric vehicle market",
    "state of the art in protein folding prediction",
    "evaluate the evidence on intermittent fasting",
    "write a literature review of federated learning",
    "summarize the research on sleep and memory",
  ],
  math: [
    "prove the intermediate value theorem",
    "compute the eigenvalues of this matrix",
    "solve the integral of x squared times e to the x",
    "what is the probability of drawing two aces",
    "derive the derivative of the natural log of sine x",
    "explain the proof of fermat's little theorem",
    "calculate the determinant of a 3 by 3 matrix",
  ],
  reasoning: [
    "solve this logic puzzle about three switches and one bulb",
    "if all bloops are razzies and some razzies are lazzies can a bloop be a lazzie",
    "think through the paradox of these two statements",
    "which box weighs the most given these clues",
    "deduce the suspect from these witness statements",
    "reason carefully about the twelve coins weighing problem",
    "what can we infer from these premises",
  ],
  plan: [
    "break the project down into milestones and tasks",
    "create a roadmap for learning rust in three months",
    "plan the migration of our monolith to microservices",
    "decompose this feature into implementable tasks",
    "design a work breakdown structure for the event",
    "outline the steps to launch a podcast",
    "make a step-by-step plan to renovate a kitchen",
  ],
  search: [
    "what is the latest news on the election today",
    "current price of bitcoin this week",
    "weather forecast for tomorrow right now",
    "who won the match yesterday",
    "look up the newest version of node js",
    "breaking news about the merger",
    "what happened in the stock market this morning",
  ],
  chat: [
    "hey how are you doing today",
    "write a warm thank you note to my teacher",
    "tell me something about yourself",
    "help me draft a friendly out of office reply",
    "what is your favorite way to spend a weekend",
    "rewrite this paragraph to sound more polite",
    "give me a fun fact to share at dinner",
  ],
};

/** Match thresholds. A verdict needs BOTH enough absolute similarity
 *  (else the text is unlike anything we know) AND a decisive margin over
 *  the runner-up (else the verdict is a coin flip and the heuristic
 *  default is more honest). */
export const EMBEDDING_MIN_SIMILARITY = 0.3;
export const EMBEDDING_MIN_MARGIN = 0.03;
export const EMBEDDING_HIGH_MARGIN = 0.08;

export type EmbeddingMatch = {
  type: EmbeddingClassifiableType;
  similarity: number;
  margin: number;
  runnerUp: EmbeddingClassifiableType | null;
};

// ── Vector math ─────────────────────────────────────────────────────────────

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** Mean of the vectors, L2-normalized (the unit centroid). Zero-safe:
 *  a degenerate centroid (all-zero mean) returns the zero vector, which
 *  cosines to 0 against everything and can never win a match. */
export function buildCentroid(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const mean = new Array<number>(dim).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dim) continue;
    for (let i = 0; i < dim; i++) mean[i]! += vector[i]!;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) mean[i]! /= vectors.length;
  for (let i = 0; i < dim; i++) norm += mean[i]! * mean[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return mean;
  return mean.map((value) => value / norm);
}

// ── Caches (module-local; clearable for tests) ──────────────────────────────

const CENTROID_TTL_MS = 6 * 60 * 60 * 1000; // matches the B13 registry freshness discipline
const VECTOR_CACHE_MAX = 256;

type CachedCentroids = { model: string; centroids: Record<string, number[]>; builtAt: number };
const centroidCache = new Map<string, CachedCentroids>();
const centroidBuilds = new Map<string, Promise<CachedCentroids | null>>();
const vectorCache = new Map<string, { model: string; vector: number[] }>();

/** Test hook: reset all caches (module state is per-process). */
export function clearEmbeddingClassifierCaches(): void {
  centroidCache.clear();
  centroidBuilds.clear();
  vectorCache.clear();
}

async function buildCentroidsFor(embed: EmbedFn): Promise<CachedCentroids | null> {
  const texts: string[] = [];
  for (const type of EMBEDDING_CLASSIFIABLE_TYPES) {
    for (const exemplar of EMBEDDING_EXEMPLARS[type]) texts.push(exemplar);
  }
  const result = await embed(texts);
  if (!result || result.vectors.length !== texts.length) return null;
  const centroids: Record<string, number[]> = {};
  let index = 0;
  for (const type of EMBEDDING_CLASSIFIABLE_TYPES) {
    const group: number[][] = [];
    for (let j = 0; j < EMBEDDING_EXEMPLARS[type].length; j++, index++) {
      const vector = result.vectors[index];
      if (Array.isArray(vector) && vector.length > 0) group.push(vector);
    }
    if (group.length > 0) centroids[type] = buildCentroid(group);
  }
  if (Object.keys(centroids).length === 0) return null;
  return { model: result.model, centroids, builtAt: Date.now() };
}

async function centroidsFor(
  embed: EmbedFn,
  model: string,
  nowMs: () => number
): Promise<CachedCentroids | null> {
  const cached = centroidCache.get(model);
  if (cached && nowMs() - cached.builtAt < CENTROID_TTL_MS) return cached;
  // In-flight dedupe: concurrent low-confidence classifications share one build.
  let build = centroidBuilds.get(model);
  if (!build) {
    build = buildCentroidsFor(embed).then((built) => {
      centroidBuilds.delete(model);
      if (built) centroidCache.set(built.model, built);
      return built;
    });
    centroidBuilds.set(model, build);
  }
  return build;
}

function cachedVector(text: string): { model: string; vector: number[] } | undefined {
  const hit = vectorCache.get(text);
  if (hit) {
    // LRU refresh: re-insert so the recency order updates.
    vectorCache.delete(text);
    vectorCache.set(text, hit);
  }
  return hit;
}

// ── The matcher ─────────────────────────────────────────────────────────────

/**
 * Match a request text against the exemplar centroids. Never throws —
 * every failure is null and the classifier degrades to its next stage.
 *
 * Flow: embed the request text (cache-friendly) → resolve centroids for
 * the model that answered → nearest centroid with a decisive margin. The
 * model identity is only known AFTER the first embed, so a model switch
 * between the text embed and the centroid build is guarded (null).
 */
export async function matchByEmbedding(
  text: string,
  embed: EmbedFn,
  nowMs: () => number = Date.now
): Promise<EmbeddingMatch | null> {
  try {
    const trimmed = text.trim().slice(0, 8_000);
    if (!trimmed) return null;

    // 1) Embed the request text (LRU-cached; re-embed if the cached vector
    //    came from a different model than the one that ends up answering).
    let embedded = cachedVector(trimmed);
    if (!embedded) {
      const result = await embed([trimmed]);
      if (!result || result.vectors.length !== 1) return null;
      const vector = result.vectors[0]!;
      if (vector.length === 0) return null;
      embedded = { model: result.model, vector };
      vectorCache.set(trimmed, embedded);
      if (vectorCache.size > VECTOR_CACHE_MAX) {
        const oldest = vectorCache.keys().next().value;
        if (oldest !== undefined) vectorCache.delete(oldest);
      }
    }

    // 2) Centroids for THAT model's vector space (per-model cache, 6h TTL).
    const centroids = await centroidsFor(embed, embedded.model, nowMs);
    if (!centroids) return null;
    if (centroids.model !== embedded.model) return null; // model raced — retry next call

    // 3) Nearest centroid with a decisive margin.
    const ranked: Array<{ type: EmbeddingClassifiableType; similarity: number }> = [];
    for (const type of EMBEDDING_CLASSIFIABLE_TYPES) {
      const centroid = centroids.centroids[type];
      if (!centroid || centroid.length === 0) continue;
      const similarity = cosineSimilarity(embedded.vector, centroid);
      if (Number.isFinite(similarity)) ranked.push({ type, similarity });
    }
    if (ranked.length === 0) return null;
    ranked.sort((a, b) => b.similarity - a.similarity);
    const top = ranked[0]!;
    const runnerUp = ranked[1] ?? null;
    if (top.similarity < EMBEDDING_MIN_SIMILARITY) return null; // unlike anything we know
    const margin = top.similarity - (runnerUp?.similarity ?? 0);
    if (margin < EMBEDDING_MIN_MARGIN) return null; // ambiguous — keep the heuristic verdict
    return { type: top.type, similarity: top.similarity, margin, runnerUp: runnerUp?.type ?? null };
  } catch {
    return null; // the classifier must never break on the embedding source
  }
}
