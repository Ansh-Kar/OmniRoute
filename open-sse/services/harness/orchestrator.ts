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
import {
  appendMailboxAnswer,
  assembleSwarmPrompt,
  buildAskPrompt,
  buildJudgeMessages,
  MAILBOX_TIMEOUT_MS,
  mergeIntoBlackboard,
  parseAskDirectives,
  parseJudgeVerdicts,
  parseSummary,
  withJudgeFeedback,
} from "./swarmMode.ts";

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
  judge?: boolean; // swarm mode: run the judge loop (default true)
  max_rounds?: number; // swarm mode: judge refinement cap (1-5, default 3)
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
  | { ok: true; tasks: Array<OrchestrateTaskSpec & { tag: TaskType }>; mode: "parallel" | "swarm"; policy: Required<OrchestratePolicy>; goal: string; blackboard: Record<string, unknown> | null }
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
    judge: rawPolicy.judge !== false,
    max_rounds: clampInt(rawPolicy.max_rounds, 1, 5, ORCHESTRATE_DEFAULTS.maxRounds),
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
  /** Swarm: replace the blackboard snapshot (harness-only writes). */
  updateBlackboard(jobId: string, blackboard: Record<string, unknown> | null): Promise<void> | void;
  /** Swarm: persist the judge-round counter. */
  setJudgeRounds(jobId: string, rounds: number): Promise<void> | void;
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
  alias: string;
  /** Chat-shaped messages (upstream-injected; swarm-wrapped for chat tags). */
  messages: Array<{ role: string; content: string }>;
  /** The effective prompt (what an images dispatch should send). */
  prompt: string;
  timeoutMs: number;
  /** 1-based wave number (B4 trace headers; absent for judge/mailbox). */
  wave?: number;
}) => Promise<
  | { ok: true; text: string; model: string | null; provider: string | null }
  | { ok: false; error: string }
>;

export type RunnerDeps = {
  store: JobsStore;
  dispatch: TaskDispatch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Swarm: override the judge pass's check instruction (manual advance). */
  judgeCheck?: string;
};

export function aliasForTag(tag: TaskType, budget: string): string {
  if (tag === "image_gen") return "image_gen"; // resolved by the images adapter
  return budget === "any" ? tag : `${tag}:${budget}`;
}

const LEASE_MS = 300_000; // leases cover a wave; expiry requeue is B5+

type LogFn = (taskId: string | null, event: string, detail?: string | null) => void;

/** Wrap a chat task's prompt with the swarm shared context (image tasks skip it). */
function effectivePrompt(
  job: OrchestrateJob,
  task: OrchestrateTask,
  byId: Map<string, OrchestrateTask>
): string {
  if (job.mode !== "swarm" || task.tag === "image_gen") {
    // Parallel mode / image tasks: upstream injection only.
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
    await Promise.all(
      executing.map(async (taskId) => {
        const task = byId.get(taskId);
        if (!task) return;
        const leased = await Promise.resolve(store.acquireLease(jobId, taskId, LEASE_MS, now()));
        if (!leased) return;
        log(taskId, "task_start", `attempt ${task.attempts + 1}`);

        const prompt = effectivePrompt(current, task, byId);
        const alias = aliasForTag(task.tag, current.policy.budget);
        const started = now();
        let outcome: Awaited<ReturnType<TaskDispatch>>;
        try {
          outcome = await dispatch({
            taskId,
            tag: task.tag,
            alias,
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
          waveResults.push({ taskId, text: outcome.text });
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
  return {
    job_id: job.jobId,
    status: job.status,
    goal: job.goal,
    mode: job.mode,
    failure_reason: job.failureReason,
    judge_rounds: job.judgeRounds,
    blackboard: job.blackboard ?? null,
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
