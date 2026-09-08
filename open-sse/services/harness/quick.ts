/**
 * /v1/orchestrate/quick — single delegated task, synchronous (harness B2,
 * Guide 1 Part 6). The brain (Guide 2) names a CAPABILITY TAG, never a
 * model; this service resolves the tag to a capability alias, executes
 * through the existing chat/media pipeline via an injected dispatch, and
 * returns the guide's response shape:
 *
 *   {ok, model, provider, text, latency_ms, score, decision}
 *   503 → {ok: false, error: "no_active_models", tag}
 *
 * Everything routes through the native pipeline (admission, alias→priority
 * combo failover, breakers, translation, idempotency replay) — this module
 * only maps shapes. `image_gen` is the one non-chat tag: it resolves the
 * tag index's best image-gen specialist and dispatches the images API
 * (single explicit model in B2; the B3 allocator brings image failover).
 */

import {
  findModelsByTags,
  getModelTagIndex,
  isTaskType,
  TASK_TYPE_TO_QUERY,
  type TaskType,
} from "../modelTags/index.ts";

export type QuickBudget = "any" | "best" | "cheap";

export type QuickBody = {
  /** Capability tag — Guide 2's exact vocabulary, never a model id. */
  tag: string;
  /** Self-contained prompt (workers do not see the caller's conversation). */
  prompt: string;
  /** Optional image inputs (vision tag): URLs or base64 data URIs. */
  images?: string[];
  policy?: {
    budget?: string;
    /**
     * Guide 2 delegation contract: "On 503 for a tag: retry once after 20s;
     * if still 503, tell the user honestly." Fork-side, opt-in: when the
     * dispatch exhausts every candidate (the honest 503), wait this many
     * milliseconds and retry ONCE. 0 (default) = fail immediately.
     */
    retry_503_after_ms?: number;
  };
};

export type QuickDispatchResult = {
  status: number;
  headers: Record<string, string>;
  json: unknown | null;
};

