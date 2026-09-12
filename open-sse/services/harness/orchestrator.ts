/**
 * Orchestrator core — jobs, tasks, waves (harness B3, Guide 1 Parts 3+5+6).
 *
 * The brain (Guide 2) decomposes a goal into tagged, dependency-ordered
 * tasks; this module executes them as waves through the existing routing
 * path (B2's tag→alias dispatch), persists every transition, and reports
 * per-task status. Pure logic + a JobsStore interface so the whole state
 * machine is unit-testable with an in-memory store; the SQLite-backed
 * store lives in src/lib/db/orchestrateJobs.ts and the HTTP surface in
 * src/app/api/v1/orchestrate/*.
 *
 * Semantics (Guide 1 Part 3/5):
 *   - Task: queued → running → done | failed. Failure with attempts <
 *     policy.max_attempts requeues (attempts+1); at the cap the task is
 *     failed and the job continues — a job may succeed with failed tasks
 *     surfaced, never silently.
 *   - A task is READY when every depends_on is done. Failed deps BLOCK the
 *     wave (surfaced with reasons, never guessed around).
 *   - Waves fire all ready tasks in parallel (bounded by
 *     policy.max_concurrency); upstream results are injected into each
 *     dependent's prompt, truncated to 800 chars.
 *   - Deadline (policy.deadline_s): when exceeded, remaining tasks stay
 *     queued and the job is failed with reason "deadline" — partial
 *     results remain readable.
 *   - Idempotency-Key: replays return the original job, never re-execute.
 *   - mode "swarm" (blackboard + judge) is validated but lands in B3.5.
 */

import {
  findModelsByTags,
  getModelTagIndex,
  isTaskType,
  TASK_TYPES,
  TASK_TYPE_TO_QUERY,
  type TaskType,
} from "../modelTags/index.ts";
import { classifyFailure } from "./failureTaxonomy.ts";
import { recordRoutingOutcome, taskSignature } from "./routingCache.ts";

// Re-exported for the stores and dispatch wiring (B10: the SQLite store and
// lib/orchestrator/dispatch.ts import the tag vocabulary from here).
export type { TaskType };
import {
  assignModels,
  biasAvoidApplies,
  BIAS_AVOID_TOLERANCE,
  JUDGE_DRIFT_PENALTY,
  QUALITY_FLOOR,
  type AllocatorCandidate,
  type Assignment,
  type ModelStat,
} from "./allocator.ts";
import {
  CAPABILITY_ALIASES,
  CAPABILITY_ALIAS_BEST_SIZE,
  CAPABILITY_ALIAS_POOL_SIZE,
  CAPABILITY_ALIAS_SIZE,
  FAST_TIER_PATTERN,
} from "./capabilityAliases.ts";
import {
  appendMailboxAnswer,
  assembleSwarmPrompt,
  buildAskPrompt,
  buildJudgeMessages,
  compressSwarmContext,
  MAILBOX_TIMEOUT_MS,
  mergeIntoBlackboard,
  parseAskDirectives,
  parseJudgeVerdicts,
  parseSummary,
  withJudgeFeedback,
} from "./swarmMode.ts";
import {
  ensureTaskWorktree,
  syncBlackboardToWorktree,
  getSessionWorktreeDiff,
  triggerWorktreeVerification,
  waitForVerification,
  type WorktreeSession,
} from "./opendevBridge.ts";
// B10: tag inference for tag-less tasks (classifier stage 1 — free, deterministic).
import { classifyRequestBody } from "./classifier.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type OrchestrateTaskSpec = {
  id: string;
  /**
   * B10 (OpenResearch adaptation): the tag is OPTIONAL. The caller names
   * work, not models — when absent, the classifier's stage-1 heuristics
   * infer it from the prompt (inferTaskTag) and the inference is logged.
   * Explicit tags still win, exactly as before.
   */
  tag?: string;
  prompt: string;
  depends_on?: string[];
  /**
   * B7 multimodal: which endpoint family executes the task. Default is the
   * tag's implied modality ("text" for chat tags; media tags imply their
   * media modality). "search" on a chat tag makes the task a literal
   * /v1/search web-search dispatch.
   */
  modality?: string;
};

export type OrchestratePolicy = {
  budget?: string; // any | best | cheap (B2 tiers)
  max_attempts?: number; // default 3
  max_concurrency?: number; // default 8 (wave parallelism)
  deadline_s?: number; // default 600
  task_timeout_ms?: number; // default 120000
  judge?: boolean; // swarm mode: run the judge loop (default true)
  max_rounds?: number; // swarm mode: judge refinement cap (1-5, default 3)
  /** B5: "alias" dispatches the capability alias (native combo failover, default); "assigned" dispatches allocator-picked models (Part 4 water-filling). */
  routing?: "alias" | "assigned";
  /** B5 (assigned routing): max tasks per provider per wave (default 3). */
  max_per_provider?: number;
  /** B6: total token budget across task dispatches (prompt+completion); 0 = unlimited. */
  max_total_tokens?: number;
  /**
   * B8: compress the swarm shared context (goal + blackboard) with the
   * Caveman engine before worker fan-out — each worker's prompt shrinks,
   * and the savings multiply across N workers. Default false (opt-in):
   * compression trades prose fidelity for tokens; code blocks are preserved.
   */
  compress_context?: boolean;
  /** OpenDev Integration: dispatch code tasks to isolated Git worktrees */
  execution_target?: "api" | "opendev" | "worktree";
  /** Target OpenDev project ID for worktree provisioning */
  project_id?: string;
  /** Run detached test supervisor in worktree after code generation */
  verify_supervisor?: boolean;
  /** Custom test/verification command for the supervisor (e.g. "npm test") */
  verify_command?: string;
  /**
   * B10 (OpenResearch adaptation): wave = barrier semantics (all tasks in a
   * wave finish before the next fires — B3 default, unchanged); stream =
   * per-completion admission — the moment ANY task finishes, the next ready
   * task starts in the freed slot. Stream is the OpenResearch auto-research
   * loop shape: control returns per completion, not per batch.
   */
  scheduling?: "wave" | "stream";
  /**
   * B10 bias guard: when caller_model is set (the brain names itself so the
   * gateway can avoid self-preference), sub-agent and judge dispatches
   * avoid that model when a tag-viable alternative exists. Default true;
   * set false only for deliberate same-model ensembles.
   */
  bias_guard?: boolean;
  /**
   * B11 lenient bias guard: quality ratio (0–1) at which an alternative
   * counts as near-equal to the caller's model — the guard only diversifies
   * inside that band; a clearly better caller model wins on benchmark
   * merit (flagged bias_same_model). 0 = always avoid (B10 strict);
   * 1 = only avoid when the alternative is at least as good. Default 0.85.
   */
  bias_tolerance?: number;
  /**
   * B10 spawn: max concurrently ACTIVE child jobs a parent job may have
   * (the `orx agent spawn` in-flight cap analog). Default 4 (≥2 per the
   * admission-limits floor).
   */
  max_children?: number;
};

export type OrchestratePlanBody = {
  goal?: string;
  mode?: string; // parallel | swarm
  tasks?: OrchestrateTaskSpec[];
  blackboard?: Record<string, unknown>;
  policy?: OrchestratePolicy;
};

export type JobStatus = "active" | "judging" | "done" | "failed";
export type TaskState = "queued" | "running" | "done" | "failed";

// ── B7 multimodal dispatch ─────────────────────────────────────────────────
/** Endpoint family a task dispatches to. Chat tags default to "text". */
export type TaskModality = "text" | "image" | "search" | "speech" | "music" | "video" | "worktree";

export const TASK_MODALITIES = ["text", "image", "search", "speech", "music", "video", "worktree"] as const;

/** Media tags imply their modality — the dispatch layer never guesses. */
export const MODALITY_BY_TAG: Record<TaskType, TaskModality> = {
  code: "text",
  research: "text",
  math: "text",
  reasoning: "text",
  plan: "text",
  vision: "text",
  search: "text",
  chat: "text",
  image_gen: "image",
  audio_speech: "speech",
  music_gen: "music",
  video_gen: "video",
};

/** Media (non-chat) modalities — skip swarm wrappers, can't answer @ask. */
export function isMediaModality(modality: TaskModality): boolean {
  return modality !== "text" && modality !== "search";
}

/**
 * Resolve a task's modality. New jobs always carry an explicit modality
 * (validatePlan); rows persisted pre-B7 and stale in-memory jobs don't —
 * the tag's implied modality is the exact pre-B7 behavior (image_gen was
 * the only media dispatch).
 */
export function taskModalityOf(task: { tag: TaskType; modality?: TaskModality }): TaskModality {
  return task.modality ?? MODALITY_BY_TAG[task.tag];
}

export type OrchestrateTask = {
  jobId: string;
  id: string;
  tag: TaskType;
  /** B7: endpoint family this task dispatches to (persisted, surfaced in jobToApi). */
  modality: TaskModality;
  prompt: string;
  dependsOn: string[];
  state: TaskState;
  attempts: number;
  wave: number | null;
  assignedModel: string | null;
  assignedProvider: string | null;
  result: string | null;
  verdict: string | null;
  latencyMs: number | null;
  lastError: string | null;
  /** B5: epoch ms until the current wave's lease expires (null = not leased). */
  leaseUntil: number | null;
  /** B6: token usage recorded from the serving response (null = not reported). */
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * B13: epoch ms when the task reached a terminal state (done|failed) —
   * the runtime-stats window anchor. Null while queued/running and on rows
   * persisted pre-B13.
   */
  finishedAt: number | null;
};

export type OrchestrateJob = {
  jobId: string;
  goal: string;
  mode: string;
  policy: Required<OrchestratePolicy>;
  blackboard: Record<string, unknown> | null;
  status: JobStatus;
  failureReason: string | null;
  idempotencyKey: string | null;
  /**
   * B10 bias guard: the model the CALLING agent runs on (Hermes naming
   * itself). When set, task and judge dispatches avoid this model when a
   * tag-viable alternative exists — a same-model ensemble inherits the
   * caller's blind spots (self-preference bias), so diversity is enforced
   * at routing time. Null = caller did not identify (no guard, B3–B9
   * behavior).
   */
  callerModel: string | null;
  /**
   * B10 spawn: the job that spawned this one as a delegated helper
   * (`orx agent spawn` analog). null = top-level. Children may not spawn
   * (no nesting) and count against their parent's max_children while active.
   */
  parentJobId: string | null;
  createdAt: number;
  deadlineAt: number;
  /** Judge passes completed (swarm mode; hard cap = policy.max_rounds). */
  judgeRounds: number;
  tasks: OrchestrateTask[];
  log: OrchestrateLogEntry[];
};

export type OrchestrateLogEntry = {
  timestamp: number;
  jobId: string;
  taskId: string | null;
  event: string;
  detail: string | null;
};

