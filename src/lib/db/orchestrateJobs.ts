/**
 * SQLite-backed JobsStore for the orchestrator (harness B3, Guide 1 Part 3).
 *
 * Tables orchestrate_jobs / orchestrate_tasks / orchestrate_job_log follow
 * the repo's per-module idempotent-bootstrap discipline
 * (CREATE TABLE IF NOT EXISTS on first use — see compressionRunTelemetry).
 * The name prefix avoids the existing `jobs` table (jobRegistryDb,
 * migration 136). Column naming follows house style: snake_case in SQLite,
 * camelCase in the returned objects.
 *
 * All mutations are logged to orchestrate_job_log — the audit trail and
 * debugging lifeline (guide Part 3 invariant).
 */

import { getDbInstance } from "./core";
import type {
  JobStatus,
  JudgeDriftResult,
  OrchestrateJob,
  OrchestrateLogEntry,
  OrchestrateTask,
  TaskState,
} from "@omniroute/open-sse/services/harness/orchestrator.ts";
import {
  JUDGE_DRIFT_PENALTY,
  QUALITY_FLOOR,
  type ModelStat,
} from "@omniroute/open-sse/services/harness/allocator.ts";
import { MODALITY_BY_TAG, type TaskModality, type TaskType } from "@omniroute/open-sse/services/harness/orchestrator.ts";

let ensured = false;

