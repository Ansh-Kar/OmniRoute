/**
 * Swarm combo strategy — different tasks to different models, in parallel.
 *
 * Existence reason (fork: parallel execution): fusion answers ONE prompt with
 * a panel of models (ensemble); pipeline runs different models SEQUENTIALLY.
 * Neither covers the agent-swarm shape: "here are N different tasks — spawn
 * the right specialist for each and run them all at once":
 *
 *   - each task carries its own instruction (injected as a system turn) and
 *     its own worker: an explicit `provider/model` string, or a tag spec
 *     (`fromTags`) resolved against the model tag index at dispatch time —
 *     category, benchmark floor, provider allow/blocklist, capability floors;
 *   - workers run in parallel under a bounded concurrency pool;
 *   - tag resolution is cross-task diverse: two tasks with the same spec get
 *     DIFFERENT models when candidates allow (a swarm of one model N times
 *     through N frontdoors is not a swarm);
 *   - results come back labeled per task (`sections`/`json` result formats),
 *     or optionally a synthesizer model merges them into one coherent final
 *     answer (streaming + tools preserved, mirroring fusion's judge).
 *
 * Degradation mirrors fusion's discipline: a failed/timed-out/lane-full task
 * is reported per task and never sinks the run; only total failure 503s.
 * Heap discipline mirrors #1905: task count is capped BEFORE fan-out because
 * N parallel calls buffer N full response bodies simultaneously.
 */
import { errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import {
  appendUserTurn,
  extractPanelText,
  isToolBearingRequest,
} from "./fusion.ts";
import { prependSystemInstruction } from "./pipeline.ts";
import {
  findModelsByTags,
  getModelTagIndex,
  isModelCategory,
} from "./modelTags/index.ts";
import type { ModelCategory } from "./modelTags/taxonomy.ts";
import type { PerTargetAdmissionHook } from "./admission/types.ts";
import type { ComboLogger, HandleSingleModel } from "./combo/types.ts";

type Body = Record<string, unknown>;

// Swarm tuning. Overridable per-combo via config.swarm.
export const SWARM_DEFAULTS = {
  /** Hard cap on tasks per run (#1905 heap discipline: N tasks buffer N bodies). */
  maxTasks: 40,
  /** Default parallel workers. Raise for wide swarms on fat hosts. */
  maxConcurrency: 8,
  /** Absolute per-task wall clock. */
  taskTimeoutMs: 120_000,
} as const;

export type SwarmTaskFromTags = {
  category: ModelCategory;
  minBenchmark?: number;
  providers?: string[];
  excludeProviders?: string[];
  requireTools?: boolean;
  requireVision?: boolean;
};

export type SwarmTaskSpec = {
  /** Display/labeling only — shows up in the run result. */
  label?: string;
  /** The task instruction, injected as the worker's system turn. */
  task: string;
  /** Explicit worker ("provider/model"). Wins over fromTags. */
  model?: string;
  /** Tag-resolved worker: provider + category + benchmark retrieval. */
  fromTags?: SwarmTaskFromTags;
};

export type SwarmRunConfig = {
  tasks: SwarmTaskSpec[];
  /** Merge task outputs into one final answer via judgeModel. */
  synthesize?: boolean;
  /** Synthesizer; defaults to the first task's worker when synthesize is on. */
  judgeModel?: string;
  /** Fallback worker for tasks with neither model nor fromTags. */
  defaultModel?: string;
  /** Parallel workers, clamped [1, maxTasks]. Default 8. */
  maxConcurrency?: number;
  /** sections (default) | json — the non-synthesized response layout. */
  resultFormat?: "sections" | "json";
};

export type SwarmTaskResult = {
  label: string;
  task: string;
  model: string | null;
  ok: boolean;
  content?: string;
  error?: string;
};

// ── Parsing (untrusted config / request bodies) ─────────────────────────────

function parseFromTags(value: unknown): SwarmTaskFromTags | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isModelCategory(raw.category)) return undefined;
  const spec: SwarmTaskFromTags = { category: raw.category };
  if (typeof raw.minBenchmark === "number" && Number.isFinite(raw.minBenchmark)) {
    spec.minBenchmark = Math.min(Math.max(raw.minBenchmark, 0), 100);
  }
  for (const key of ["providers", "excludeProviders"] as const) {
    const list = raw[key];
    if (Array.isArray(list)) {
      const cleaned = list.filter(
        (p): p is string => typeof p === "string" && p.trim() !== ""
      );
      if (cleaned.length > 0) spec[key] = cleaned;
    }
  }
  if (raw.requireTools === true) spec.requireTools = true;
  if (raw.requireVision === true) spec.requireVision = true;
  return spec;
}

/**
 * Parse an untrusted task list (combo config or request-body override).
 * Returns null for absent/malformed input — never throws. A task without a
 * usable `task` string is dropped; an empty survivor list is null.
 */