export const ORCHESTRATE_DEFAULTS = {
  maxAttempts: 3,
  maxConcurrency: 8,
  deadlineS: 600,
  taskTimeoutMs: 120_000,
  maxRounds: 3,
  maxChildren: 4, // B10 spawn: default per-parent in-flight child cap (≥2 admission floor)
} as const;

/** Guide 1 Part 9 acceptance uses 6-task plans; the swarm #1905 cap is 40. */
export const ORCHESTRATE_MAX_TASKS = 40;

// ── Admission validation (replaces validate_plan.py) ────────────────────────

export type PlanValidation =
  | { ok: true; tasks: Array<OrchestrateTaskSpec & { tag: TaskType; modality: TaskModality }>; mode: "parallel" | "swarm"; policy: Required<OrchestratePolicy>; goal: string; blackboard: Record<string, unknown> | null; callerModel: string | null; inferredTags: Array<{ id: string; tag: TaskType; reason: string }> }
  | { ok: false; errors: string[] };

/**
 * B10 (OpenResearch adaptation): infer a task tag from its prompt — the
 * classifier's stage-1 heuristics, free and deterministic, over a synthetic
 * single-turn body. The caller names work; the gateway routes it. Explicit
 * tags always win; this only fills absences, and every inference is logged
 * so the decision is auditable, never silent.
 */
export function inferTaskTag(prompt: string): { tag: TaskType; reason: string } {
  const classification = classifyRequestBody({ messages: [{ role: "user", content: prompt }] });
  return { tag: classification.type, reason: classification.reason };
}

export function validatePlan(body: OrchestratePlanBody): PlanValidation {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return { ok: false, errors: ["body must be an object"] };

  const mode = body.mode === "swarm" ? "swarm" : body.mode === "parallel" || body.mode == null ? "parallel" : null;
  if (mode === null) errors.push(`mode must be "parallel" or "swarm" (got "${body.mode}")`);
  if (mode === "swarm" && body.blackboard && typeof body.blackboard === "object" && Array.isArray(body.blackboard._locked)) {
    // Locked keys must exist on the blackboard — a lock on a missing key is
    // a plan bug the brain should fix before submission.
    for (const key of body.blackboard._locked as string[]) {
      if (!(key in body.blackboard)) errors.push(`blackboard._locked references missing key "${key}"`);
    }
  }

  const goal = typeof body.goal === "string" ? body.goal : "";
  if (!goal.trim()) errors.push("goal must be a non-empty string");

  const tasks = body.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    errors.push("tasks must be a non-empty array");
    return { ok: false, errors };
  }
  if (tasks.length > ORCHESTRATE_MAX_TASKS) {
    errors.push(`tasks exceeds the cap of ${ORCHESTRATE_MAX_TASKS} (got ${tasks.length})`);
  }

  const seen = new Set<string>();
  const ids = new Set<string>();
  const inferredTags: Array<{ id: string; tag: TaskType; reason: string }> = [];
  const normalized: Array<OrchestrateTaskSpec & { tag: TaskType; modality: TaskModality }> = [];
  for (const [index, task0] of tasks.entries()) {
    let task = task0;
    if (!task || typeof task !== "object") {
      errors.push(`tasks[${index}] must be an object`);
      continue;
    }
    if (typeof task.id !== "string" || !task.id.trim()) {
      errors.push(`tasks[${index}].id must be a non-empty string`);
      continue;
    }
    if (seen.has(task.id)) errors.push(`duplicate task id "${task.id}"`);
    seen.add(task.id);
    ids.add(task.id);
    // B10: tag optional — absent (or empty) → inferred from the prompt via
    // the classifier's stage-1 heuristics (deterministic, logged). Explicit
    // tags are validated as before.
    if (task.tag === undefined || task.tag === null || task.tag === "") {
      const inferred = inferTaskTag(task.prompt ?? "");
      task = { ...task, tag: inferred.tag };
      inferredTags.push({ id: task.id, tag: inferred.tag, reason: inferred.reason });
    }
    if (!isTaskType(task.tag)) {
      errors.push(`tasks[${index}] ("${task.id}"): unknown tag "${task.tag}" (vocabulary: ${TASK_TYPES.join(", ")})`);
      continue;
    }
    if (typeof task.prompt !== "string" || !task.prompt.trim()) {
      errors.push(`tasks[${index}] ("${task.id}"): prompt must be a non-empty string`);
      continue;
    }
    // B7: modality — default is the tag's implied modality. Media tags force
    // theirs (no "text" dispatch for image_gen); "search" (literal /v1/search)
    // is only meaningful on chat tags; other explicit values must match.
    const implied = MODALITY_BY_TAG[task.tag];
    let modality = implied;
    if (task.modality !== undefined) {
      if (typeof task.modality !== "string" || !(TASK_MODALITIES as readonly string[]).includes(task.modality)) {
        errors.push(
          `tasks[${index}] ("${task.id}"): unknown modality "${String(task.modality)}" (vocabulary: ${TASK_MODALITIES.join(", ")})`
        );
        continue;
      }
      const requested = task.modality as TaskModality;
      if (implied !== "text") {
        if (requested !== implied) {
          errors.push(
            `tasks[${index}] ("${task.id}"): modality "${requested}" is incompatible with tag "${task.tag}" (implies "${implied}")`
          );
          continue;
        }
      } else if (requested !== "text" && requested !== "search") {
        errors.push(
          `tasks[${index}] ("${task.id}"): modality "${requested}" requires its media tag (image_gen / audio_speech / music_gen / video_gen); got "${task.tag}"`
        );
        continue;
      }
      modality = requested;
    }
    const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];
    normalized.push({
      ...task,
      tag: task.tag,
      modality,
      depends_on: dependsOn,
      prompt: task.prompt,
    });
  }

  // Dangling depends_on + cycle detection (Kahn).
  for (const task of normalized) {
    for (const dep of task.depends_on ?? []) {
      if (!ids.has(dep)) errors.push(`task "${task.id}" depends_on unknown task "${dep}"`);
    }
  }
  if (normalized.length > 0) {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const task of normalized) {
      indegree.set(task.id, (task.depends_on ?? []).length);
      for (const dep of task.depends_on ?? []) {
        dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
      }
    }
    const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const current = queue.pop() as string;
      visited += 1;
      for (const next of dependents.get(current) ?? []) {
        const d = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (visited !== normalized.length) errors.push("task graph contains a dependency cycle");
  }

  if (errors.length > 0) return { ok: false, errors };

  const rawCallerModel = (body as { caller_model?: unknown }).caller_model;
  const callerModel = typeof rawCallerModel === "string" && rawCallerModel.trim() ? rawCallerModel.trim() : null;

  const rawPolicy = body.policy ?? {};
  const budget = rawPolicy.budget === "best" || rawPolicy.budget === "cheap" ? rawPolicy.budget : "any";
  const policy: Required<OrchestratePolicy> = {
    budget,
    max_attempts: clampInt(rawPolicy.max_attempts, 1, 5, ORCHESTRATE_DEFAULTS.maxAttempts),
    max_concurrency: clampInt(rawPolicy.max_concurrency, 1, 16, ORCHESTRATE_DEFAULTS.maxConcurrency),
    deadline_s: clampInt(rawPolicy.deadline_s, 1, 86_400, ORCHESTRATE_DEFAULTS.deadlineS),
    task_timeout_ms: clampInt(rawPolicy.task_timeout_ms, 1_000, 600_000, ORCHESTRATE_DEFAULTS.taskTimeoutMs),
    judge: rawPolicy.judge !== false,
    max_rounds: clampInt(rawPolicy.max_rounds, 1, 5, ORCHESTRATE_DEFAULTS.maxRounds),
    routing: rawPolicy.routing === "assigned" ? "assigned" : "alias",
    max_per_provider: clampInt(rawPolicy.max_per_provider, 1, 16, 3),
    max_total_tokens: clampInt(rawPolicy.max_total_tokens, 0, 1_000_000_000, 0),
    compress_context: rawPolicy.compress_context === true,
    // OpenDev worktree integration (Build 1): explicit defaults so the
    // Required policy is whole — absent values previously serialized as
    // undefined keys on every persisted job row.
    execution_target: rawPolicy.execution_target === "opendev" || rawPolicy.execution_target === "worktree" ? rawPolicy.execution_target : "api",
    project_id: typeof rawPolicy.project_id === "string" ? rawPolicy.project_id : "",
    verify_supervisor: rawPolicy.verify_supervisor === true,
    verify_command: typeof rawPolicy.verify_command === "string" ? rawPolicy.verify_command : "",
    scheduling: rawPolicy.scheduling === "stream" ? "stream" : "wave",
    bias_guard: rawPolicy.bias_guard !== false,
    bias_tolerance: Math.min(1, Math.max(0, Number.isFinite(Number(rawPolicy.bias_tolerance)) ? Number(rawPolicy.bias_tolerance) : BIAS_AVOID_TOLERANCE)),
    max_children: clampInt(rawPolicy.max_children, 2, 16, ORCHESTRATE_DEFAULTS.maxChildren),
  };
  return {
    ok: true,
    tasks: normalized,
    mode: (mode ?? "parallel") as "parallel" | "swarm",
    policy,
    goal,
    blackboard: body.blackboard && typeof body.blackboard === "object" ? body.blackboard : null,
    callerModel,
    inferredTags,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ── B10 objective-first entry + spawn (OpenResearch adaptation) ─────────────

export type OrchestrateObjectiveBody = {
  /** What the caller wants accomplished — the task objective (replaces the research goal of orx projects). */
  objective?: string;
  /**
   * Optional decomposition. Absent → the objective itself is the single
   * task (the caller decomposes when it wants to; the gateway never
   * refuses work for lacking a plan). ids optional (generated), tags
   * optional (inferred), depends_on optional.
   */
  subtasks?: Array<Partial<OrchestrateTaskSpec> & { prompt: string }>;
  /** The calling agent's model — enables the bias guard. */
  caller_model?: string;
  mode?: string;
  blackboard?: Record<string, unknown>;
  policy?: OrchestratePolicy;
};

/**
 * Normalize an objective body into a plan body. Pure — no store, no clock.
 * Returns null + errors on shape problems; semantic validation is
 * validatePlan's job (one admission path, not two).
 */
export function objectiveToPlanBody(
  body: OrchestrateObjectiveBody
): { plan: OrchestratePlanBody & { caller_model?: string } | null; errors: string[] } {
  if (!body || typeof body !== "object") return { plan: null, errors: ["body must be an object"] };
  const errors: string[] = [];
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!objective) errors.push("objective must be a non-empty string");
  let subtasks = body.subtasks;
  if (subtasks === undefined || subtasks === null) {
    subtasks = [{ prompt: objective }];
  } else if (!Array.isArray(subtasks) || subtasks.length === 0) {
    errors.push("subtasks must be a non-empty array when provided");
    subtasks = [];
  } else {
    for (const [index, subtask] of subtasks.entries()) {
      if (!subtask || typeof subtask !== "object" || typeof subtask.prompt !== "string" || !subtask.prompt.trim()) {
        errors.push(`subtasks[${index}].prompt must be a non-empty string`);
      }
    }
  }
  if (errors.length > 0) return { plan: null, errors };
  const tasks = subtasks.map((subtask, index) => ({
    id: typeof subtask.id === "string" && subtask.id.trim() ? subtask.id : `t${index + 1}`,
    tag: typeof subtask.tag === "string" && subtask.tag ? subtask.tag : undefined,
    prompt: subtask.prompt,
    depends_on: Array.isArray(subtask.depends_on) ? subtask.depends_on : [],
    ...(subtask.modality !== undefined ? { modality: subtask.modality } : {}),
  }));
  return {
    plan: {
      goal: objective,
      mode: body.mode,
      tasks,
      ...(body.blackboard !== undefined ? { blackboard: body.blackboard } : {}),
      policy: body.policy,
      ...(body.caller_model !== undefined ? { caller_model: body.caller_model } : {}),
    },
    errors: [],
  };
}

