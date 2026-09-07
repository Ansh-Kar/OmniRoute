/**
 * Wiring for the orchestrator runner: tag→alias dispatch through the native
 * chat pipeline (self-fetch, same as /quick — admission, failover, breakers,
 * translation all apply), plus job creation from a validated plan.
 */

import { randomUUID } from "node:crypto";
import { selfFetchChat } from "@/lib/harness/selfFetch";
import {
  ORCHESTRATE_DEFAULTS,
  type OrchestrateJob,
  type OrchestratePlanBody,
  type PlanValidation,
  type TaskDispatch,
  validatePlan,
} from "@omniroute/open-sse/services/harness/orchestrator.ts";

export { validatePlan };
export type { PlanValidation, OrchestratePlanBody };

export function newJobId(): string {
  return `job_${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
}

export function jobFromPlan(
  validation: Extract<PlanValidation, { ok: true }>,
  idempotencyKey: string | null
): OrchestrateJob {
  const now = Date.now();
  return {
    jobId: newJobId(),
    goal: validation.goal,
    mode: validation.mode,
    policy: validation.policy,
    blackboard: validation.blackboard,
    status: "active",
    failureReason: null,
    idempotencyKey,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "",
      id: task.id,
      tag: task.tag,
      prompt: task.prompt,
      dependsOn: task.depends_on ?? [],
      state: "queued",
      attempts: 0,
      wave: null,
      assignedModel: null,
      assignedProvider: null,
      result: null,
      verdict: null,
      latencyMs: null,
      lastError: null,
    })),
    log: [],
  };
}

export function chatDispatchFor(request: Request): TaskDispatch {
  return async ({ alias, messages, timeoutMs }) => {
    try {
      const response = await selfFetchChat({
        incoming: request,
        body: { model: alias, stream: false, messages },
        timeoutMs: Math.min(timeoutMs || ORCHESTRATE_DEFAULTS.taskTimeoutMs, 600_000),
      });
      if (response.status !== 200) {
        return { ok: false, error: `upstream status ${response.status}` };
      }
      const json = (await response.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const rawText = json.choices?.[0]?.message?.content;
      const text = typeof rawText === "string" ? rawText : rawText == null ? "" : JSON.stringify(rawText);
      return {
        ok: true,
        text,
        model: response.headers.get("x-omniroute-model") ?? json.model ?? null,
        provider: response.headers.get("x-omniroute-provider"),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "dispatch failed" };
    }
  };
}
