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

import { isTaskType, TASK_TYPES, type TaskType } from "../modelTags/index.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type OrchestrateTaskSpec = {
  id: string;
  tag: string;
  prompt: string;
  depends_on?: string[];
};

export type OrchestratePolicy = {
  budget?: string; // any | best | cheap (B2 tiers)
  max_attempts?: number; // default 3
  max_concurrency?: number; // default 8 (wave parallelism)
  deadline_s?: number; // default 600
  task_timeout_ms?: number; // default 120000
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

export type OrchestrateTask = {
  jobId: string;
  id: string;
  tag: TaskType;
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
} as const;

/** Guide 1 Part 9 acceptance uses 6-task plans; the swarm #1905 cap is 40. */
export const ORCHESTRATE_MAX_TASKS = 40;

// ── Admission validation (replaces validate_plan.py) ────────────────────────

export type PlanValidation =
  | { ok: true; tasks: Array<OrchestrateTaskSpec & { tag: TaskType }>; mode: "parallel" | "swarm"; policy: Required<OrchestratePolicy>; goal: string; blackboard: Record<string, unknown> | null }
  | { ok: false; errors: string[] };

export function validatePlan(body: OrchestratePlanBody): PlanValidation {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return { ok: false, errors: ["body must be an object"] };

  const mode = body.mode === "swarm" ? "swarm" : body.mode === "parallel" || body.mode == null ? "parallel" : null;
  if (mode === null) errors.push(`mode must be "parallel" or "swarm" (got "${body.mode}")`);
  if (mode === "swarm") {
    // Validated and accepted as a plan shape, but execution lands in B3.5.
    errors.push('mode "swarm" (blackboard + judge loop) lands in the next build — use "parallel" for now');
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
  const normalized: Array<OrchestrateTaskSpec & { tag: TaskType }> = [];
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
    const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];
    normalized.push({ ...task, tag: task.tag, depends_on: dependsOn, prompt: task.prompt });
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

export interface JobsStore {
  createJob(job: OrchestrateJob, idempotencyKey: string | null): Promise<OrchestrateJob | "conflict"> | OrchestrateJob | "conflict";
  getJob(jobId: string): Promise<OrchestrateJob | null> | OrchestrateJob | null;
  findByIdempotencyKey(key: string): Promise<OrchestrateJob | null> | OrchestrateJob | null;
  /** Lease a queued task for a wave; false when already leased/terminal. */
  acquireLease(jobId: string, taskId: string, leaseMs: number, now: number): Promise<boolean> | boolean;
  /** Write a terminal or requeue transition. Returns the updated task. */
  writeTaskTransition(jobId: string, taskId: string, patch: Partial<OrchestrateTask>): Promise<OrchestrateTask | null> | OrchestrateTask | null;
  setJobStatus(jobId: string, status: JobStatus, failureReason: string | null): Promise<void> | void;
  appendLog(entry: Omit<OrchestrateLogEntry, "timestamp">, timestamp: number): Promise<void> | void;
}

/** In-memory JobsStore — unit tests and any embedder without SQLite. */
export class InMemoryJobsStore implements JobsStore {
  private jobs = new Map<string, OrchestrateJob>();

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

  acquireLease(jobId: string, taskId: string, _leaseMs: number, _now: number): boolean {
    // Expired-lease requeue (guide Part 3 work-stealing) is B3.5; single
    // runner per job in B3, so a lease is simply a queued→running CAS.
    void _leaseMs;
    void _now;
    const task = this.task(jobId, taskId);
    if (!task || task.state !== "queued") return false;
    task.state = "running";
    return true;
  }

  writeTaskTransition(jobId: string, taskId: string, patch: Partial<OrchestrateTask>): OrchestrateTask | null {
    const task = this.task(jobId, taskId);
    if (!task) return null;
    Object.assign(task, patch);
    return structuredClone(task);
  }

  setJobStatus(jobId: string, status: JobStatus, failureReason: string | null): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = status;
      job.failureReason = failureReason;
    }
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
  tag: TaskType;
  alias: string;
  messages: Array<{ role: string; content: string }>;
  timeoutMs: number;
}) => Promise<
  | { ok: true; text: string; model: string | null; provider: string | null }
  | { ok: false; error: string }
>;

