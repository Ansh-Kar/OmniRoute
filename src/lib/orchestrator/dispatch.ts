/**
 * Wiring for the orchestrator runner: tag→alias dispatch through the native
 * chat pipeline (self-fetch, same as /quick — admission, failover, breakers,
 * translation all apply), plus job creation from a validated plan.
 */

import { randomUUID } from "node:crypto";
import { selfFetchChat, selfFetchImages } from "@/lib/harness/selfFetch";
import {
  findModelsByTags,
  getModelTagIndex,
} from "@omniroute/open-sse/services/modelTags/index.ts";
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
    judgeRounds: 0,
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
      leaseUntil: null,
    })),
    log: [],
  };
}

export function chatDispatchFor(request: Request, jobId?: string | null): TaskDispatch {
  return async ({ taskId, tag, alias, assignedModel, messages, prompt, timeoutMs, wave }) => {
    // B4 trace headers — X-OmniRoute-Job/Task/Wave ride the self-fetch so
    // every orchestrator-originated upstream call is attributable in logs.
    const traceHeaders: Record<string, string> = { "X-OmniRoute-Task": taskId };
    if (jobId) traceHeaders["X-OmniRoute-Job"] = jobId;
    if (wave !== undefined) traceHeaders["X-OmniRoute-Wave"] = String(wave);
    try {
      // image_gen tasks dispatch the images API with the tag index's best
      // image specialist (B3.5 per-task media dispatch).
      if (tag === "image_gen") {
        const index = getModelTagIndex();
        const candidates = findModelsByTags(index, {
          category: "image-gen",
          distinctModels: true,
          diverseProviders: true,
          limit: 4,
        });
        // B5: an allocator assignment (assigned routing) picks the model.
        const chosen =
          (assignedModel ? candidates.find((entry) => entry.id === assignedModel) : undefined) ??
          candidates[0];
        if (!chosen) return { ok: false, error: "no image models available" };
        const response = await selfFetchImages({
          incoming: request,
          body: { model: chosen.id, prompt, n: 1 },
          timeoutMs: Math.min(timeoutMs || ORCHESTRATE_DEFAULTS.taskTimeoutMs, 600_000),
          extraHeaders: traceHeaders,
        });
        if (response.status !== 200) return { ok: false, error: `images upstream status ${response.status}` };
        const json = (await response.json()) as { data?: unknown[] };
        return {
          ok: true,
          text: JSON.stringify({ images: Array.isArray(json.data) ? json.data : [] }),
          model: chosen.id,
          provider: chosen.provider,
        };
      }
      const response = await selfFetchChat({
        incoming: request,
        // B5: assigned routing dispatches the allocator-picked model;
        // alias routing (default) dispatches the capability alias and lets
        // the native combo machinery fail over.
        body: { model: assignedModel ?? alias, stream: false, messages },
        timeoutMs: Math.min(timeoutMs || ORCHESTRATE_DEFAULTS.taskTimeoutMs, 600_000),
        extraHeaders: traceHeaders,
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
