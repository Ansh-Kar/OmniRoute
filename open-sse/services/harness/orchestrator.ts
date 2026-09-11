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
import {
  assignModels,
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

// ── Types ───────────────────────────────────────────────────────────────────

export type OrchestrateTaskSpec = {
  id: string;
  tag: string;
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
} as const;

/** Guide 1 Part 9 acceptance uses 6-task plans; the swarm #1905 cap is 40. */
export const ORCHESTRATE_MAX_TASKS = 40;

// ── Admission validation (replaces validate_plan.py) ────────────────────────

export type PlanValidation =
  | { ok: true; tasks: Array<OrchestrateTaskSpec & { tag: TaskType; modality: TaskModality }>; mode: "parallel" | "swarm"; policy: Required<OrchestratePolicy>; goal: string; blackboard: Record<string, unknown> | null }
  | { ok: false; errors: string[] };

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
  const normalized: Array<OrchestrateTaskSpec & { tag: TaskType; modality: TaskModality }> = [];
  for (const [index, task] of tasks.entries()) {
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
  };
  return {
    ok: true,
    tasks: normalized,
    mode: (mode ?? "parallel") as "parallel" | "swarm",
    policy,
    goal,
    blackboard: body.blackboard && typeof body.blackboard === "object" ? body.blackboard : null,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
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
  appendLog(entry: Omit<OrchestrateLogEntry, "timestamp">, timestamp: number): Promise<void> | void;
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
    const stats: Record<string, ModelStat> = {};
    for (const job of this.jobs.values()) {
      for (const task of job.tasks) {
        if (!task.assignedModel) continue;
        const stat = (stats[task.assignedModel] ??= { successes: 0, failures: 0, totalLatencyMs: 0 });
        if (task.state === "done") {
          stat.successes += 1;
          stat.totalLatencyMs += task.latencyMs ?? 0;
        } else if (task.state === "failed") {
          stat.failures += 1;
        }
      }
    }
    return stats;
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
    // ── Phase 1: waves until every task is terminal ──
    await runWaves(jobId, deps, log);

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
    try {
      const outcome = await dispatch({
        taskId: "__judge",
        tag: judgeInput.tag,
        modality: "text",
        alias: aliasForTag(judgeInput.tag, job.policy.budget),
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
      const penalties = await Promise.resolve(store.getModelPenalties());
      const assignTasks = executing
        .map((id) => byId.get(id))
        .filter((task): task is OrchestrateTask => Boolean(task));
      const { assignments: assigned, unassigned } = assignModels(
        assignTasks.map((task) => ({ id: task.id, tag: task.tag })),
        (tag) => candidatesForTag(tag as TaskType, current.policy.budget),
        {
          maxPerProvider: current.policy.max_per_provider,
          statOf: (model) => stats[model],
          penaltyOf: (model) => penalties[model] ?? 0,
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

        let outcome: Awaited<ReturnType<TaskDispatch>>;
        try {
          outcome = await dispatch({
            taskId,
            tag: task.tag,
            modality,
            alias,
            assignedModel: assignment?.candidate.model ?? null,
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
          log(taskId, "task_done", `${latency}ms via ${outcome.model ?? alias}`);
        } else {
          const attempts = task.attempts + 1;
          if (attempts >= current.policy.max_attempts) {
            await Promise.resolve(
              store.writeTaskTransition(jobId, taskId, { state: "failed", attempts, wave, lastError: outcome.error })
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
    })),
    log: job.log.slice(-100),
  };
}