export type RunnerDeps = {
  store: JobsStore;
  dispatch: TaskDispatch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function aliasForTag(tag: TaskType, budget: string): string {
  return tag === "image_gen" ? "chat" : budget === "any" ? tag : `${tag}:${budget}`;
}

const LEASE_MS = 300_000; // leases cover a wave; expiry requeue is B3.5

/**
 * Execute a job to completion (or deadline). Wave loop: compute the ready
 * set, fire it with bounded parallelism, write transitions, repeat. Never
 * throws — every failure becomes a logged transition; the job ends done,
 * failed(reason), or failed(deadline) with partial results intact.
 */
export async function runJob(jobId: string, deps: RunnerDeps): Promise<void> {
  const { store, dispatch } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = (taskId: string | null, event: string, detail: string | null = null) =>
    void Promise.resolve(store.appendLog({ jobId, taskId, event, detail }, now()));

  const job = await Promise.resolve(store.getJob(jobId));
  if (!job || job.status !== "active") return;
  const policy = job.policy;
  let wave = 0;

  for (;;) {
    const current = await Promise.resolve(store.getJob(jobId));
    if (!current || current.status !== "active") return;

    if (now() >= current.deadlineAt) {
      await Promise.resolve(store.setJobStatus(jobId, "failed", "deadline"));
      log(null, "job_deadline", "deadline exceeded; remaining tasks stay queued");
      return;
    }

    const plan = nextWave(current.tasks);
    const incomplete = current.tasks.filter((task) => task.state !== "done" && task.state !== "failed");
    if (plan.ready.length === 0) {
      if (incomplete.length === 0) {
        const failed = current.tasks.filter((task) => task.state === "failed");
        await Promise.resolve(store.setJobStatus(jobId, "done", failed.length > 0 ? `${failed.length} task(s) failed` : null));
        log(null, "job_done", failed.length > 0 ? `completed with failed tasks: ${failed.map((t) => t.id).join(", ")}` : null);
      } else {
        await Promise.resolve(store.setJobStatus(jobId, "failed", "blocked"));
        log(null, "job_blocked", plan.blocked.map((b) => `${b.id} (${b.reason})`).join("; "));
      }
      return;
    }

    wave += 1;
    const byId = new Map(current.tasks.map((task) => [task.id, task]));
    log(null, "wave_start", `wave ${wave}: ${plan.ready.join(", ")}`);

    const executing = plan.ready.slice(0, policy.max_concurrency);
    const deferred = plan.ready.length - executing.length;
    if (deferred > 0) log(null, "wave_deferred", `${deferred} task(s) deferred to the next wave (max_concurrency ${policy.max_concurrency})`);

    await Promise.all(
      executing.map(async (taskId) => {
        const task = byId.get(taskId);
        if (!task) return;
        const leased = await Promise.resolve(store.acquireLease(jobId, taskId, LEASE_MS, now()));
        if (!leased) return;
        log(taskId, "task_start", `attempt ${task.attempts + 1}`);

        const messages = buildTaskMessages(task, byId);
        const alias = aliasForTag(task.tag, policy.budget);
        const started = now();
        let outcome: Awaited<ReturnType<TaskDispatch>>;
        try {
          outcome = await dispatch({ tag: task.tag, alias, messages, timeoutMs: policy.task_timeout_ms });
        } catch (error) {
          outcome = { ok: false, error: error instanceof Error ? error.message : "dispatch threw" };
        }
        const latency = now() - started;

        if (outcome.ok) {
          await Promise.resolve(
            store.writeTaskTransition(jobId, taskId, {
              state: "done",
              wave,
              assignedModel: outcome.model,
              assignedProvider: outcome.provider,
              result: outcome.text,
              latencyMs: latency,
              lastError: null,
            })
          );
          log(taskId, "task_done", `${latency}ms via ${outcome.model ?? alias}`);
        } else {
          const attempts = task.attempts + 1;
          if (attempts >= policy.max_attempts) {
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

    // Let a concurrent wave loop (or test) observe the transition.
    await sleep(0);
  }
}

/** Serialize a job for the jobs API (Guide 1 Part 6 shape). */
export function jobToApi(job: OrchestrateJob): Record<string, unknown> {
  const waves = new Map<number, string[]>();
  for (const task of job.tasks) {
    if (task.wave !== null) {
      waves.set(task.wave, [...(waves.get(task.wave) ?? []), task.id]);
    }
  }
  return {
    job_id: job.jobId,
    status: job.status,
    goal: job.goal,
    mode: job.mode,
    failure_reason: job.failureReason,
    waves: [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([n, tasks]) => ({ n, tasks })),
    tasks: job.tasks.map((task) => ({
      id: task.id,
      tag: task.tag,
      state: task.state,
      depends_on: task.dependsOn,
      model: task.assignedModel,
      provider: task.assignedProvider,
      wave: task.wave,
      attempts: task.attempts,
      latency_ms: task.latencyMs,
      verdict: task.verdict,
      error: task.lastError,
      result: task.result,
    })),
    log: job.log.slice(-100),
  };
}