export type OrchestrateSpawnBody = {
  /** Self-contained brief — the helper cannot see the caller's conversation (orx agent spawn's standalone-brief rule). */
  brief?: string;
  /** Optional short title (job goal label). */
  title?: string;
  /** The delegating job. Enforces: no nesting (a child cannot spawn), in-flight cap via max_children. */
  parent_job_id?: string;
  tag?: string;
  /** Defaults to the parent's caller model — bias guard propagates down the spawn chain. */
  caller_model?: string;
  /** Explicit blackboard snapshot for the helper — copied verbatim, never auto-derived from the parent. */
  context?: Record<string, unknown>;
  policy?: OrchestratePolicy;
};

/**
 * Normalize a spawn body + parent job into the child's plan body. Pure.
 * The parent's nesting/cap checks happen at the route (they need the
 * store); this only shapes the child job.
 */
export function spawnToPlanBody(
  body: OrchestrateSpawnBody,
  parent: OrchestrateJob
): { plan: OrchestratePlanBody & { caller_model?: string } | null; errors: string[] } {
  if (!body || typeof body !== "object") return { plan: null, errors: ["body must be an object"] };
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (!brief) return { plan: null, errors: ["brief must be a non-empty string — the helper is self-contained"] };
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : `helper: ${brief.slice(0, 72)}`;
  const callerModel =
    typeof body.caller_model === "string" && body.caller_model.trim()
      ? body.caller_model.trim()
      : parent.callerModel ?? undefined;
  return {
    plan: {
      goal: title,
      mode: "parallel",
      tasks: [
        {
          id: "helper",
          ...(typeof body.tag === "string" && body.tag ? { tag: body.tag } : {}),
          prompt: brief,
          depends_on: [],
        },
      ],
      ...(body.context !== undefined ? { blackboard: body.context } : {}),
      policy: body.policy,
      ...(callerModel !== undefined ? { caller_model: callerModel } : {}),
    },
    errors: [],
  };
}


// ── B10 refill helpers (routes re-export via lib/orchestrator/dispatch.ts) ──

/**
 * B10 refill: build queued task rows for appendTasks (the OpenResearch
 * "refill the freed slot" move). Same row shape as jobFromPlan's tasks.
 */
export function taskRowsFromSpecs(
  specs: Array<{ id: string; tag: string; prompt: string; modality?: string; depends_on?: string[] }>,
  jobId: string
): OrchestrateJob["tasks"] {
  return specs.map((spec) => ({
    jobId,
    id: spec.id,
    tag: spec.tag as OrchestrateJob["tasks"][number]["tag"],
    modality: (spec.modality ?? "text") as OrchestrateJob["tasks"][number]["modality"],
    prompt: spec.prompt,
    dependsOn: spec.depends_on ?? [],
    state: "queued" as const,
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
      finishedAt: null,
  }));
}

/**
 * B10 refill: normalize appended task specs against a LIVE job. Unlike
 * validatePlan, depends_on may reference tasks already on the job (append
 * extends the graph, it doesn't restart it). Tags inferred when absent;
 * ids generated when absent. Returns specs + the inferred-tag log lines.
 */
function nextFreeId(existing: Set<string>, seen: Set<string>, start: number): string {
  let n = start;
  let candidate = `t${n}`;
  while (existing.has(candidate) || seen.has(candidate)) {
    n += 1;
    candidate = `t${n}`;
  }
  return candidate;
}
export function normalizeAppendTasks(
  body: { tasks?: unknown },
  job: OrchestrateJob
): {
  ok: true;
  specs: Array<{ id: string; tag: string; prompt: string; modality: string; depends_on: string[] }>;
  inferred: Array<{ id: string; tag: string; reason: string }>;
} | { ok: false; errors: string[] } {
  if (!body || typeof body !== "object" || !Array.isArray(body.tasks) || body.tasks.length === 0) {
    return { ok: false, errors: ["body.tasks must be a non-empty array"] };
  }
  const existing = new Set(job.tasks.map((task) => task.id));
  const errors: string[] = [];
  const seen = new Set<string>();
  const specs: Array<{ id: string; tag: string; prompt: string; modality: string; depends_on: string[] }> = [];
  const inferred: Array<{ id: string; tag: string; reason: string }> = [];
  for (const [index, rawTask] of (body.tasks as unknown[]).entries()) {
    if (!rawTask || typeof rawTask !== "object") {
      errors.push(`tasks[${index}] must be an object`);
      continue;
    }
    const task = rawTask as { id?: unknown; tag?: unknown; prompt?: unknown; depends_on?: unknown };
    const prompt = typeof task.prompt === "string" ? task.prompt.trim() : "";
    if (!prompt) {
      errors.push(`tasks[${index}].prompt must be a non-empty string`);
      continue;
    }
    const id =
      typeof task.id === "string" && task.id.trim() && !existing.has(task.id) && !seen.has(task.id)
        ? task.id
        : nextFreeId(existing, seen, job.tasks.length + index + 1);
    if (typeof task.id === "string" && task.id.trim() && (existing.has(task.id) || seen.has(task.id))) {
      errors.push(`duplicate task id "${task.id}"`);
      continue;
    }
    seen.add(id);
    let tag: TaskType | null = null;
    if (typeof task.tag === "string" && task.tag) {
      tag = task.tag as TaskType;
    } else {
      const result = inferTaskTag(prompt);
      tag = result.tag;
      inferred.push({ id, tag: result.tag, reason: result.reason });
    }
    const dependsOn = Array.isArray(task.depends_on)
      ? task.depends_on.filter((dep): dep is string => typeof dep === "string")
      : [];
    for (const dep of dependsOn) {
      if (!existing.has(dep) && !seen.has(dep)) {
        errors.push(`task "${id}" depends_on unknown task "${dep}" (not on the job and not appended)`);
      }
    }
    specs.push({ id, tag, prompt, modality: MODALITY_BY_TAG[tag] ?? "text", depends_on: dependsOn });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, specs, inferred };
}


// ── Planner (Guide 1 Part 5) ────────────────────────────────────────────────

export type WavePlan = {
  /** Ready task ids: every depends_on is done. */
  ready: string[];
  /** Incomplete tasks that are not ready, with the blocking reason. */
  blocked: Array<{ id: string; reason: string }>;
};

export function nextWave(tasks: OrchestrateTask[]): WavePlan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ready: string[] = [];
  const blocked: Array<{ id: string; reason: string }> = [];
  for (const task of tasks) {
    if (task.state === "done" || task.state === "failed") continue;
    const pendingDeps = (task.dependsOn ?? []).filter((dep) => {
      const depTask = byId.get(dep);
      return !depTask || depTask.state !== "done";
    });
    if (pendingDeps.length === 0) {
      ready.push(task.id);
    } else {
      const failedDeps = pendingDeps.filter((dep) => byId.get(dep)?.state === "failed");
      blocked.push({
        id: task.id,
        reason:
          failedDeps.length > 0
            ? `upstream failed: ${failedDeps.join(", ")}`
            : `waiting on: ${pendingDeps.join(", ")}`,
      });
    }
  }
  return { ready, blocked };
}

/** Per guide Part 5: prepend upstream outputs, each truncated to 800 chars. */
export const UPSTREAM_TRUNCATE = 800;