export function parseSwarmTaskSpecs(value: unknown): SwarmTaskSpec[] | null {
  if (!Array.isArray(value)) return null;
  const tasks: SwarmTaskSpec[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const task = typeof raw.task === "string" ? raw.task.trim() : "";
    if (!task) continue;
    const spec: SwarmTaskSpec = { task };
    if (typeof raw.label === "string" && raw.label.trim()) spec.label = raw.label.trim();
    if (typeof raw.model === "string" && raw.model.trim()) spec.model = raw.model.trim();
    const fromTags = parseFromTags(raw.fromTags);
    if (fromTags) spec.fromTags = fromTags;
    tasks.push(spec);
  }
  return tasks.length > 0 ? tasks : null;
}

/** Parse the combo-level swarm config (config.swarm). */
export function parseSwarmRunConfig(value: unknown): SwarmRunConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const tasks = parseSwarmTaskSpecs(raw.tasks);
  if (!tasks) return null;
  const config: SwarmRunConfig = { tasks };
  if (raw.synthesize === true) config.synthesize = true;
  if (typeof raw.judgeModel === "string" && raw.judgeModel.trim()) {
    config.judgeModel = raw.judgeModel.trim();
  }
  if (typeof raw.defaultModel === "string" && raw.defaultModel.trim()) {
    config.defaultModel = raw.defaultModel.trim();
  }
  if (typeof raw.maxConcurrency === "number" && Number.isFinite(raw.maxConcurrency)) {
    config.maxConcurrency = Math.max(1, Math.floor(raw.maxConcurrency));
  }
  if (raw.resultFormat === "json" || raw.resultFormat === "sections") {
    config.resultFormat = raw.resultFormat;
  }
  return config;
}

// ── Task → worker resolution ────────────────────────────────────────────────

export type ResolvedSwarmTask = {
  spec: SwarmTaskSpec;
  label: string;
  /** Full "provider/model" worker string; null = unresolvable (reported). */
  model: string | null;
  /** How the worker was chosen — surfaced in logs and results. */
  source: "explicit" | "tags" | "default" | "unresolved";
};

/**
 * Resolve every task's worker. Tag specs consult the model tag index with
 * cross-task diversity: candidates already claimed by an earlier task are
 * skipped while alternatives exist, so "different tasks → different models
 * from different providers" holds whenever the catalog allows it.
 */
export function resolveSwarmTargets(
  tasks: SwarmTaskSpec[],
  options: { defaultModel?: string | null; isVisible?: (model: string) => boolean } = {}
): ResolvedSwarmTask[] {
  const index = getModelTagIndex();
  const visible = options.isVisible ?? (() => true);
  const usedModels = new Set<string>();
  return tasks.map((spec, i) => {
    const label = spec.label ?? `task-${i + 1}`;
    if (spec.model && visible(spec.model)) {
      usedModels.add(spec.model);
      return { spec, label, model: spec.model, source: "explicit" as const };
    }
    if (spec.fromTags) {
      const candidates = findModelsByTags(index, {
        category: spec.fromTags.category,
        minBenchmark: spec.fromTags.minBenchmark,
        providers: spec.fromTags.providers,
        excludeProviders: spec.fromTags.excludeProviders,
        requireTools: spec.fromTags.requireTools,
        requireVision: spec.fromTags.requireVision,
        distinctModels: true,
        diverseProviders: true,
      }).filter((entry) => visible(entry.id));
      if (candidates.length > 0) {
        const fresh = candidates.find((entry) => !usedModels.has(entry.id));
        const chosen = fresh ?? candidates[0];
        usedModels.add(chosen.id);
        return { spec, label, model: chosen.id, source: "tags" as const };
      }
      // No tag match: fall through to defaultModel so a stale tag spec
      // (vendor retired the model, provider hidden) degrades instead of
      // killing the task — the result records the fallback honestly.
    }
    if (options.defaultModel && visible(options.defaultModel)) {
      return { spec, label, model: options.defaultModel, source: "default" as const };
    }
    return { spec, label, model: null, source: "unresolved" as const };
  });
}

// ── Execution ───────────────────────────────────────────────────────────────

type Sentinel = { __timeout?: true; __error?: unknown };

function withTimeout(promise: Promise<Response>, ms: number): Promise<Response | Sentinel> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ __timeout: true }), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        resolve({ __error: e });
      });
  });
}

/** Bounded-concurrency pool: runs worker() over items, at most `limit` at once. */
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const lanes = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    })
  );
  return out;
}

