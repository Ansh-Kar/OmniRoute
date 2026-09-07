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
  OrchestrateJob,
  OrchestrateLogEntry,
  OrchestrateTask,
  TaskState,
} from "@omniroute/open-sse/services/harness/orchestrator.ts";

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
  ensured = true;
}

function mapTask(row: any): OrchestrateTask {
  return {
    jobId: row.job_id,
    id: row.task_id,
    tag: row.tag,
    prompt: row.prompt,
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
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
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
         idempotency_key, created_at, deadline_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    );
    insertJob.run(
      job.jobId,
      job.goal,
      job.mode,
      JSON.stringify(job.policy),
      job.blackboard ? JSON.stringify(job.blackboard) : null,
      job.status,
      idempotencyKey,
      job.createdAt,
      job.deadlineAt
    );
    const insertTask = db.prepare(
      `INSERT INTO orchestrate_tasks (
         job_id, task_id, tag, prompt, depends_on, state, attempts
       ) VALUES (?, ?, ?, ?, ?, 'queued', 0)`
    );
    for (const task of job.tasks) {
      insertTask.run(job.jobId, task.id, task.tag, task.prompt, JSON.stringify(task.dependsOn));
    }
    const insertLog = db.prepare(
      `INSERT INTO orchestrate_job_log (timestamp, job_id, task_id, event, detail)
       VALUES (?, ?, NULL, 'job_created', ?)`
    );
    insertLog.run(job.createdAt, job.jobId, `${job.tasks.length} tasks, mode ${job.mode}`);
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

  acquireLease(jobId: string, taskId: string, _leaseMs: number, _now: number): boolean {
    // queued→running CAS. Expired-lease requeue (work stealing) is B3.5;
    // B3 has a single runner per job.
    void _leaseMs;
    void _now;
    ensureOrchestrateTables();
    const db = getDbInstance();
    const result = db
      .prepare(`UPDATE orchestrate_tasks SET state = 'running' WHERE job_id = ? AND task_id = ? AND state = 'queued'`)
      .run(jobId, taskId);
    return result.changes > 0;
  }

  writeTaskTransition(jobId: string, taskId: string, patch: Partial<OrchestrateTask>): OrchestrateTask | null {
    ensureOrchestrateTables();
    const db = getDbInstance();
    const fields: string[] = [];
    const values: unknown[] = [];
    const columns: Array<[keyof OrchestrateTask, string]> = [
      ["state", "state"],
      ["attempts", "attempts"],
      ["wave", "wave"],
      ["assignedModel", "assigned_model"],
      ["assignedProvider", "assigned_provider"],
      ["result", "result"],
      ["verdict", "verdict"],
      ["latencyMs", "latency_ms"],
      ["lastError", "last_error"],
    ];
    for (const [field, column] of columns) {
      if (field in patch) {
        fields.push(`${column} = ?`);
        values.push((patch as Record<string, unknown>)[field] ?? null);
      }
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

  appendLog(entry: Omit<OrchestrateLogEntry, "timestamp">, timestamp: number): void {
    ensureOrchestrateTables();
    const db = getDbInstance();
    db.prepare(
      `INSERT INTO orchestrate_job_log (timestamp, job_id, task_id, event, detail)
       VALUES (?, ?, ?, ?, ?)`
    ).run(timestamp, entry.jobId, entry.taskId, entry.event, entry.detail);
  }
}