export function buildTaskMessages(task: OrchestrateTask, byId: Map<string, OrchestrateTask>): Array<{ role: string; content: string }> {
  const completedDeps = (task.dependsOn ?? []).filter((dep) => byId.get(dep)?.state === "done");
  if (completedDeps.length === 0) {
    return [{ role: "user", content: task.prompt }];
  }
  const upstream = completedDeps
    .map((dep) => `[${dep}]: ${truncate((byId.get(dep)?.result ?? "") as string, UPSTREAM_TRUNCATE)}`)
    .join("\n");
  return [
    {
      role: "user",
      content: `Upstream outputs:\n${upstream}\n\n---\n\n${task.prompt}`,
    },
  ];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── JobsStore interface + in-memory implementation ──────────────────────────

/** B5 drift-loop result from applyJudgeVerdict. */
export type JudgeDriftResult = {
  /** Total quality penalty now applied to the model (≤ 1 − QUALITY_FLOOR). */
  penalty: number;
  /** True when THIS call crossed/extended the fail streak and penalized. */
  penalized: boolean;
};

export interface JobsStore {
  createJob(job: OrchestrateJob, idempotencyKey: string | null): Promise<OrchestrateJob | "conflict"> | OrchestrateJob | "conflict";
  getJob(jobId: string): Promise<OrchestrateJob | null> | OrchestrateJob | null;
  findByIdempotencyKey(key: string): Promise<OrchestrateJob | null> | OrchestrateJob | null;
  /** Lease a queued task for a wave; false when already leased/terminal. B5: an expired running lease may be stolen (work-stealing). */
  acquireLease(jobId: string, taskId: string, leaseMs: number, now: number): Promise<boolean> | boolean;
  /** B5: requeue running tasks whose lease expired (worker lost); returns the ids. */
  requeueExpiredLeases(jobId: string, now: number): Promise<string[]> | string[];
  /** B5: per-model outcome aggregates across all jobs (allocator health/speed feed). */
  aggregateModelStats(): Promise<Record<string, ModelStat>> | Record<string, ModelStat>;
  /**
   * B12 closed loop: per-(model × task-category) outcome aggregates — the
   * P(success | model, task) feed. Keyed `"<model>|<tag>"`.
   */
  aggregateModelStatsByCategory(): Promise<Record<string, ModelStat>> | Record<string, ModelStat>;
  /** B5: judge-drift quality penalties per model (Part 8 drift loop). */
  getModelPenalties(): Promise<Record<string, number>> | Record<string, number>;
  /** B5: record a judge verdict for a model; penalize on fail streak ≥ 2. */
  applyJudgeVerdict(model: string, passed: boolean): Promise<JudgeDriftResult> | JudgeDriftResult;
  /** Write a terminal or requeue transition. Returns the updated task. */
  writeTaskTransition(jobId: string, taskId: string, patch: Partial<OrchestrateTask>): Promise<OrchestrateTask | null> | OrchestrateTask | null;
  setJobStatus(jobId: string, status: JobStatus, failureReason: string | null): Promise<void> | void;
  /** Swarm: replace the blackboard snapshot (harness-only writes). */
  updateBlackboard(jobId: string, blackboard: Record<string, unknown> | null): Promise<void> | void;
  /** Swarm: persist the judge-round counter. */
  setJudgeRounds(jobId: string, rounds: number): Promise<void> | void;
  /**
   * B10 refill: append queued tasks to an ACTIVE job (the OpenResearch
   * "refill the freed slot" move). Returns the updated job, or:
   *   "job_terminal" — the job is done/failed (nothing running to pick
   *                    the tasks up); the caller 409s and spawns instead
   *   "duplicate_id" — a task id already exists on the job
   *   null           — unknown job
   */
  appendTasks(jobId: string, tasks: OrchestrateTask[]): Promise<OrchestrateJob | "job_terminal" | "duplicate_id" | null> | OrchestrateJob | "job_terminal" | "duplicate_id" | null;
  /**
   * B10 spawn: the parent's child jobs (all states; the spawn route filters
   * ACTIVE for the in-flight cap and the multi-job wait needs terminal
   * visibility).
   */
  listChildJobs(parentJobId: string): Promise<OrchestrateJob[]> | OrchestrateJob[];
  appendLog(entry: Omit<OrchestrateLogEntry, "timestamp">, timestamp: number): Promise<void> | void;
}


/** B13: runtime window (30d); NULL finishedAt (pre-B13 rows) counts as in-window. */
const IN_MEMORY_STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function inMemoryPercentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

function inMemoryTaskStats(
  jobs: IterableIterator<OrchestrateJob>,
  byTag: string | null
): Record<string, ModelStat> {
  const cutoff = Date.now() - IN_MEMORY_STATS_WINDOW_MS;
  const groups = new Map<string, { successes: number; failures: number; infraFailures: number; totalLatencyMs: number; latencies: number[] }>();
  for (const job of jobs) {
    for (const task of job.tasks) {
      if (!task.assignedModel) continue;
      if (task.state !== "done" && task.state !== "failed") continue;
      if (task.finishedAt !== null && task.finishedAt < cutoff) continue;
      const key = byTag === "tag" ? `${task.assignedModel}|${task.tag}` : task.assignedModel;
      let group = groups.get(key);
      if (!group) {
        group = { successes: 0, failures: 0, infraFailures: 0, totalLatencyMs: 0, latencies: [] };
        groups.set(key, group);
      }
      if (task.state === "done") {
        group.successes += 1;
        const latency = task.latencyMs ?? 0;
        group.totalLatencyMs += latency;
        group.latencies.push(latency);
      } else {
        group.failures += 1;
        // B15: routing/infra failures (timeout, provider outage, …) are
        // counted but excused from reputation — an outage must never read
        // as "this model is bad at the task".
        if (!classifyFailure(task.lastError).affectsReputation) group.infraFailures += 1;
      }
    }
  }
  const stats: Record<string, ModelStat> = {};
  for (const [key, group] of groups) {
    const sorted = [...group.latencies].sort((a, b) => a - b);
    stats[key] = {
      successes: group.successes,
      failures: group.failures,
      ...(group.infraFailures > 0 ? { infraFailures: group.infraFailures } : {}),
      totalLatencyMs: group.totalLatencyMs,
      p50LatencyMs: inMemoryPercentile(sorted, 50),
      p95LatencyMs: inMemoryPercentile(sorted, 95),
    };
  }
  return stats;
}

/** In-memory JobsStore — unit tests and any embedder without SQLite. */
export class InMemoryJobsStore implements JobsStore {
  private jobs = new Map<string, OrchestrateJob>();
  private drift = new Map<string, { penalty: number; failStreak: number }>();

  createJob(job: OrchestrateJob, idempotencyKey: string | null): OrchestrateJob | "conflict" {
    if (idempotencyKey) {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) return "conflict";
    }
    const stored = structuredClone(job);
    stored.log.push({
      timestamp: job.createdAt,
      jobId: job.jobId,
      taskId: null,
      event: "job_created",
      detail: `${job.tasks.length} tasks, mode ${job.mode}`,
    });
    this.jobs.set(job.jobId, stored);
    return structuredClone(stored);
  }

  getJob(jobId: string): OrchestrateJob | null {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  findByIdempotencyKey(key: string): OrchestrateJob | null {
    for (const job of this.jobs.values()) {
      if (job.idempotencyKey === key) return structuredClone(job);
    }
    return null;
  }

  acquireLease(jobId: string, taskId: string, leaseMs: number, now: number): boolean {
    const task = this.task(jobId, taskId);
    if (!task) return false;
    if (task.state === "queued") {
      task.state = "running";
      task.leaseUntil = now + leaseMs;
      return true;
    }
    // B5 work-stealing (guide Part 3): a running task whose lease expired
    // means its worker is gone — take the lease over.
    if (task.state === "running" && task.leaseUntil !== null && now > task.leaseUntil) {
      task.leaseUntil = now + leaseMs;
      return true;
    }
    return false;
  }

  requeueExpiredLeases(jobId: string, now: number): string[] {
    const job = this.jobs.get(jobId);
    if (!job) return [];
    const expired: string[] = [];
    for (const task of job.tasks) {
      if (task.state === "running" && task.leaseUntil !== null && now > task.leaseUntil) {
        task.state = "queued";
        task.leaseUntil = null;
        task.lastError = "lease expired (worker lost)";
        expired.push(task.id);
      }
    }
    return expired;
  }

  aggregateModelStats(): Record<string, ModelStat> {
    return inMemoryTaskStats(this.jobs.values(), null);
  }

  aggregateModelStatsByCategory(): Record<string, ModelStat> {
    return inMemoryTaskStats(this.jobs.values(), "tag");
  }

  getModelPenalties(): Record<string, number> {
    const penalties: Record<string, number> = {};
    for (const [model, drift] of this.drift.entries()) {
      if (drift.penalty > 0) penalties[model] = drift.penalty;
    }
    return penalties;
  }

  applyJudgeVerdict(model: string, passed: boolean): JudgeDriftResult {
    const entry = this.drift.get(model) ?? { penalty: 0, failStreak: 0 };
    let penalized = false;
    if (passed) {
      entry.failStreak = 0;
    } else {
      entry.failStreak += 1;
      // Part 8 drift loop: two consecutive failed verdicts → quality −0.05
      // per further fail, floored so quality never drops below 0.3.
      if (entry.failStreak >= 2) {
        // 3-decimal rounding keeps repeated 0.05 steps free of float drift.
        entry.penalty = Math.round(Math.min(entry.penalty + JUDGE_DRIFT_PENALTY, 1 - QUALITY_FLOOR) * 1000) / 1000;
        penalized = true;
      }
    }
    this.drift.set(model, entry);
    return { penalty: entry.penalty, penalized };
  }

  writeTaskTransition(jobId: string, taskId: string, patch: Partial<OrchestrateTask>): OrchestrateTask | null {
    const task = this.task(jobId, taskId);
    if (!task) return null;
    // B13: stamp terminal transitions — the runtime-stats window anchor.
    if (patch.state === "done" || patch.state === "failed") {
      patch = { ...patch, finishedAt: (this as unknown as { nowMs?: () => number }).nowMs?.() ?? Date.now() };
    }
    Object.assign(task, patch);
    // Leaving "running" always releases the lease.
    if (patch.state !== undefined && patch.state !== "running") task.leaseUntil = null;
    return structuredClone(task);
  }

  setJobStatus(jobId: string, status: JobStatus, failureReason: string | null): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = status;
      job.failureReason = failureReason;
    }
  }

  updateBlackboard(jobId: string, blackboard: Record<string, unknown> | null): void {
    const job = this.jobs.get(jobId);
    if (job) job.blackboard = blackboard;
  }

  setJudgeRounds(jobId: string, rounds: number): void {
    const job = this.jobs.get(jobId);
    if (job) job.judgeRounds = rounds;
  }

  appendLog(entry: Omit<OrchestrateLogEntry, "timestamp">, timestamp: number): void {
    const job = this.jobs.get(entry.jobId);
    if (job) job.log.push({ ...entry, timestamp });
  }

  private task(jobId: string, taskId: string): OrchestrateTask | undefined {
    return this.jobs.get(jobId)?.tasks.find((task) => task.id === taskId);
  }

  appendTasks(jobId: string, tasks: OrchestrateTask[]): OrchestrateJob | "job_terminal" | "duplicate_id" | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status !== "active" && job.status !== "judging") return "job_terminal";
    const existing = new Set(job.tasks.map((task) => task.id));
    for (const task of tasks) {
      if (existing.has(task.id)) return "duplicate_id";
    }
    job.tasks.push(...tasks.map((task) => structuredClone(task)));
    return structuredClone(job);
  }

  listChildJobs(parentJobId: string): OrchestrateJob[] {
    const children: OrchestrateJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.parentJobId === parentJobId) children.push(structuredClone(job));
    }
    return children.sort((a, b) => a.createdAt - b.createdAt);
  }
}

// ── Runner (wave loop) ──────────────────────────────────────────────────────

export type TaskDispatch = (input: {
  taskId: string;
  tag: TaskType;
  /** B7: endpoint family for this dispatch (task.modality; media+search route to their endpoint). */
  modality: TaskModality;
  alias: string;
  /** B5: allocator-picked literal model (assigned routing); null → dispatch the alias. */
  assignedModel?: string | null;
  /** Chat-shaped messages (upstream-injected; swarm-wrapped for chat tags). */
  messages: Array<{ role: string; content: string }>;
  /** The effective prompt (what an images dispatch should send). */
  prompt: string;
  timeoutMs: number;
  /** 1-based wave number (B4 trace headers; absent for judge/mailbox). */
  wave?: number;
}) => Promise<
  | {
      ok: true;
      text: string;
      model: string | null;
      provider: string | null;
      /** B6: token usage from the serving response (null = not reported). */
      usage?: { prompt_tokens: number; completion_tokens: number } | null;
    }
  | { ok: false; error: string }
>;

export type RunnerDeps = {
  store: JobsStore;
  dispatch: TaskDispatch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Swarm: override the judge pass's check instruction (manual advance). */
  judgeCheck?: string;
  /**
   * B9 breaker feed: is this provider's circuit breaker open (or
   * half-open)? Drives the allocator's 0.2 multiplier — the plan route
   * passes the provider-keyed registry (src/lib/harness/breakerFeed.ts);
   * absent = no penalty (B5 behavior).
   */
  breakerOpen?: (provider: string) => boolean;
};