export type ExecuteSwarmOptions = {
  body: Body;
  tasks: SwarmTaskSpec[];
  handleSingleModel: HandleSingleModel;
  log: ComboLogger;
  comboName?: string;
  defaultModel?: string | null;
  maxConcurrency?: number | null;
  resultFormat?: "sections" | "json" | null;
  synthesize?: boolean | null;
  judgeModel?: string | null;
  perTargetAdmission?: PerTargetAdmissionHook | null;
  /** Veto operator-hidden models (fusion's judge/panel visibility contract). */
  isVisible?: (model: string) => boolean;
};

/** Build a synthetic OpenAI-shaped chat completion carrying the swarm output. */
function swarmRunResponse(content: string, model: string): Response {
  return new Response(
    JSON.stringify({
      id: `swarm-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function renderSections(results: SwarmTaskResult[]): string {
  const parts: string[] = [];
  for (const result of results) {
    const header = `## ${result.label}${result.model ? ` — ${result.model}` : ""}`;
    if (result.ok) {
      parts.push(`${header}\n\n${result.content ?? ""}`.trimEnd());
    } else {
      parts.push(`${header}\n\n_[task failed: ${result.error ?? "unknown error"}]_`);
    }
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Build the synthesizer directive. Unlike fusion's judge (anonymized sources,
 * consensus analysis), swarm outputs are LABELED by task — the synthesizer's
 * job is composition, not adjudication: assemble the specialists' work into
 * one coherent answer for the user's original request.
 */
export function buildSwarmSynthesisPrompt(results: SwarmTaskResult[]): string {
  const outputs = results
    .filter((r) => r.ok)
    .map(
      (r) =>
        `### ${r.label}${r.model ? ` (worker: ${r.model})` : ""}\n${r.content ?? ""}`
    )
    .join("\n\n");
  const failed = results.filter((r) => !r.ok);
  const failedNote =
    failed.length > 0
      ? `\n\nThe following tasks FAILED and have no output — do not invent their content, just note the gap if it matters: ${failed
          .map((r) => `${r.label} (${r.error ?? "unknown"})`)
          .join("; ")}.`
      : "";
  return [
    "You are the SYNTHESIZER of a model swarm. Specialized workers each completed a DIFFERENT task against the user's request below. Their outputs follow, labeled by task.",
    "Assemble the outputs into one coherent, complete final answer for the user: resolve overlaps, keep every distinct contribution, fix contradictions using your own judgment, and do not invent content no worker produced. Keep any task labels that aid readability.",
    outputs,
    failedNote,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Execute a swarm run: resolve workers, fan tasks out in parallel under a
 * bounded pool, collect per-task results, and render the response —
 * synthesized (a real model call, streaming/tool compatible) or structured
 * (sections/json synthetic completion).
 */
export async function executeSwarmRun({
  body,
  tasks,
  handleSingleModel,
  log,
  comboName,
  defaultModel,
  maxConcurrency,
  resultFormat,
  synthesize,
  judgeModel,
  perTargetAdmission,
  isVisible,
}: ExecuteSwarmOptions): Promise<Response> {
  if (tasks.length === 0) {
    return errorResponse(400, "Swarm combo has no tasks");
  }
  if (tasks.length > SWARM_DEFAULTS.maxTasks) {
    return errorResponse(
      400,
      `Swarm task count ${tasks.length} exceeds maxTasks=${SWARM_DEFAULTS.maxTasks} — refusing fan-out (#1905 heap discipline)`
    );
  }

  const resolved = resolveSwarmTargets(tasks, {
    defaultModel: defaultModel ?? null,
    isVisible,
  });
  for (const task of resolved) {
    if (task.source === "unresolved") {
      log.warn(
        "SWARM",
        `Combo "${comboName ?? ""}" task "${task.label}" has no model, no resolvable fromTags and no defaultModel`
      );
    } else if (task.source === "tags") {
      log.info("SWARM", `Task "${task.label}" → ${task.model} (tag-resolved)`);
    }
  }

  // Tool-bearing requests (#6771 discipline): workers run tools-stripped, so
  // WITHOUT synthesis an agentic tool-call request would get a prose answer
  // with no tool call. Route it directly to the synthesizer (explicit judge,
  // else the first resolvable worker) with tools intact. WITH synthesis the
  // judge call itself preserves the client's tools, so the swarm runs.
  if (isToolBearingRequest(body) && !synthesize) {
    const fallback = (judgeModel ?? "").trim() || resolved.find((t) => t.model)?.model;
    if (fallback) {
      log.info(
        "SWARM",
        `Combo "${comboName ?? ""}" received a tool-bearing request without synthesis — bypassing fan-out, routing directly to ${fallback} with tools intact`
      );
      return handleSingleModel(body, fallback);
    }
  }

  // Worker body: prose-oriented like fusion's panel body — tools stripped,
  // non-streaming, and the request-side `swarm` override field never leaks
  // upstream (providers 400 on unknown fields).
  const { tools: _t, tool_choice: _tc, swarm: _sw, ...rest } = body;
  void _t;
  void _tc;
  void _sw;
  const workerBody: Body = { ...rest, stream: false };

  // #9654 Wave 2: per-target lane probe — drop lane-full workers BEFORE the
  // pool starts (same contract as fusion's panel probe).
  let dispatchable = resolved;
  if (perTargetAdmission) {
    const gates = await Promise.all(
      resolved.map(async (task) => ({
        task,
        ok: task.model
          ? await perTargetAdmission({ modelStr: task.model, executionKey: task.model, body: workerBody })
          : false,
      }))
    );
    const dropped = gates.filter((g) => !g.ok);
    if (dropped.length > 0) {
      log.info(
        "SWARM",
        `Skipping ${dropped.length} task(s) — admission lane full: ${dropped
          .map((g) => `${g.task.label}→${g.task.model}`)
          .join(", ")}`
      );
    }
    dispatchable = gates.filter((g) => g.ok).map((g) => g.task);
  }

  const t0 = Date.now();
  const concurrency = Math.min(
    Math.max(1, Math.floor(maxConcurrency ?? SWARM_DEFAULTS.maxConcurrency)),
    SWARM_DEFAULTS.maxTasks
  );
  // The pool worker fully processes each task (dispatch → timeout guard →
  // parse) so the assembled results are final SwarmTaskResults.
  const pooled: SwarmTaskResult[] = await runPool(dispatchable, concurrency, async (task) => {
    const base = { label: task.label, task: task.spec.task, model: task.model };
    const res = await withTimeout(
      handleSingleModel(
        prependSystemInstruction(workerBody, task.spec.task),
        task.model as string
      ),
      SWARM_DEFAULTS.taskTimeoutMs
    );
    const sentinel = res as Sentinel;
    if (sentinel.__timeout) return { ...base, ok: false, error: "timeout" };
    if (sentinel.__error) {
      return { ...base, ok: false, error: sanitizeErrorMessage(sentinel.__error as Error) };
    }
    const resp = res as Response;
    if (!resp.ok) return { ...base, ok: false, error: `status_${resp.status}` };
    try {
      const json = await resp.clone().json();
      const text = extractPanelText(json);
      if (!text) return { ...base, ok: false, error: "empty_content" };
      return { ...base, ok: true, content: text };
    } catch (e) {
      return { ...base, ok: false, error: `unparseable: ${sanitizeErrorMessage(e as Error)}` };
    }
  });
  log.info(
    "SWARM",
    `Combo "${comboName ?? ""}" | tasks=${resolved.length} dispatched=${dispatchable.length} | concurrency=${concurrency} | ${Date.now() - t0}ms`
  );

  // Re-align pooled results to the FULL task list; tasks that never reached
  // the pool (no worker, lane-full) are reported as failures, not dropped.
  const pooledByTask = new Map<ResolvedSwarmTask, SwarmTaskResult>();
  dispatchable.forEach((task, i) => pooledByTask.set(task, pooled[i]));
  const results: SwarmTaskResult[] = resolved.map(
    (task) =>
      pooledByTask.get(task) ?? {
        label: task.label,
        task: task.spec.task,
        model: task.model,
        ok: false,
        error: "no_worker_or_lane_full",
      }
  );
  const okCount = results.filter((r) => r.ok).length;

  if (okCount === 0) {
    const detail = results.map((r) => `${r.label}=${r.error}`).join(", ");
    log.warn("SWARM", `No task succeeded: ${detail}`);
    return errorResponse(
      503,
      detail ? `All swarm tasks failed: ${detail}` : "All swarm tasks failed"
    );
  }

  // Synthesis: a real model call on the ORIGINAL body (stream + tools kept,
  // mirroring fusion's judge) — format-correct for every client protocol.
  if (synthesize) {
    const explicitJudge = judgeModel && judgeModel.trim() ? judgeModel.trim() : null;
    const judge =
      explicitJudge ??
      (results.find((r) => r.ok && r.model)?.model as string | undefined) ??
      (results.find((r) => r.ok)?.model as string | undefined);
    if (!judge) {
      return errorResponse(500, "Swarm synthesis requested but no judge model resolved");
    }
    log.info("SWARM", `Synthesizing ${okCount}/${results.length} task outputs with ${judge}`);
    const judgeBody = appendUserTurn(body, buildSwarmSynthesisPrompt(results));
    return handleSingleModel(judgeBody, judge);
  }

  // Structured results as a synthetic chat completion. NOTE: this response is
  // constructed after protocol translation, so it is always OpenAI-chat
  // shaped — native Gemini/Claude-format clients should use synthesize.
  const format = resultFormat ?? "sections";
  const content =
    format === "json"
      ? JSON.stringify({ object: "swarm_run", okCount, total: results.length, results }, null, 2)
      : renderSections(results);
  return swarmRunResponse(content, `swarm/${comboName ?? "run"}`);
}
