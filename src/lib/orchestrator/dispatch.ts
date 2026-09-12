/**
 * Wiring for the orchestrator runner: tag→alias dispatch through the native
 * chat pipeline (self-fetch, same as /quick — admission, failover, breakers,
 * translation all apply), plus job creation from a validated plan.
 */

import { createHash, randomUUID } from "node:crypto";
import { selfFetchChat, selfFetchImages, selfFetchMusic, selfFetchSearch, selfFetchSpeech, selfFetchVideos } from "@/lib/harness/selfFetch";
import {
  findModelsByTags,
  getModelTagIndex,
} from "@omniroute/open-sse/services/modelTags/index.ts";
import {
  MODALITY_BY_TAG,
  ORCHESTRATE_DEFAULTS,
  normalizeAppendTasks,
  taskRowsFromSpecs,
  inferTaskTag,
  type OrchestrateJob,
  type OrchestratePlanBody,
  type PlanValidation,
  type TaskDispatch,
  type TaskModality,
  type TaskType,
  validatePlan,
} from "@omniroute/open-sse/services/harness/orchestrator.ts";

export { validatePlan, normalizeAppendTasks, taskRowsFromSpecs };
export type { PlanValidation, OrchestratePlanBody };

export function newJobId(): string {
  return `job_${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
}

export function jobFromPlan(
  validation: Extract<PlanValidation, { ok: true }>,
  idempotencyKey: string | null,
  parentJobId: string | null = null
): OrchestrateJob {
  const now = Date.now();
  // B10: inferred tags are logged at creation — the routing decision is
  // auditable from the job log, never silent.
  const inferredLogs = validation.inferredTags.map((inferred) => ({
    timestamp: now,
    jobId: "",
    taskId: inferred.id,
    event: "tag_inferred",
    detail: `"${inferred.tag}" — ${inferred.reason}`,
  }));
  return {
    jobId: newJobId(),
    goal: validation.goal,
    mode: validation.mode,
    policy: validation.policy,
    blackboard: validation.blackboard,
    status: "active",
    failureReason: null,
    idempotencyKey,
    callerModel: validation.callerModel,
    parentJobId,
    judgeRounds: 0,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "",
      id: task.id,
      tag: task.tag,
      modality: task.modality,
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
      promptTokens: null,
      completionTokens: null,
      finishedAt: null,
    })),
    log: inferredLogs,
  };
}

/** B6: normalize an OpenAI-style usage object; null when unreported. */
function parseUsage(
  usage: Record<string, unknown> | undefined | null
): { prompt_tokens: number; completion_tokens: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
  };
}

// ── B7 multimodal dispatch ─────────────────────────────────────────────────
// Media task dispatches route to their endpoint family; results land on the
// task row as JSON envelopes ({images|search|speech|music|video: {...}}) so
// downstream injection, the blackboard, and the judge all see structured,
// self-describing output instead of raw endpoint bodies.

/** Registry subcategory that ranks models for each media modality. */
const MEDIA_CATEGORY: Record<"image" | "speech" | "music" | "video", string> = {
  image: "image-gen",
  speech: "text-to-speech",
  music: "music-gen",
  video: "video-gen",
};

/**
 * Pick the model for a media dispatch: the allocator's assignment (B5
 * assigned routing) when it is still among the ranked specialists, else the
 * index's best. Returns null when the registry has no models of that family.
 */
export function pickMediaModel(
  modality: "image" | "speech" | "music" | "video",
  assignedModel?: string | null
): { id: string; provider: string | null } | null {
  const index = getModelTagIndex();
  const candidates = findModelsByTags(index, {
    category: MEDIA_CATEGORY[modality] as never,
    distinctModels: true,
    diverseProviders: true,
    limit: 4,
  });
  const chosen =
    (assignedModel ? candidates.find((entry) => entry.id === assignedModel) : undefined) ??
    candidates[0];
  return chosen ? { id: chosen.id, provider: chosen.provider ?? null } : null;
}

/** Cap for binary/base64 payloads embedded in a task result envelope. */
export const MEDIA_ENVELOPE_B64_CAP_BYTES = 192 * 1024; // raw bytes (→ 256 KB base64)
/** Cap for JSON payloads embedded in a task result envelope. */
export const MEDIA_ENVELOPE_JSON_CAP_BYTES = 2 * 1024 * 1024;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Speech envelope: audio bytes are embedded base64 when small enough for the
 * job record (short TTS clips); larger audio keeps metadata + digest only —
 * the input is on the task row, so regeneration is deterministic.
 */
export function buildSpeechEnvelope(
  bytes: Uint8Array,
  contentType: string | null,
  model: string,
  capBytes: number = MEDIA_ENVELOPE_B64_CAP_BYTES
): string {
  const envelope: Record<string, unknown> = {
    speech: {
      model,
      content_type: contentType ?? "application/octet-stream",
      bytes: bytes.byteLength,
      sha256: sha256Hex(Buffer.from(bytes).toString("base64")),
    },
  };
  if (bytes.byteLength <= capBytes) {
    (envelope.speech as Record<string, unknown>).data_b64 = Buffer.from(bytes).toString("base64");
  } else {
    (envelope.speech as Record<string, unknown>).truncated = true;
  }
  return JSON.stringify(envelope);
}

/**
 * Search envelope: the /v1/search response's result list (title/url/snippet
 * items) with the effective query — self-describing for downstream injection.
 */
export function buildSearchEnvelope(query: string, json: { results?: unknown }): string {
  return JSON.stringify({
    search: {
      query,
      results: Array.isArray(json.results) ? json.results : [],
    },
  });
}

/**
 * Media (music/video) envelope: embeds the endpoint's JSON payload when it
 * fits the job record; oversized payloads (long b64 bodies) keep metadata +
 * digest with truncated: true.
 */
export function buildMediaEnvelope(
  kind: "music" | "video",
  model: string,
  responseText: string,
  capBytes: number = MEDIA_ENVELOPE_JSON_CAP_BYTES
): string {
  if (responseText.length <= capBytes) {
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = { raw: responseText };
    }
    return JSON.stringify({ [kind]: { model, data: payload } });
  }
  return JSON.stringify({
    [kind]: { model, truncated: true, bytes: responseText.length, sha256: sha256Hex(responseText) },
  });
}

export function chatDispatchFor(request: Request, jobId?: string | null): TaskDispatch {
  return async ({ taskId, tag, modality, alias, assignedModel, messages, prompt, timeoutMs, wave }) => {
    // B4 trace headers — X-OmniRoute-Job/Task/Wave ride the self-fetch so
    // every orchestrator-originated upstream call is attributable in logs.
    const traceHeaders: Record<string, string> = { "X-OmniRoute-Task": taskId };
    if (jobId) traceHeaders["X-OmniRoute-Job"] = jobId;
    if (wave !== undefined) traceHeaders["X-OmniRoute-Wave"] = String(wave);
    // B7: pre-B7 jobs/rows carry no modality — the tag's implied modality is
    // the exact historical behavior (image_gen was the only media dispatch).
    // "worktree" is an execution-location, not an endpoint family: the
    // orchestrator provisions the worktree before dispatch; the dispatch
    // itself is an ordinary chat call against it.
    const requestedModality: TaskModality = modality ?? MODALITY_BY_TAG[tag];
    const effectiveModality: Exclude<TaskModality, "worktree"> = requestedModality === "worktree" ? "text" : requestedModality;
    try {
      // B7: literal web-search tasks hit /v1/search directly (no model —
      // the route picks the provider/credentials; query capped at 500 chars
      // by the schema, so clamp here to keep the error informative).
      if (effectiveModality === "search") {
        const query = prompt.trim().slice(0, 500);
        if (!query) return { ok: false, error: "empty search query" };
        const response = await selfFetchSearch({
          incoming: request,
          body: { query, max_results: 8 },
          timeoutMs: Math.min(timeoutMs || ORCHESTRATE_DEFAULTS.taskTimeoutMs, 600_000),
          extraHeaders: traceHeaders,
        });
        if (response.status !== 200) return { ok: false, error: `search upstream status ${response.status}` };
        const json = (await response.json()) as { results?: unknown };
        return {
          ok: true,
          text: buildSearchEnvelope(query, json),
          model: null,
          provider: response.headers.get("x-omniroute-provider"),
        };
      }

      // Media modalities dispatch their generation endpoint with the tag
      // index's best specialist of that family (B3.5 per-task media
      // dispatch, generalized in B7 from the image_gen special case).
      if (effectiveModality !== "text") {
        const chosen = pickMediaModel(effectiveModality, assignedModel);
        if (!chosen) return { ok: false, error: `no ${effectiveModality} models available` };
        const body: Record<string, unknown> =
          effectiveModality === "image"
            ? { model: chosen.id, prompt, n: 1 }
            : effectiveModality === "speech"
              ? { model: chosen.id, input: prompt }
              : { model: chosen.id, prompt };
        const fetcher =
          effectiveModality === "image"
            ? selfFetchImages
            : effectiveModality === "speech"
              ? selfFetchSpeech
              : effectiveModality === "music"
                ? selfFetchMusic
                : selfFetchVideos;
        const response = await fetcher({
          incoming: request,
          body,
          timeoutMs: Math.min(timeoutMs || ORCHESTRATE_DEFAULTS.taskTimeoutMs, 600_000),
          extraHeaders: traceHeaders,
        });
        if (response.status !== 200) {
          return { ok: false, error: `${effectiveModality} upstream status ${response.status}` };
        }
        if (effectiveModality === "speech") {
          // TTS returns audio bytes, not JSON.
          const bytes = new Uint8Array(await response.arrayBuffer());
          return {
            ok: true,
            text: buildSpeechEnvelope(bytes, response.headers.get("content-type"), chosen.id),
            model: chosen.id,
            provider: chosen.provider,
          };
        }
        if (effectiveModality === "image") {
          const json = (await response.json()) as { data?: unknown[]; usage?: Record<string, unknown> };
          return {
            ok: true,
            text: JSON.stringify({ images: Array.isArray(json.data) ? json.data : [] }),
            model: chosen.id,
            provider: chosen.provider,
            usage: parseUsage(json.usage),
          };
        }
        const text = await response.text();
        return {
          ok: true,
          text: buildMediaEnvelope(effectiveModality, chosen.id, text),
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