export function aliasForTag(tag: TaskType, budget: string): string {
  // B7: media tags self-alias — the dispatch layer resolves the model from
  // the tag index's registry subcategory, not the chat combo machinery.
  if (tag === "image_gen" || tag === "audio_speech" || tag === "music_gen" || tag === "video_gen") {
    return tag;
  }
  return budget === "any" ? tag : `${tag}:${budget}`;
}

const LEASE_MS = 300_000; // floor; a wave's lease is max(LEASE_MS, task_timeout + 30s) — B5 expiry/steal is live

/**
 * B5 allocator candidates for a tag (guide Part 4 step 1-3): the tag index's
 * ranked specialists, quality prior from the axis/benchmark score, budget
 * tier applied (best = top 3, cheap = fast-tier names, any = top 6).
 */
export function candidatesForTag(tag: TaskType, budget: string): AllocatorCandidate[] {
  const spec = CAPABILITY_ALIASES[tag];
  const taskQuery = TASK_TYPE_TO_QUERY[tag];
  const index = getModelTagIndex();
  const limit = budget === "best" ? CAPABILITY_ALIAS_BEST_SIZE : budget === "cheap" ? CAPABILITY_ALIAS_POOL_SIZE : CAPABILITY_ALIAS_SIZE;
  const entries = findModelsByTags(index, {
    category: tag === "image_gen" ? "image-gen" : taskQuery.category,
    requireTools: taskQuery.requireTools,
    requireVision: taskQuery.requireVision,
    axis: spec?.axes[0],
    distinctModels: true,
    diverseProviders: true,
    limit,
  });
  let candidates: AllocatorCandidate[] = entries.map((entry) => {
    const axis = spec?.axes[0];
    const axisScore = axis ? entry.axes?.[axis]?.score : undefined;
    const raw = typeof axisScore === "number" ? axisScore : entry.benchmark?.score;
    const quality = typeof raw === "number" ? Math.max(0, Math.min(1, raw / 100)) : 0.5;
    return { model: entry.id, provider: entry.provider ?? null, quality };
  });
  if (budget === "cheap") {
    const fastTier = candidates.filter((c) => FAST_TIER_PATTERN.test(c.model));
    if (fastTier.length > 0) candidates = fastTier;
  }
  return candidates.slice(0, CAPABILITY_ALIAS_SIZE);
}

type LogFn = (taskId: string | null, event: string, detail?: string | null) => void;

// ── B10 bias guard ─────────────────────────────────────────────────────────

/**
 * B10 bias guard: should the guard engage for this job? Only when the caller
 * named its own model AND policy.bias_guard is not disabled. Absent caller
 * model = no guard (the B3–B9 behavior; unknown caller cannot be biased
 * against).
 */
export function biasGuardActive(job: Pick<OrchestrateJob, "callerModel" | "policy">): boolean {
  return Boolean(job.callerModel) && job.policy.bias_guard !== false;
}

/**
 * B11 pure helper: pick the model to dispatch INSTEAD of the caller's own
 * model, leniently — only when the best alternative's quality is within
 * `tolerance` of the caller candidate's quality (a near-tie). Outside the
 * band the caller's model wins on benchmark merit and this returns null
 * (the task is flagged bias_same_model, never silently avoided or forced
 * onto a worse model). Selection basis stays category + benchmark score +
 * provider identity; the guard only breaks near-ties toward diversity.
 */
export function pickBiasAvoidFromCandidates(
  candidates: AllocatorCandidate[],
  callerModel: string,
  tolerance: number
): string | null {
  const callerPresent = candidates.some((candidate) => candidate.model === callerModel);
  if (!callerPresent) return null;
  if (!biasAvoidApplies(candidates, callerModel, tolerance)) return null;
  const alternative = candidates
    .filter((candidate) => candidate.model !== callerModel)
    .sort((a, b) => b.quality - a.quality)[0];
  return alternative ? alternative.model : null;
}

/**
 * B10 bias guard, alias routing: pick the best tag-viable model that is NOT
 * the caller's model — B11: leniently (see pickBiasAvoidFromCandidates).
 * Media tags self-alias through the dispatch layer's registry ranking, so
 * the guard only engages for chat/search tags.
 */
export function pickBiasAvoidModel(
  tag: TaskType,
  budget: string,
  callerModel: string,
  tolerance: number = BIAS_AVOID_TOLERANCE
): string | null {
  return pickBiasAvoidFromCandidates(candidatesForTag(tag, budget), callerModel, tolerance);
}

/** Wrap a chat task's prompt with the swarm shared context (media/search tasks skip it). */
function effectivePrompt(
  job: OrchestrateJob,
  task: OrchestrateTask,
  byId: Map<string, OrchestrateTask>
): string {
  if (job.mode !== "swarm" || isMediaModality(taskModalityOf(task)) || taskModalityOf(task) === "search") {
    // Parallel mode / media+search tasks: upstream injection only. Search
    // queries are clamped to the endpoint's 500-char limit at dispatch —
    // the swarm wrapper would only eat that budget.
    const messages = buildTaskMessages(task, byId);
    return messages[0].content;
  }
  const partCount = job.tasks.length;
  const partIndex = job.tasks.findIndex((candidate) => candidate.id === task.id) + 1;
  const base = buildTaskMessages(task, byId)[0].content;
  return assembleSwarmPrompt({ goal: job.goal, blackboard: job.blackboard }, { id: task.id, prompt: base }, partIndex, partCount);
}

/**
 * Execute a job to completion: waves (parallel fire, requeue, deadline),
 * then — for swarm mode — the judge loop: verdicts requeue failures with
 * feedback until clean or policy.max_rounds, after which flaws are accepted
 * and logged. Never throws; every step is a logged transition.
 */
export async function runJob(jobId: string, deps: RunnerDeps): Promise<void> {
  const { store, dispatch } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log: LogFn = (taskId, event, detail = null) =>
    void Promise.resolve(store.appendLog({ jobId, taskId, event, detail }, now()));

  const initial = await Promise.resolve(store.getJob(jobId));
  if (!initial || initial.status !== "active") return;

  for (;;) {
    // ── Phase 1: execute until every task is terminal ──
    // B10: stream = per-completion admission (the OpenResearch loop shape —
    // a freed slot refills immediately, results land as they finish); wave
    // (default) = B3 barriers, unchanged.
    const scheduled = await Promise.resolve(store.getJob(jobId));
    if (!scheduled || scheduled.status !== "active") return;
    if (scheduled.policy.scheduling === "stream") {
      await runStream(jobId, deps, log);
    } else {
      await runWaves(jobId, deps, log);
    }

    const job = await Promise.resolve(store.getJob(jobId));
    if (!job) return;
    if (job.status !== "active") return; // deadline/blocked already decided

    // ── Phase 2: judge loop (swarm mode only) ──
    if (job.mode !== "swarm" || !job.policy.judge) {
      await finalize(job, store, log);
      return;
    }
    if (now() >= job.deadlineAt) {
      await Promise.resolve(store.setJobStatus(jobId, "failed", "deadline"));
      log(null, "job_deadline", "deadline exceeded before the judge pass");
      return;
    }
    if (job.judgeRounds >= job.policy.max_rounds) {
      await acceptWithFlaws(job, store, log, "judge rounds exhausted");
      return;
    }

    await Promise.resolve(store.setJobStatus(jobId, "judging", null));
    const round = job.judgeRounds + 1;
    log(null, "judge_start", `round ${round} of ${job.policy.max_rounds}`);

    const judgeInput = buildJudgeMessages(job, { check: deps.judgeCheck });
    let judgeText: string | null = null;
    // B10 bias guard: the judge must not grade its own family — when the
    // caller named its model and the judge tag is tag-viable for it, judge
    // with the best alternative instead (self-grading is the sharpest bias).
    const judgeBiasAvoid =
      biasGuardActive(job) && job.mode === "swarm"
        ? pickBiasAvoidModel(judgeInput.tag, job.policy.budget, job.callerModel as string, job.policy.bias_tolerance)
        : null;
    if (judgeBiasAvoid) {
      log(null, "bias_avoided", `judge: caller model ${job.callerModel} avoided; judging with ${judgeBiasAvoid}`);
    }
    try {
      const outcome = await dispatch({
        taskId: "__judge",
        tag: judgeInput.tag,
        modality: "text",
        alias: aliasForTag(judgeInput.tag, job.policy.budget),
        assignedModel: judgeBiasAvoid,
        messages: judgeInput.messages,
        prompt: judgeInput.messages[0].content,
        timeoutMs: job.policy.task_timeout_ms,
      });
      if (outcome.ok) judgeText = outcome.text;
    } catch {
      judgeText = null;
    }
    const verdicts = judgeText !== null ? parseJudgeVerdicts(judgeText) : null;
    if (!verdicts) {
      log(null, "judge_unparseable", "judge output could not be parsed; accepting parts as-is");
      await finalize(job, store, log);
      return;
    }

    const byId = new Map(job.tasks.map((task) => [task.id, task]));
    const failures = verdicts.filter((verdict) => {
      const task = byId.get(verdict.task_id);
      return task && task.state === "done" && !verdict.pass;
    });
    log(null, "judge_verdicts", `${verdicts.filter((v) => v.pass).length} pass, ${failures.length} fail`);

    // B5 drift loop (guide Part 8): verdicts write back per served model —
    // two consecutive failed verdicts cost quality (floor 0.3), logged.
    for (const verdict of verdicts) {
      const task = byId.get(verdict.task_id);
      if (!task?.assignedModel) continue;
      const drift = await Promise.resolve(store.applyJudgeVerdict(task.assignedModel, verdict.pass));
      if (drift.penalized) {
        log(
          verdict.task_id,
          "model_drift_penalty",
          `${task.assignedModel}: quality −${JUDGE_DRIFT_PENALTY} (judge fail streak), total penalty ${drift.penalty}`
        );
      }
    }

    // The round counts as soon as the pass produced verdicts — clean or not.
    await Promise.resolve(store.setJudgeRounds(jobId, round));

    if (failures.length === 0) {
      await finalize(job, store, log);
      return;
    }

    if (round >= job.policy.max_rounds) {
      // Guide Part 7.4: the last round's output is accepted with flaws
      // recorded in the job log — refinement hard-stops.
      await acceptWithFlaws(await Promise.resolve(store.getJob(jobId)) as OrchestrateJob, store, log, "max_rounds reached");
      return;
    }

    for (const failure of failures) {
      const task = byId.get(failure.task_id) as OrchestrateTask;
      await Promise.resolve(
        store.writeTaskTransition(jobId, task.id, {
          state: "queued",
          attempts: 0,
          prompt: withJudgeFeedback(task.prompt, failure.note, round),
          verdict: failure.note,
          result: null,
        })
      );
      log(task.id, "judge_requeued", failure.note);
    }
    await Promise.resolve(store.setJobStatus(jobId, "active", null));
    // Loop: the failed parts re-run with the verdict injected.
  }
}