export type QuickOptions = {
  /** POST a chat-shaped body; returns the upstream status/headers/JSON. */
  dispatchChat: (body: Record<string, unknown>) => Promise<QuickDispatchResult>;
  /** POST an images-generations body; same contract. */
  dispatchImages: (body: Record<string, unknown>) => Promise<QuickDispatchResult>;
  /** Test seam: the Guide-2 retry wait (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
};

export type QuickResult = {
  status: number;
  payload: Record<string, unknown>;
};

const BUDGETS: ReadonlySet<string> = new Set(["any", "best", "cheap"]);

function invalid(details: string[]): QuickResult {
  return { status: 400, payload: { ok: false, error: "invalid_request", details } };
}

function noActiveModels(tag: string, retried = false): QuickResult {
  return {
    status: 503,
    payload: { ok: false, error: "no_active_models", tag, ...(retried ? { retried: true } : {}) },
  };
}

/** Guide 2 capability reference ↔ B1 task types (image_gen included). */
function tagToAlias(tag: TaskType): string {
  return tag;
}

function parseDecisionHeader(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 0..1 axis score of the served model, for the tag's ranking axis. */
function scoreForModel(modelId: string | null, tag: TaskType): number | null {
  if (!modelId) return null;
  const index = getModelTagIndex();
  const entry = index.lookup(modelId);
  if (!entry) return null;
  const axis = TASK_TYPE_TO_QUERY[tag]?.axes?.[0];
  const score = axis ? entry.axes?.[axis]?.score : undefined;
  if (typeof score === "number") return Math.round((score / 100) * 1000) / 1000;
  if (entry.benchmark) return Math.round((entry.benchmark.score / 100) * 1000) / 1000;
  return null;
}

export async function orchestrateQuick(
  body: QuickBody,
  options: QuickOptions
): Promise<QuickResult> {
  // ── Validation (guide Part 6: per-field errors for one corrected re-emit) ──
  if (!body || typeof body !== "object") return invalid(["body must be an object"]);
  const details: string[] = [];
  if (!isTaskType(body.tag)) details.push(`tag must be one of: code, research, math, reasoning, plan, vision, search, chat, image_gen`);
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0)
    details.push("prompt must be a non-empty string");
  const budgetRaw = body.policy?.budget ?? "any";
  if (!BUDGETS.has(budgetRaw)) details.push(`policy.budget must be one of: any, best, cheap (got "${budgetRaw}")`);
  if (body.images !== undefined && (!Array.isArray(body.images) || body.images.some((i) => typeof i !== "string")))
    details.push("images must be an array of strings (URLs or data URIs)");
  const retryRaw = Number(body.policy?.retry_503_after_ms ?? 0);
  if (!Number.isFinite(retryRaw) || retryRaw < 0)
    details.push(`policy.retry_503_after_ms must be a non-negative number (got ${String(body.policy?.retry_503_after_ms)})`);
  if (details.length > 0) return invalid(details);

  const tag = body.tag as TaskType;
  const budget = budgetRaw as QuickBudget;
  const prompt = body.prompt;
  // Guide 2 delegation contract, fork-side: one retry after this wait when
  // the tag's candidates exhaust (the honest 503). 0 = fail immediately.
  const retryMs = Math.min(120_000, Math.floor(retryRaw));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // ── image_gen: resolve the best image specialist, dispatch the images API ──
  if (tag === "image_gen") {
    const index = getModelTagIndex();
    let candidates = findModelsByTags(index, {
      category: "image-gen",
      distinctModels: true,
      diverseProviders: true,
      limit: 4,
    });
    if (budget === "cheap") {
      const fastTier = candidates.filter((entry) =>
        /(flash|mini|lite|nano|turbo|fast|\b1\.5\b|\d+b\b)/i.test(entry.model)
      );
      if (fastTier.length > 0) candidates = fastTier;
    }
    const chosen = candidates[0]; // top-ranked (cheap pre-filter applied above)
    if (!chosen) return noActiveModels(tag);
    const started = Date.now();
    let retried = false;
    let result: QuickDispatchResult | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await options.dispatchImages({ model: chosen.id, prompt, n: 1 });
      } catch {
        result = null;
      }
      if (result && result.status === 200) break;
      if (attempt === 0 && retryMs > 0) {
        retried = true;
        await sleep(retryMs);
        continue;
      }
      break;
    }
    const latencyMs = Date.now() - started;
    if (!result || result.status !== 200) return noActiveModels(tag, retried);
    const json = (result.json ?? {}) as { data?: unknown[] };
    return {
      status: 200,
      payload: {
        ok: true,
        model: chosen.id,
        provider: chosen.provider,
        text: null,
        images: Array.isArray(json.data) ? json.data : [],
        latency_ms: latencyMs,
        score: chosen.benchmark ? Math.round((chosen.benchmark.score / 100) * 1000) / 1000 : null,
        decision: null,
        ...(retried ? { retried: true } : {}),
      },
    };
  }

  // ── Chat-shaped tags: alias (+ optional budget suffix) → chat pipeline ──
  const alias = tagToAlias(tag) + (budget === "any" ? "" : `:${budget}`);
  const content =
    Array.isArray(body.images) && body.images.length > 0
      ? [
          { type: "text", text: prompt },
          ...body.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : prompt;
  const started = Date.now();
  const chatBody = {
    model: alias,
    stream: false, // synchronous by design (Guide 1 Part 6)
    messages: [{ role: "user", content }],
  };
  const isExhausted = (status: number) => status === 503 || status === 502 || status === 404 || status === 0;
  let retried = false;
  let result: QuickDispatchResult;
  try {
    result = await options.dispatchChat(chatBody);
  } catch {
    result = { status: 0, headers: {}, json: null };
  }
  if (isExhausted(result.status) && retryMs > 0) {
    // Guide 2: one retry after the wait, then the honest 503.
    retried = true;
    await sleep(retryMs);
    try {
      result = await options.dispatchChat(chatBody);
    } catch {
      result = { status: 0, headers: {}, json: null };
    }
  }
  const latencyMs = Date.now() - started;

  if (isExhausted(result.status)) {
    // All alias candidates exhausted (or the alias resolved nothing) — the
    // guide's "capability temporarily unavailable" shape.
    return noActiveModels(tag, retried);
  }
  if (result.status !== 200) {
    const message =
      result.json && typeof result.json === "object" &&
      typeof (result.json as { error?: { message?: unknown } }).error?.message === "string"
        ? (result.json as { error: { message: string } }).error.message
        : `upstream status ${result.status}`;
    return { status: result.status, payload: { ok: false, error: message, tag } };
  }

  const json = (result.json ?? {}) as {
    model?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const rawText = json.choices?.[0]?.message?.content;
  const text = typeof rawText === "string" ? rawText : rawText == null ? "" : JSON.stringify(rawText);
  const servedModel = result.headers["x-omniroute-model"] ?? json.model ?? alias;
  const servedProvider = result.headers["x-omniroute-provider"] ?? null;
  return {
    status: 200,
    payload: {
      ok: true,
      model: servedModel,
      provider: servedProvider,
      text,
      latency_ms: latencyMs,
      score: scoreForModel(servedModel, tag),
      decision: parseDecisionHeader(result.headers["x-omniroute-decision"]),
      ...(retried ? { retried: true } : {}),
    },
  };
}