export function ensureOrchestrateTables(): void {
  if (ensured) return;
  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestrate_jobs (
      job_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      mode TEXT NOT NULL,
      policy TEXT NOT NULL,
      blackboard TEXT,
      status TEXT NOT NULL,
      failure_reason TEXT,
      idempotency_key TEXT,
      created_at REAL NOT NULL,
      deadline_at REAL NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS orchestrate_jobs_idem
      ON orchestrate_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS orchestrate_tasks (
      job_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      prompt TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      wave INTEGER,
      assigned_model TEXT,
      assigned_provider TEXT,
      result TEXT,
      verdict TEXT,
      latency_ms REAL,
      last_error TEXT,
      PRIMARY KEY (job_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS orchestrate_job_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp REAL NOT NULL,
      job_id TEXT NOT NULL,
      task_id TEXT,
      event TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS orchestrate_job_log_job
      ON orchestrate_job_log(job_id, id);
  `);
  // judge_rounds landed with B3.5; existing installs self-heal via ALTER.
  try {
    db.exec(`ALTER TABLE orchestrate_jobs ADD COLUMN judge_rounds INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already present.
  }
  // B5: lease timestamps on tasks (work-stealing) + the judge drift table.
  try {
    db.exec(`ALTER TABLE orchestrate_tasks ADD COLUMN lease_until INTEGER`);
  } catch {
    // Column already present.
  }
  // B6: per-task token usage from the serving responses.
  for (const column of ["prompt_tokens INTEGER", "completion_tokens INTEGER"]) {
    try {
      db.exec(`ALTER TABLE orchestrate_tasks ADD COLUMN ${column}`);
    } catch {
      // Column already present.
    }
  }
  // B7: multimodal dispatch — the endpoint family executing the task.
  // Nullable on purpose: rows persisted pre-B7 stay NULL and resolve to the
  // tag's implied modality at read time (taskFromRow), which is the exact
  // pre-B7 behavior (image_gen was the only media dispatch).
  try {
    db.exec(`ALTER TABLE orchestrate_tasks ADD COLUMN modality TEXT`);
  } catch {
    // Column already present.
  }
  // B10: bias guard (caller's own model to avoid) + spawn lineage.
  for (const column of ["caller_model TEXT", "parent_job_id TEXT"]) {
    try {
      db.exec(`ALTER TABLE orchestrate_jobs ADD COLUMN ${column}`);
    } catch {
      // Column already present.
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestrate_model_drift (
      model TEXT PRIMARY KEY,
      penalty REAL NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensured = true;
}

function mapTask(row: any): OrchestrateTask {
  return {
    jobId: row.job_id,
    id: row.task_id,
    tag: row.tag,
    prompt: row.prompt,
    modality: row.modality ?? (MODALITY_BY_TAG[row.tag as TaskType] ?? "text"),
    dependsOn: JSON.parse(row.depends_on ?? "[]") as string[],
    state: row.state as TaskState,
    attempts: row.attempts,
    wave: row.wave ?? null,
    assignedModel: row.assigned_model ?? null,
    assignedProvider: row.assigned_provider ?? null,
    result: row.result ?? null,
    verdict: row.verdict ?? null,
    latencyMs: row.latency_ms ?? null,
    lastError: row.last_error ?? null,
    leaseUntil: row.lease_until ?? null,
    promptTokens: row.prompt_tokens ?? null,
    completionTokens: row.completion_tokens ?? null,
  };
}

function jobFromRow(row: any, tasks: OrchestrateTask[], log: OrchestrateLogEntry[]): OrchestrateJob {
  return {
    jobId: row.job_id,
    goal: row.goal,
    mode: row.mode,
    policy: JSON.parse(row.policy),
    blackboard: row.blackboard ? JSON.parse(row.blackboard) : null,
    status: row.status as JobStatus,
    failureReason: row.failure_reason ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    callerModel: row.caller_model ?? null,
    parentJobId: row.parent_job_id ?? null,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    judgeRounds: typeof row.judge_rounds === "number" ? row.judge_rounds : 0,
    tasks,
    log,
  };
}

export class SqliteJobsStore {
  createJob(
    job: OrchestrateJob,
    idempotencyKey: string | null
  ): OrchestrateJob | "conflict" {
    ensureOrchestrateTables();
    if (idempotencyKey) {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) return "conflict";
    }
    const db = getDbInstance();
    const insertJob = db.prepare(
      `INSERT INTO orchestrate_jobs (
         job_id, goal, mode, policy, blackboard, status, failure_reason,
         idempotency_key, caller_model, parent_job_id, created_at, deadline_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    );
    insertJob.run(
      job.jobId,
      job.goal,
      job.mode,
      JSON.stringify(job.policy),
      job.blackboard ? JSON.stringify(job.blackboard) : null,
      job.status,
      idempotencyKey,
      job.callerModel ?? null,
      job.parentJobId ?? null,
      job.createdAt,
      job.deadlineAt
    );
    const insertTask = db.prepare(
      `INSERT INTO orchestrate_tasks (
         job_id, task_id, tag, modality, prompt, depends_on, state, attempts
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0)`
    );
    for (const task of job.tasks) {
      insertTask.run(
        job.jobId,
        task.id,
        task.tag,
        task.modality ?? MODALITY_BY_TAG[task.tag],
        task.prompt,
        JSON.stringify(task.dependsOn)
      );
    }
    // B10: pre-creation log lines (tag_inferred) persist with the job.
    const insertLog = db.prepare(
      `INSERT INTO orchestrate_job_log (timestamp, job_id, task_id, event, detail)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const entry of job.log) {
      insertLog.run(entry.timestamp, entry.jobId || job.jobId, entry.taskId, entry.event, entry.detail);
    }
    insertLog.run(job.createdAt, job.jobId, null, "job_created", `${job.tasks.length} tasks, mode ${job.mode}`);
    return this.getJob(job.jobId) as OrchestrateJob;
  }

  getJob(jobId: string): OrchestrateJob | null {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const row = db.prepare(`SELECT * FROM orchestrate_jobs WHERE job_id = ?`).get(jobId);
    if (!row) return null;
    const tasks = (
      db.prepare(`SELECT * FROM orchestrate_tasks WHERE job_id = ? ORDER BY task_id`).all(jobId) as any[]
    ).map(mapTask);
    const log = (
      db.prepare(`SELECT * FROM orchestrate_job_log WHERE job_id = ? ORDER BY id`).all(jobId) as any[]
    ).map(
      (entry): OrchestrateLogEntry => ({
        timestamp: entry.timestamp,
        jobId: entry.job_id,
        taskId: entry.task_id ?? null,
        event: entry.event,
        detail: entry.detail ?? null,
      })
    );
    return jobFromRow(row, tasks, log);
  }

  findByIdempotencyKey(key: string): OrchestrateJob | null {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const row = db
      .prepare(`SELECT job_id FROM orchestrate_jobs WHERE idempotency_key = ?`)
      .get(key) as { job_id: string } | undefined;
    return row ? this.getJob(row.job_id) : null;
  }

  acquireLease(jobId: string, taskId: string, leaseMs: number, now: number): boolean {
    // queued→running CAS with a real lease timestamp; an expired running
    // lease can be stolen (guide Part 3 work-stealing, B5).
    ensureOrchestrateTables();
    const db = getDbInstance();
    const cas = db
      .prepare(
        `UPDATE orchestrate_tasks SET state = 'running', lease_until = ?
         WHERE job_id = ? AND task_id = ? AND state = 'queued'`
      )
      .run(now + leaseMs, jobId, taskId);
    if (cas.changes > 0) return true;
    const steal = db
      .prepare(
        `UPDATE orchestrate_tasks SET lease_until = ?
         WHERE job_id = ? AND task_id = ? AND state = 'running'
           AND lease_until IS NOT NULL AND lease_until < ?`
      )
      .run(now + leaseMs, jobId, taskId, now);
    return steal.changes > 0;
  }

  requeueExpiredLeases(jobId: string, now: number): string[] {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const rows = db
      .prepare(
        `SELECT task_id FROM orchestrate_tasks
         WHERE job_id = ? AND state = 'running' AND lease_until IS NOT NULL AND lease_until < ?`
      )
      .all(jobId, now) as Array<{ task_id: string }>;
    if (rows.length === 0) return [];
    const update = db.prepare(
      `UPDATE orchestrate_tasks SET state = 'queued', lease_until = NULL, last_error = 'lease expired (worker lost)'
       WHERE job_id = ? AND task_id = ?`
    );
    return rows.map((row) => {
      update.run(jobId, row.task_id);
      return row.task_id;
    });
  }

  aggregateModelStats(): Record<string, ModelStat> {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const rows = db
      .prepare(
        `SELECT assigned_model AS model,
                SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failures,
                SUM(CASE WHEN state = 'done' THEN COALESCE(latency_ms, 0) ELSE 0 END) AS totalLatencyMs
         FROM orchestrate_tasks
         WHERE assigned_model IS NOT NULL AND assigned_model != ''
         GROUP BY assigned_model`
      )
      .all() as Array<{ model: string; successes: number; failures: number; totalLatencyMs: number }>;
    const stats: Record<string, ModelStat> = {};
    for (const row of rows) {
      stats[row.model] = {
        successes: Number(row.successes) || 0,
        failures: Number(row.failures) || 0,
        totalLatencyMs: Number(row.totalLatencyMs) || 0,
      };
    }
    return stats;
  }

  getModelPenalties(): Record<string, number> {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const rows = db
      .prepare(`SELECT model, penalty FROM orchestrate_model_drift WHERE penalty > 0`)
      .all() as Array<{ model: string; penalty: number }>;
    const penalties: Record<string, number> = {};
    for (const row of rows) penalties[row.model] = Number(row.penalty) || 0;
    return penalties;
  }

  applyJudgeVerdict(model: string, passed: boolean): JudgeDriftResult {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const row = db
      .prepare(`SELECT penalty, fail_streak FROM orchestrate_model_drift WHERE model = ?`)
      .get(model) as { penalty: number; fail_streak: number } | undefined;
    let penalty = Number(row?.penalty) || 0;
    let failStreak = Number(row?.fail_streak) || 0;
    let penalized = false;
    if (passed) {
      failStreak = 0;
    } else {
      failStreak += 1;
      // Part 8 drift loop: two consecutive failed verdicts → quality −0.05
      // per further fail, floored so quality never drops below 0.3.
      if (failStreak >= 2) {
        // 3-decimal rounding keeps repeated 0.05 steps free of float drift.
        penalty = Math.round(Math.min(penalty + JUDGE_DRIFT_PENALTY, 1 - QUALITY_FLOOR) * 1000) / 1000;
        penalized = true;
      }
    }
    db.prepare(
      `INSERT INTO orchestrate_model_drift (model, penalty, fail_streak) VALUES (?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET penalty = excluded.penalty, fail_streak = excluded.fail_streak`
    ).run(model, penalty, failStreak);
    return { penalty, penalized };
  }

  writeTaskTransition(jobId: string, taskId: string, patch: Partial<OrchestrateTask>): OrchestrateTask | null {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const fields: string[] = [];
    const values: unknown[] = [];
    const columns: Array<[keyof OrchestrateTask, string]> = [
      ["state", "state"],
      ["prompt", "prompt"],
      ["attempts", "attempts"],
      ["wave", "wave"],
      ["assignedModel", "assigned_model"],
      ["assignedProvider", "assigned_provider"],
      ["result", "result"],
      ["verdict", "verdict"],
      ["latencyMs", "latency_ms"],
      ["lastError", "last_error"],
      ["leaseUntil", "lease_until"],
      ["promptTokens", "prompt_tokens"],
      ["completionTokens", "completion_tokens"],
    ];
    for (const [field, column] of columns) {
      if (field in patch) {
        fields.push(`${column} = ?`);
        values.push((patch as Record<string, unknown>)[field] ?? null);
      }
    }
    // Leaving "running" always releases the lease (B5).
    if (patch.state !== undefined && patch.state !== "running") {
      fields.push(`lease_until = NULL`);
    }
    if (fields.length > 0) {
      db.prepare(
        `UPDATE orchestrate_tasks SET ${fields.join(", ")} WHERE job_id = ? AND task_id = ?`
      ).run(...values, jobId, taskId);
    }
    const row = db
      .prepare(`SELECT * FROM orchestrate_tasks WHERE job_id = ? AND task_id = ?`)
      .get(jobId, taskId);
    return row ? mapTask(row) : null;
  }

  setJobStatus(jobId: string, status: JobStatus, failureReason: string | null): void {
    ensureOrchestrateTables();
    const db = getDbInstance();
    db.prepare(`UPDATE orchestrate_jobs SET status = ?, failure_reason = ? WHERE job_id = ?`).run(
      status,
      failureReason,
      jobId
    );
  }

  updateBlackboard(jobId: string, blackboard: Record<string, unknown> | null): void {
    ensureOrchestrateTables();
    const db = getDbInstance();
    db.prepare(`UPDATE orchestrate_jobs SET blackboard = ? WHERE job_id = ?`).run(
      blackboard ? JSON.stringify(blackboard) : null,
      jobId
    );
  }

  setJudgeRounds(jobId: string, rounds: number): void {
    ensureOrchestrateTables();
    const db = getDbInstance();
    db.prepare(`UPDATE orchestrate_jobs SET judge_rounds = ? WHERE job_id = ?`).run(rounds, jobId);
  }

  appendLog(entry: Omit<OrchestrateLogEntry, "timestamp">, timestamp: number): void {
    ensureOrchestrateTables();
    const db = getDbInstance();
    db.prepare(
      `INSERT INTO orchestrate_job_log (timestamp, job_id, task_id, event, detail)
       VALUES (?, ?, ?, ?, ?)`
    ).run(timestamp, entry.jobId, entry.taskId, entry.event, entry.detail);
  }

  /** B10 refill: append queued tasks to an ACTIVE (or judging) job. */
  appendTasks(jobId: string, tasks: OrchestrateTask[]): OrchestrateJob | "job_terminal" | "duplicate_id" | null {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const row = db.prepare(`SELECT status FROM orchestrate_jobs WHERE job_id = ?`).get(jobId) as
      | { status: string }
      | undefined;
    if (!row) return null;
    if (row.status !== "active" && row.status !== "judging") return "job_terminal";
    const existing = new Set(
      (db.prepare(`SELECT task_id FROM orchestrate_tasks WHERE job_id = ?`).all(jobId) as Array<{ task_id: string }>).map(
        (task) => task.task_id
      )
    );
    for (const task of tasks) {
      if (existing.has(task.id)) return "duplicate_id";
    }
    const insertTask = db.prepare(
      `INSERT INTO orchestrate_tasks (
         job_id, task_id, tag, modality, prompt, depends_on, state, attempts
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0)`
    );
    for (const task of tasks) {
      insertTask.run(
        jobId,
        task.id,
        task.tag,
        task.modality ?? MODALITY_BY_TAG[task.tag],
        task.prompt,
        JSON.stringify(task.dependsOn)
      );
    }
    return this.getJob(jobId) as OrchestrateJob;
  }

  /** B10 spawn: the parent's child jobs, oldest first (all states). */
  listChildJobs(parentJobId: string): OrchestrateJob[] {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const rows = db
      .prepare(`SELECT job_id FROM orchestrate_jobs WHERE parent_job_id = ? ORDER BY created_at ASC`)
      .all(parentJobId) as Array<{ job_id: string }>;
    const children: OrchestrateJob[] = [];
    for (const row of rows) {
      const job = this.getJob(row.job_id);
      if (job) children.push(job);
    }
    return children;
  }
}