/** Wave loop until all tasks are terminal, the job leaves active, or the deadline hits. */
async function runWaves(jobId: string, deps: RunnerDeps, log: LogFn): Promise<void> {
  const { store, dispatch } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let wave = 0;

  for (;;) {
    let current = await Promise.resolve(store.getJob(jobId));
    if (!current || current.status !== "active") return;

    // B5 lease expiry (guide Part 3): a running task whose lease expired
    // lost its worker — requeue it so this (or a later) wave re-dispatches.
    const expired = await Promise.resolve(store.requeueExpiredLeases(jobId, now()));
    if (expired.length > 0) {
      for (const id of expired) log(id, "lease_expired", "worker lost; task requeued");
      current = (await Promise.resolve(store.getJob(jobId))) ?? current;
    }

    if (now() >= current.deadlineAt) {
      await Promise.resolve(store.setJobStatus(jobId, "failed", "deadline"));
      log(null, "job_deadline", "deadline exceeded; remaining tasks stay queued");
      return;
    }

    const plan = nextWave(current.tasks);
    const incomplete = current.tasks.filter((task) => task.state !== "done" && task.state !== "failed");
    if (plan.ready.length === 0) {
      if (incomplete.length === 0) return; // all terminal — judge phase decides
      await Promise.resolve(store.setJobStatus(jobId, "failed", "blocked"));
      log(null, "job_blocked", plan.blocked.map((b) => `${b.id} (${b.reason})`).join("; "));
      return;
    }

    wave += 1;
    const byId = new Map(current.tasks.map((task) => [task.id, task]));
    log(null, "wave_start", `wave ${wave}: ${plan.ready.join(", ")}`);

    const executing = plan.ready.slice(0, current.policy.max_concurrency);
    const deferred = plan.ready.length - executing.length;
    if (deferred > 0) log(null, "wave_deferred", `${deferred} task(s) deferred (max_concurrency ${current.policy.max_concurrency})`);

    const waveResults: Array<{ taskId: string; text: string }> = [];

    // B5 assigned routing (guide Part 4): allocator water-filling over this
    // wave's tasks — quality × health × speed, provider round-robin,
    // max_per_provider. Unassigned tasks fall back to the capability alias
    // (logged — never a silent downgrade, and alias failover is not a
    // downgrade in capability, only in assignment explicitness).
    const assignments = new Map<string, Assignment>();
    if (current.policy.routing === "assigned") {
      const stats = await Promise.resolve(store.aggregateModelStats());
      const statsByCategory = await Promise.resolve(store.aggregateModelStatsByCategory());
      const penalties = await Promise.resolve(store.getModelPenalties());
      const assignTasks = executing
        .map((id) => byId.get(id))
        .filter((task): task is OrchestrateTask => Boolean(task));
      const { assignments: assigned, unassigned } = assignModels(
        assignTasks.map((task) => ({ id: task.id, tag: task.tag })),
        (tag) => candidatesForTag(tag as TaskType, current.policy.budget),
        {
          maxPerProvider: current.policy.max_per_provider,
          // B12 closed loop: per-(model × category) evidence first, the
          // global aggregate as fallback — the allocator learns
          // P(success | model, task), not just P(success | model).
          statOf: (model, tag) => (tag !== undefined ? statsByCategory[`${model}|${tag}`] : undefined) ?? stats[model],
          penaltyOf: (model) => penalties[model] ?? 0,
          // B11 lenient bias guard: the caller's model is penalized only
          // while a near-equal alternative exists (assigned routing path).
          avoidModel: biasGuardActive(current) ? (current.callerModel as string) : undefined,
          avoidTolerance: current.policy.bias_tolerance,
          // B9: the live breaker feed — open providers score ×0.2 (guide
          // Part 8 formula), so a tripped provider stops winning
          // assignments until its breaker recovers.
          breakerOf: (_model, provider) => (provider ? deps.breakerOpen?.(provider) ?? false : false),
        }
      );
      for (const [taskId, assignment] of assigned) {
        assignments.set(taskId, assignment);
        log(
          taskId,
          "task_assigned",
          `${assignment.candidate.model} (${assignment.candidate.provider ?? "?"}) score ${assignment.score.toFixed(2)}`
        );
      }
      for (const un of unassigned) {
        log(un.id, "assign_fallback_alias", `${un.reason}; dispatching the capability alias instead`);
      }
    }

    const leaseMs = Math.max(LEASE_MS, current.policy.task_timeout_ms + 30_000);
    // B6 cost budget: tokens spent across task dispatches so far; once the
    // budget is hit, UNSTARTED tasks abort (guide cross-cutting "abort
    // unstarted tasks on breach") — in-flight dispatches finish.
    const tokenBudget = current.policy.max_total_tokens; // 0 = unlimited
    let usedTokens = current.tasks.reduce(
      (sum, task) => sum + (task.promptTokens ?? 0) + (task.completionTokens ?? 0),
      0
    );
    let budgetExhausted = tokenBudget > 0 && usedTokens >= tokenBudget;
    let budgetAborted = 0;
    await Promise.all(
      executing.map(async (taskId) => {
        const task = byId.get(taskId);
        if (!task) return;
        if (budgetExhausted) {
          await Promise.resolve(
            store.writeTaskTransition(jobId, taskId, {
              state: "failed",
              lastError: `budget exhausted (max_total_tokens ${tokenBudget})`,
            })
          );
          log(taskId, "task_budget_aborted", "unstarted; token budget reached");
          budgetAborted += 1;
          return;
        }
        const leased = await Promise.resolve(store.acquireLease(jobId, taskId, leaseMs, now()));
        if (!leased) return;
        log(taskId, "task_start", `attempt ${task.attempts + 1}`);

        let prompt = effectivePrompt(current, task, byId);
        const alias = aliasForTag(task.tag, current.policy.budget);
        const assignment = assignments.get(taskId);
        // B10 bias guard, alias routing: when the caller named its model and
        // the tag's candidate pool contains it, dispatch the best ALTERNATIVE
        // instead — same tag viability, no self-preference. No alternative →
        // the alias dispatches as-is and jobToApi flags bias_same_model.
        let biasAvoidModel: string | null = null;
        if (!assignment && biasGuardActive(current) && (task.modality ?? MODALITY_BY_TAG[task.tag]) === "text") {
          biasAvoidModel = pickBiasAvoidModel(task.tag, current.policy.budget, current.callerModel as string, current.policy.bias_tolerance);
          if (biasAvoidModel) {
            log(taskId, "bias_avoided", `caller model ${current.callerModel} is near-tied; dispatching ${biasAvoidModel} instead`);
          }
        }
        const started = now();
        const modality = taskModalityOf(task);
        // B8: compress the swarm context before fan-out (opt-in policy; text
        // dispatches only — media prompts are endpoint inputs, not prose).
        if (current.policy.compress_context && current.mode === "swarm" && modality === "text") {
          const compressed = compressSwarmContext(prompt);
          if (compressed.applied) {
            prompt = compressed.text;
            log(
              taskId,
              "context_compressed",
              `${compressed.originalTokens}→${compressed.compressedTokens} tokens (caveman/lite)`
            );
          }
        }

        // OpenDev worktree integration: provision isolated git worktree & sync blackboard
        let worktreeSession: WorktreeSession | null = null;
        if (current.policy.execution_target === "opendev" || modality === "worktree") {
          worktreeSession = await ensureTaskWorktree(current.policy.project_id || "default", taskId);
          if (worktreeSession) {
            log(taskId, "worktree_allocated", `branch: ${worktreeSession.branchName}`);
            await syncBlackboardToWorktree(worktreeSession, current.blackboard);
          }
        }

        // B15: the model this dispatch targets (outcome.model is absent on
        // errors — the routing cache still needs to know who failed).
        const dispatchModel = assignment?.candidate.model ?? biasAvoidModel ?? null;
        let outcome: Awaited<ReturnType<TaskDispatch>>;
        try {
          outcome = await dispatch({
            taskId,
            tag: task.tag,
            modality,
            alias,
            assignedModel: dispatchModel,
            messages: [{ role: "user", content: prompt }],
            prompt,
            timeoutMs: current.policy.task_timeout_ms,
            wave,
          });
        } catch (error) {
          outcome = { ok: false, error: error instanceof Error ? error.message : "dispatch threw" };
        }
        const latency = now() - started;

        if (outcome.ok) {
          // If worktree verification is enabled, run detached supervisor
          if (worktreeSession && current.policy.verify_supervisor) {
            log(taskId, "supervisor_verification_start", "Running detached test runner in worktree");
            const verifyRun = await triggerWorktreeVerification(worktreeSession, current.policy.verify_command);
            if (verifyRun) {
              const verifyOutcome = await waitForVerification(verifyRun.runId, current.policy.task_timeout_ms);
              if (verifyOutcome.status !== "succeeded") {
                log(taskId, "supervisor_verification_failed", `Exit code ${verifyOutcome.exitCode ?? "?"}`);
                outcome = {
                  ok: false,
                  error: `Verification tests failed (exit code ${verifyOutcome.exitCode}):\n${verifyOutcome.log.slice(0, 1000)}`,
                };
              } else {
                log(taskId, "supervisor_verification_passed", "All tests passed in worktree");
                const diff = await getSessionWorktreeDiff(worktreeSession);
                if (diff?.filesChanged?.length) {
                  outcome.text += `\n\n[Worktree Commits]: Modified ${diff.filesChanged.length} files (${diff.filesChanged.join(", ")})`;
                }
              }
            }
          }
        }

        if (outcome.ok) {
          waveResults.push({ taskId, text: outcome.text });
          const usage = outcome.usage ?? null;
          if (usage) {
            // Visible to later tasks in THIS wave (single-threaded mutations).
            usedTokens += usage.prompt_tokens + usage.completion_tokens;
            if (tokenBudget > 0 && usedTokens >= tokenBudget) budgetExhausted = true;
          }
          await Promise.resolve(
            store.writeTaskTransition(jobId, taskId, {
              state: "done",
              wave,
              assignedModel: outcome.model,
              assignedProvider: outcome.provider,
              result: outcome.text,
              latencyMs: latency,
              lastError: null,
              promptTokens: usage ? usage.prompt_tokens : null,
              completionTokens: usage ? usage.completion_tokens : null,
            })
          );
          // B15: feed the routing cache's task-conditioned memory.
          recordRoutingOutcome(taskSignature({ type: task.tag, modality: task.modality }), outcome.model ?? dispatchModel, true, true);
          log(taskId, "task_done", `${latency}ms via ${outcome.model ?? alias}`);
        } else {
          const attempts = task.attempts + 1;
          if (attempts >= current.policy.max_attempts) {
            await Promise.resolve(
              store.writeTaskTransition(jobId, taskId, { state: "failed", attempts, wave, lastError: outcome.error })
            );
            // B15: a reputation failure invalidates the cached routing
            // decision (route immediately next time); infra failures are
            // recorded but kept — the model choice wasn't wrong.
            recordRoutingOutcome(
              taskSignature({ type: task.tag, modality: task.modality }),
              dispatchModel,
              false,
              classifyFailure(outcome.error).affectsReputation
            );
            log(taskId, "task_failed", `attempts exhausted (${attempts}): ${outcome.error}`);
          } else {
            await Promise.resolve(store.writeTaskTransition(jobId, taskId, { state: "queued", attempts, lastError: outcome.error }));
            log(taskId, "task_requeued", `attempt ${attempts} failed: ${outcome.error}`);
          }
        }
      })
    );

    // B6: a breached budget ends the job as failed (deadline semantics) —
    // in-flight results stay visible in the task rows. Deferred (not yet
    // dispatched) tasks are swept too — no task stays queued on a dead job.
    if (budgetAborted > 0) {
      const afterWave = await Promise.resolve(store.getJob(jobId));
      const deferred = afterWave?.tasks.filter((task) => task.state === "queued") ?? [];
      for (const task of deferred) {
        await Promise.resolve(
          store.writeTaskTransition(jobId, task.id, {
            state: "failed",
            lastError: `budget exhausted (max_total_tokens ${tokenBudget})`,
          })
        );
        log(task.id, "task_budget_aborted", "unstarted; token budget reached");
        budgetAborted += 1;
      }
      log(
        null,
        "job_budget_exhausted",
        `${budgetAborted} task(s) aborted unstarted; ${usedTokens} tokens used of ${tokenBudget}`
      );
      await Promise.resolve(store.setJobStatus(jobId, "failed", "budget_exhausted"));
      return;
    }

    // ── Post-wave swarm bookkeeping: blackboard + bounded mailbox ──
    if (current.mode === "swarm" && waveResults.length > 0) {
      const appends = waveResults.map(({ taskId, text }) => ({ taskId, summary: parseSummary(text) }));
      const merged = mergeIntoBlackboard(current.blackboard, appends);
      await Promise.resolve(store.updateBlackboard(jobId, merged));
      for (const append of appends) {
        log(append.taskId, "blackboard_append", truncateLog(append.summary));
      }

      // Bounded A2A: one question per worker per wave, relayed by the harness
      // (30s timeout; unanswered → the asker proceeds with a note).
      const asked = new Set<string>();
      for (const { taskId, text } of waveResults) {
        if (asked.has(taskId)) continue;
        const directives = parseAskDirectives(taskId, text);
        if (directives.length === 0) continue;
        const ask = directives[0];
        // Fresh state: the target may have completed in THIS wave (the
        // pre-wave snapshot would still show it queued).
        const fresh = await Promise.resolve(store.getJob(jobId));
        const target = fresh?.tasks.find((task) => task.id === ask.to);
        if (!target || target.state !== "done") {
          log(taskId, "mailbox_skipped", `@ask target "${ask.to}" has no completed output`);
          continue;
        }
        // B7: media tasks have no chat model behind them — @ask would
        // dispatch a question to an images/music/speech endpoint. Skip.
        if (isMediaModality(taskModalityOf(target))) {
          log(taskId, "mailbox_skipped", `@ask target "${ask.to}" is a media task (${taskModalityOf(target)}) and cannot answer`);
          continue;
        }
        asked.add(taskId);
        const answer = await relayQuestion(jobId, ask, target, deps, log);
        const updated = await Promise.resolve(store.getJob(jobId));
        const withAnswer = appendMailboxAnswer(updated?.blackboard ?? null, { from: ask.from, to: ask.to, question: ask.question, answer });
        await Promise.resolve(store.updateBlackboard(jobId, withAnswer));
        log(taskId, "mailbox_relayed", `to ${ask.to}: ${truncateLog(answer)}`);
      }
    }

    await sleep(0);
  }
}

