/**
 * OpenDev Worktree & Supervisor Bridge for OmniRoute Orchestrator.
 *
 * Bridges OmniRoute's swarm orchestrator with OpenDev's local execution layer:
 * 1. Isolated Git Worktrees (~/.cache/openresearch/worktrees/<projectId>/<taskId>/)
 * 2. Detached OS File-Locked Supervisors for build/test runs (`fd-lock`)
 * 3. Locked Blackboard Schema sync to disk
 * 4. Git diff and test result extraction for OmniRoute's Judge Loop
 */

export interface OpenDevConfig {
  baseUrl: string; // e.g. "http://127.0.0.1:4791"
  token?: string;
}

export interface WorktreeSession {
  sessionId: string;
  projectId: string;
  taskId: string;
  branchName: string;
  worktreePath: string;
}

export interface WorktreeExecutionResult {
  ok: boolean;
  branch: string;
  commitHash?: string;
  diffSummary?: string;
  testPassed?: boolean;
  testOutput?: string;
  error?: string;
}

const DEFAULT_OPENDEV_URL = process.env.OPENDEV_API_URL || "http://127.0.0.1:4791";

/**
 * Ensures an isolated Git worktree exists for an orchestrated task.
 */
export async function ensureTaskWorktree(
  projectId: string,
  taskId: string,
  branchName?: string,
  config: OpenDevConfig = { baseUrl: DEFAULT_OPENDEV_URL }
): Promise<WorktreeSession | null> {
  try {
    const res = await fetch(`${config.baseUrl}/api/chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        title: `Task: ${taskId}`,
        branchName: branchName || `opendev/task-${taskId}`,
      }),
    });

    if (!res.ok) {
      console.warn(`[OpenDevBridge] Failed to create session: ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as { id: string; worktreePath?: string };
    return {
      sessionId: data.id,
      projectId,
      taskId,
      branchName: branchName || `opendev/task-${taskId}`,
      worktreePath: data.worktreePath || "",
    };
  } catch (error) {
    console.warn(`[OpenDevBridge] Daemon connection error:`, error);
    return null;
  }
}

/**
 * Writes locked blackboard schemas (e.g. types/contracts.ts or schema.json)
 * directly into the task's worktree filesystem before agent starts coding.
 */
export async function syncBlackboardToWorktree(
  session: WorktreeSession,
  blackboard: Record<string, unknown> | null,
  config: OpenDevConfig = { baseUrl: DEFAULT_OPENDEV_URL }
): Promise<boolean> {
  if (!blackboard) return true;

  try {
    const filesToWrite: Array<{ path: string; content: string }> = [];

    // If there is an API spec or types in blackboard, materialize them
    if (blackboard.api_spec) {
      filesToWrite.push({
        path: ".opendev/api_spec.json",
        content: typeof blackboard.api_spec === "string" 
          ? blackboard.api_spec 
          : JSON.stringify(blackboard.api_spec, null, 2),
      });
    }

    if (blackboard.schema) {
      filesToWrite.push({
        path: ".opendev/schema.prisma",
        content: String(blackboard.schema),
      });
    }

    if (blackboard.canon) {
      filesToWrite.push({
        path: ".opendev/BRIEF.md",
        content: String(blackboard.canon),
      });
    }

    for (const file of filesToWrite) {
      await fetch(`${config.baseUrl}/api/projects/${session.projectId}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          path: file.path,
          content: file.content,
        }),
      });
    }

    return true;
  } catch (error) {
    console.warn(`[OpenDevBridge] Failed to sync blackboard to worktree:`, error);
    return false;
  }
}

/**
 * Fetches the live Git diff for the session's worktree against the baseline merge-base.
 */
export async function getSessionWorktreeDiff(
  session: WorktreeSession,
  config: OpenDevConfig = { baseUrl: DEFAULT_OPENDEV_URL }
): Promise<{ diff: string; filesChanged: string[] } | null> {
  try {
    const res = await fetch(`${config.baseUrl}/api/chat/sessions/${session.sessionId}/worktree`);
    if (!res.ok) return null;

    const data = (await res.json()) as { diff?: string; files?: string[] };
    return {
      diff: data.diff || "",
      filesChanged: data.files || [],
    };
  } catch (error) {
    console.warn(`[OpenDevBridge] Error fetching worktree diff:`, error);
    return null;
  }
}

/**
 * Triggers a detached verification run (test suite, linter, or compiler)
 * in the session's isolated worktree.
 */
export async function triggerWorktreeVerification(
  session: WorktreeSession,
  command?: string,
  config: OpenDevConfig = { baseUrl: DEFAULT_OPENDEV_URL }
): Promise<{ runId: string } | null> {
  try {
    const res = await fetch(`${config.baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: session.projectId,
        chatSessionId: session.sessionId,
        backend: "local",
        command: command || undefined,
        force: true,
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { id: string };
    return { runId: data.id };
  } catch (error) {
    console.warn(`[OpenDevBridge] Failed to trigger verification run:`, error);
    return null;
  }
}

/**
 * Polls verification run status until terminal (supervised by OpenDev's detached runner).
 */
export async function waitForVerification(
  runId: string,
  timeoutMs: number = 60_000,
  config: OpenDevConfig = { baseUrl: DEFAULT_OPENDEV_URL }
): Promise<{ status: "succeeded" | "failed" | "cancelled" | "timeout"; exitCode?: number; log: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${config.baseUrl}/api/runs/${runId}`);
      if (res.ok) {
        const run = (await res.json()) as { status: string; exitCode?: number };
        if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
          // Fetch final log
          const logRes = await fetch(`${config.baseUrl}/api/runs/${runId}/log`);
          const log = logRes.ok ? await logRes.text() : "";
          return {
            status: run.status as "succeeded" | "failed" | "cancelled",
            exitCode: run.exitCode,
            log,
          };
        }
      }
    } catch {
      // transient network error, retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  return { status: "timeout", log: "Verification timed out" };
}