/**
 * B10 stream scheduler (OpenResearch auto-research loop shape): per-completion
 * admission instead of wave barriers. The moment ANY task finishes, the next
 * ready task starts in the freed slot — slots fill continuously up to
 * max_concurrency, and each completion lands its bookkeeping immediately
 * (blackboard merge + mailbox relay per finish, not per wave), so later
 * tasks always see the freshest upstream evidence.
 *
 * Deliberately a parallel of runWaves rather than a refactor of it: both
 * schedulers share every building block (effectivePrompt, leases, requeue,
 * deadline, budget, bias guard, worktrees) and differ ONLY in admission
 * discipline — the wave path is the battle-tested B3–B9 surface and stays
 * byte-for-byte behaviorally identical.
 *
 * task.wave carries the 1-based dispatch ORDINAL in stream mode (each task
 * its own row in jobToApi's waves view) — a tracing convenience, not a
 * barrier.
 */
async function runStream(jobId: string, deps: RunnerDeps, log: LogFn): Promise<void> {
  const { store, dispatch } = deps;
  const now = deps.now ?? Date.now;
  let ordinal = 0;
  const inflight = new Map<string, Promise<void>>();
  // B11: run-scoped model diversity — assigned routing in stream mode never
  // calls the same model twice while alternatives remain ("best of A, best
  // of B…" across the WHOLE job, not per wave).
  const usedModels = new Set<string>();
  /** Per-completion swarm bookkeeping (the "analyze each finish as it lands" move). */
  const onCompletion = async (taskId: string, text: string | null): Promise<void> => {
    if (text === null) return;
    const job = await Promise.resolve(store.getJob(jobId));
    if (!job || job.mode !== "swarm") return;
    const summary = parseSummary(text);
    const merged = mergeIntoBlackboard(job.blackboard, [{ taskId, summary }]);
    await Promise.resolve(store.updateBlackboard(jobId, merged));
    log(taskId, "blackboard_append", truncateLog(summary));
    // Bounded A2A: one question per completed worker, relayed immediately.
    const directives = parseAskDirectives(taskId, text);
    if (directives.length === 0) return;
    const ask = directives[0];
    const fresh = await Promise.resolve(store.getJob(jobId));
    const target = fresh?.tasks.find((task) => task.id === ask.to);
    if (!target || target.state !== "done") {
      log(taskId, "mailbox_skipped", `@ask target "${ask.to}" has no completed output`);
      return;
    }
    if (isMediaModality(taskModalityOf(target))) {
      log(taskId, "mailbox_skipped", `@ask target "${ask.to}" is a media task (${taskModalityOf(target)}) and cannot answer`);
      return;
    }
    const answer = await relayQuestion(jobId, ask, target, deps, log);
    const updated = await Promise.resolve(store.getJob(jobId));
    const withAnswer = appendMailboxAnswer(updated?.blackboard ?? null, { from: ask.from, to: ask.to, question: ask.question, answer });
    await Promise.resolve(store.updateBlackboard(jobId, withAnswer));
    log(taskId, "mailbox_relayed", `to ${ask.to}: ${truncateLog(answer)}`);
  };

  for (;;) {
    let current = await Promise.resolve(store.getJob(jobId));
    if (!current || current.status !== "active") return;

    const expired = await Promise.resolve(store.requeueExpiredLeases(jobId, now()));
    if (expired.length > 0) {
      for (const id of expired) log(id, "lease_expired", "worker lost; task requeued");
      current = (await Promise.resolve(store.getJob(jobId))) ?? current;
    }

    if (now() >= current.deadlineAt) {
      await Promise.resolve(store.setJobStatus(jobId, "failed", "deadline"));
      log(null, "job_deadline", "deadline exceeded; remaining tasks stay queued");
      return;
    }

    const running = current.tasks.filter((task) => task.state === "running");
    const plan = nextWave(current.tasks);
    const incomplete = current.tasks.filter((task) => task.state !== "done" && task.state !== "failed");

    // B6 budget (stream semantics): once the budget is hit no NEW tasks are
    // admitted; in-flight dispatches finish; remaining queued tasks abort
    // unstarted — identical to the wave-path sweep.
    const tokenBudget = current.policy.max_total_tokens;
    const usedTokens = current.tasks.reduce(
      (sum, task) => sum + (task.promptTokens ?? 0) + (task.completionTokens ?? 0),
      0
    );
    const budgetExhausted = tokenBudget > 0 && usedTokens >= tokenBudget;
    if (budgetExhausted && inflight.size === 0) {
      let aborted = 0;
      for (const task of current.tasks.filter((task) => task.state === "queued")) {
        await Promise.resolve(
          store.writeTaskTransition(jobId, task.id, {
            state: "failed",
            lastError: `budget exhausted (max_total_tokens ${tokenBudget})`,
          })
        );
        log(task.id, "task_budget_aborted", "unstarted; token budget reached");
        aborted += 1;
      }
      if (aborted > 0) {
        log(null, "job_budget_exhausted", `${aborted} task(s) aborted unstarted; ${usedTokens} tokens used of ${tokenBudget}`);
        await Promise.resolve(store.setJobStatus(jobId, "failed", "budget_exhausted"));
        return;
      }
    }

    // Admission: fill every free slot with the next ready task. In-flight =
    // the UNION of state-running tasks and this loop's tracked launches
    // (they overlap; counting both double-books a slot and reintroduces the
    // barrier this scheduler exists to remove).
    const byId = new Map(current.tasks.map((task) => [task.id, task]));
    if (!budgetExhausted) {
      const inFlightIds = new Set<string>([...running.map((task) => task.id), ...inflight.keys()]);
      const ready = plan.ready.filter((id) => !inFlightIds.has(id));
      let slots = current.policy.max_concurrency - inFlightIds.size;
      if (slots > 0 && ready.length > 0) {
        log(null, "stream_admit", `admitting ${Math.min(slots, ready.length)} task(s); ${inFlightIds.size} in flight`);
      }
      // B11: assigned routing in stream mode — allocate the admission batch
      // with the run-scoped usedModels so parallel tasks spread across
      // models (the lenient bias guard applies inside the allocator).
      const admissionAssignments = new Map<string, Assignment>();
      if (slots > 0 && ready.length > 0 && current.policy.routing === "assigned") {
        const stats = await Promise.resolve(store.aggregateModelStats());
        const statsByCategory = await Promise.resolve(store.aggregateModelStatsByCategory());
        const penalties = await Promise.resolve(store.getModelPenalties());
        const admissionTasks = ready
          .slice(0, slots)
          .map((id) => byId.get(id))
          .filter((task): task is OrchestrateTask => Boolean(task));
        const { assignments: assigned, unassigned } = assignModels(
          admissionTasks.map((task) => ({ id: task.id, tag: task.tag })),
          (tag) => candidatesForTag(tag as TaskType, current.policy.budget),
          {
            maxPerProvider: current.policy.max_per_provider,
            statOf: (model, tag) => (tag !== undefined ? statsByCategory[`${model}|${tag}`] : undefined) ?? stats[model],
            penaltyOf: (model) => penalties[model] ?? 0,
            avoidModel: biasGuardActive(current) ? (current.callerModel as string) : undefined,
            avoidTolerance: current.policy.bias_tolerance,
            usedModels,
            breakerOf: (_model, provider) => (provider ? deps.breakerOpen?.(provider) ?? false : false),
          }
        );
        for (const [taskId, assignment] of assigned) {
          admissionAssignments.set(taskId, assignment);
          log(
            taskId,
            "task_assigned",
            `${assignment.candidate.model} (${assignment.candidate.provider ?? "?"}) score ${assignment.score.toFixed(2)}`
          );
        }
        for (const un of unassigned) {
          log(un.id, "assign_fallback_alias", `${un.reason}; dispatching the capability alias instead`);
        }
      }
      while (slots > 0 && ready.length > 0) {
        const taskId = ready.shift() as string;
        const task = byId.get(taskId);
        if (!task) continue;
        slots -= 1;
        ordinal += 1;
        const dispatchOrdinal = ordinal;
        const launch = (async () => {
          const leaseMs = Math.max(LEASE_MS, current.policy.task_timeout_ms + 30_000);
          const leased = await Promise.resolve(store.acquireLease(jobId, taskId, leaseMs, now()));
          if (!leased) return;
          log(taskId, "task_start", `attempt ${task.attempts + 1}`);

          let prompt = effectivePrompt(current, task, byId);
          const alias = aliasForTag(task.tag, current.policy.budget);
          const assignment = admissionAssignments.get(taskId) ?? null;
          // B11 lenient bias guard, alias routing (near-ties diversify;
          // clear benchmark superiority wins and is flagged, not forced away).
          let biasAvoidModel: string | null = null;
          if (!assignment && biasGuardActive(current) && (task.modality ?? MODALITY_BY_TAG[task.tag]) === "text") {
            biasAvoidModel = pickBiasAvoidModel(task.tag, current.policy.budget, current.callerModel as string, current.policy.bias_tolerance);
            if (biasAvoidModel) {
              log(taskId, "bias_avoided", `caller model ${current.callerModel} is near-tied; dispatching ${biasAvoidModel} instead`);
            }
          }
          const started = now();
          const modality = taskModalityOf(task);
          if (current.policy.compress_context && current.mode === "swarm" && modality === "text") {
            const compressed = compressSwarmContext(prompt);
            if (compressed.applied) {
              prompt = compressed.text;
              log(taskId, "context_compressed", `${compressed.originalTokens}→${compressed.compressedTokens} tokens (caveman/lite)`);
            }
          }

          let worktreeSession: WorktreeSession | null = null;
          if (current.policy.execution_target === "opendev" || modality === "worktree") {
            worktreeSession = await ensureTaskWorktree(current.policy.project_id || "default", taskId);
            if (worktreeSession) {
              log(taskId, "worktree_allocated", `branch: ${worktreeSession.branchName}`);
              await syncBlackboardToWorktree(worktreeSession, current.blackboard);
            }
          }

          // B15: the model this dispatch targets (outcome.model is absent
          // on errors — the routing cache still needs to know who failed).
          const dispatchModel = assignment?.candidate.model ?? biasAvoidModel ?? null;
          let outcome: Awaited<ReturnType<TaskDispatch>>;
          try {
            outcome = await dispatch({
              taskId,
              tag: task.tag,
              modality,
              alias,
              assignedModel: dispatchModel,
              messages: [{ role: "user", content: prompt }],
              prompt,
              timeoutMs: current.policy.task_timeout_ms,
              wave: dispatchOrdinal,
            });
          } catch (error) {
            outcome = { ok: false, error: error instanceof Error ? error.message : "dispatch threw" };
          }
          const latency = now() - started;

          if (outcome.ok && worktreeSession && current.policy.verify_supervisor) {
            log(taskId, "supervisor_verification_start", "Running detached test runner in worktree");
            const verifyRun = await triggerWorktreeVerification(worktreeSession, current.policy.verify_command);
            if (verifyRun) {
              const verifyOutcome = await waitForVerification(verifyRun.runId, current.policy.task_timeout_ms);
              if (verifyOutcome.status !== "succeeded") {
                log(taskId, "supervisor_verification_failed", `Exit code ${verifyOutcome.exitCode ?? "?"}`);
                outcome = {
                  ok: false,
                  error: `Verification tests failed (exit code ${verifyOutcome.exitCode}):\n${verifyOutcome.log.slice(0, 1000)}`,
                };
              } else {
                log(taskId, "supervisor_verification_passed", "All tests passed in worktree");
                const diff = await getSessionWorktreeDiff(worktreeSession);
                if (diff?.filesChanged?.length) {
                  outcome.text += `\n\n[Worktree Commits]: Modified ${diff.filesChanged.length} files (${diff.filesChanged.join(", ")})`;
                }
              }
            }
          }

          if (outcome.ok) {
            const usage = outcome.usage ?? null;
            await Promise.resolve(
              store.writeTaskTransition(jobId, taskId, {
                state: "done",
                wave: dispatchOrdinal,
                assignedModel: outcome.model,
                assignedProvider: outcome.provider,
                result: outcome.text,
                latencyMs: latency,
                lastError: null,
                promptTokens: usage ? usage.prompt_tokens : null,
                completionTokens: usage ? usage.completion_tokens : null,
              })
            );
            recordRoutingOutcome(taskSignature({ type: task.tag, modality: task.modality }), outcome.model ?? dispatchModel, true, true);
            log(taskId, "task_done", `${latency}ms via ${outcome.model ?? alias}`);
            await onCompletion(taskId, outcome.text);
          } else {
            const attempts = task.attempts + 1;
            if (attempts >= current.policy.max_attempts) {
              await Promise.resolve(
                store.writeTaskTransition(jobId, taskId, { state: "failed", attempts, wave: dispatchOrdinal, lastError: outcome.error })
              );
              // B15: reputation failure invalidates the cached routing
              // decision; infra failures are recorded but kept.
              recordRoutingOutcome(
                taskSignature({ type: task.tag, modality: task.modality }),
                dispatchModel,
                false,
                classifyFailure(outcome.error).affectsReputation
              );
              log(taskId, "task_failed", `attempts exhausted (${attempts}): ${outcome.error}`);
            } else {
              await Promise.resolve(store.writeTaskTransition(jobId, taskId, { state: "queued", attempts, lastError: outcome.error }));
              log(taskId, "task_requeued", `attempt ${attempts} failed: ${outcome.error}`);
            }
          }
        })();
        const tracked = launch.finally(() => {
          inflight.delete(taskId);
        });
        inflight.set(taskId, tracked);
      }
    }

    // Nothing in flight and nothing admittable: drained (judge phase decides)
    // or genuinely blocked (failed deps, nothing running).
    if (inflight.size === 0) {
      if (plan.ready.length === 0) {
        if (incomplete.length === 0) return;
        await Promise.resolve(store.setJobStatus(jobId, "failed", "blocked"));
        log(null, "job_blocked", plan.blocked.map((b) => `${b.id} (${b.reason})`).join("; "));
        return;
      }
      if (budgetExhausted) continue; // sweep path above handles it next tick
      continue; // lease lost between read and acquire — retry admission
    }

    // Wait for the FIRST completion, then loop: reconcile fresh state and
    // refill the freed slot. The wait is the wake-up signal, not the source
    // of truth — every transition is re-read from the store on loop top.
    await Promise.race(inflight.values());
  }
}

async function relayQuestion(
  jobId: string,
  ask: { from: string; to: string; question: string },
  target: OrchestrateTask,
  deps: RunnerDeps,
  log: LogFn
): Promise<string> {
  const { dispatch } = deps;
  try {
    const outcome = await dispatch({
      taskId: `__mailbox_${ask.from}`,
      tag: target.tag,
      modality: "text",
      alias: aliasForTag(target.tag, "any"),
      messages: [{ role: "user", content: buildAskPrompt(ask, target) }],
      prompt: buildAskPrompt(ask, target),
      timeoutMs: MAILBOX_TIMEOUT_MS,
    });
    if (outcome.ok) return outcome.text.trim().slice(0, 2000);
    return "(unanswered — proceed with a note)";
  } catch {
    log(ask.from, "mailbox_timeout", `question to ${ask.to} went unanswered`);
    return "(unanswered — proceed with a note)";
  }
}

function truncateLog(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}

async function finalize(job: OrchestrateJob, store: JobsStore, log: LogFn): Promise<void> {
  const failed = job.tasks.filter((task) => task.state === "failed");
  await Promise.resolve(store.setJobStatus(job.jobId, "done", failed.length > 0 ? `${failed.length} task(s) failed` : null));
  log(null, "job_done", failed.length > 0 ? `completed with failed tasks: ${failed.map((t) => t.id).join(", ")}` : null);
}

async function acceptWithFlaws(job: OrchestrateJob, store: JobsStore, log: LogFn, reason: string): Promise<void> {
  const flawed = job.tasks.filter((task) => task.verdict && task.state === "done");
  await Promise.resolve(store.setJobStatus(job.jobId, "done", flawed.length > 0 ? `accepted with judge flaws (${reason})` : null));
  for (const task of flawed) {
    log(task.id, "task_flaw_accepted", task.verdict as string);
  }
  log(null, "job_done", `judge refinement hard-stopped: ${reason}`);
}

/** Serialize a job for the jobs API (Guide 1 Part 6 shape). */
export function jobToApi(job: OrchestrateJob): Record<string, unknown> {
  const waves = new Map<number, string[]>();
  for (const task of job.tasks) {
    if (task.wave !== null) {
      waves.set(task.wave, [...(waves.get(task.wave) ?? []), task.id]);
    }
  }
  // B6: token usage across task dispatches (judge/mailbox overhead excluded).
  const promptTokens = job.tasks.reduce((sum, task) => sum + (task.promptTokens ?? 0), 0);
  const completionTokens = job.tasks.reduce((sum, task) => sum + (task.completionTokens ?? 0), 0);
  return {
    job_id: job.jobId,
    status: job.status,
    goal: job.goal,
    mode: job.mode,
    failure_reason: job.failureReason,
    judge_rounds: job.judgeRounds,
    blackboard: job.blackboard ?? null,
    // B10: lineage + bias visibility. caller_model is what the brain named
    // itself; bias_same_model marks tasks that STILL ran on it (no viable
    // alternative existed) so the bias is visible, never silent.
    caller_model: job.callerModel,
    parent_job_id: job.parentJobId,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      budget_tokens: job.policy.max_total_tokens > 0 ? job.policy.max_total_tokens : null,
    },
    waves: [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([n, tasks]) => ({ n, tasks })),
    tasks: job.tasks.map((task) => ({
      id: task.id,
      tag: task.tag,
      modality: task.modality,
      state: task.state,
      depends_on: task.dependsOn,
      model: task.assignedModel,
      provider: task.assignedProvider,
      wave: task.wave,
      attempts: task.attempts,
      latency_ms: task.latencyMs,
      prompt_tokens: task.promptTokens,
      completion_tokens: task.completionTokens,
      verdict: task.verdict,
      error: task.lastError,
      result: task.result,
      bias_same_model: job.callerModel !== null && task.assignedModel === job.callerModel,
    })),
    log: job.log.slice(-100),
  };
}
