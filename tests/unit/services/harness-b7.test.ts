/**
 * Harness B7 (cross-cutting: multimodal task dispatch) — tests for:
 *
 *   1. Plan validation: modality vocabulary, tag-implied defaults, and the
 *      compatibility rules (media tags force their modality; "search" is
 *      only meaningful on chat tags).
 *   2. Runner plumbing: media/search tasks skip the swarm wrapper, the
 *      dispatch input carries the resolved modality, results land as JSON
 *      envelopes, jobToApi surfaces task.modality.
 *   3. Mailbox: media tasks cannot answer @ask (skipped with a reason).
 *   4. Envelope builders (dispatch.ts): speech b64 cap + digest fallback,
 *      search passthrough, music/video JSON cap + truncated fallback.
 *   5. SQLite round-trip: modality persists; legacy NULL rows resolve to
 *      the tag's implied modality (pre-B7 behavior).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b7-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b7-test-secret";

const { validatePlan, runJob, jobToApi, InMemoryJobsStore, MODALITY_BY_TAG, taskModalityOf } =
  await import("../../../open-sse/services/harness/orchestrator.ts");
import type { OrchestrateJob, TaskDispatch, TaskModality } from "../../../open-sse/services/harness/orchestrator.ts";

const { buildSpeechEnvelope, buildSearchEnvelope, buildMediaEnvelope, MEDIA_ENVELOPE_B64_CAP_BYTES } =
  await import("../../../src/lib/orchestrator/dispatch.ts");

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    goal: "test goal",
    mode: "parallel",
    tasks: [{ id: "t1", tag: "chat", prompt: "one", depends_on: [] }],
    ...overrides,
  };
}

function makeJob(tasks: Array<Record<string, unknown>>, mode = "parallel"): OrchestrateJob {
  const validation = validatePlan(planBody({ mode, tasks }));
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    jobId: "job_b7",
    goal: validation.goal,
    mode: validation.mode,
    policy: { ...validation.policy, ...(mode === "swarm" ? { judge: false } : {}) },
    blackboard: mode === "swarm" ? { canon: "x", _locked: ["canon"] } : null,
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    judgeRounds: 0,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "job_b7",
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
    })),
    log: [],
  } as unknown as OrchestrateJob;
}

// ── Plan validation: modality vocabulary + compatibility ───────────────────

test("modality: chat tags default to text; media tags imply theirs", () => {
  const chat = validatePlan(planBody());
  assert.ok(chat.ok);
  assert.equal(chat.tasks[0].modality, "text");

  for (const [tag, modality] of [
    ["image_gen", "image"],
    ["audio_speech", "speech"],
    ["music_gen", "music"],
    ["video_gen", "video"],
  ] as const) {
    const plan = validatePlan(planBody({ tasks: [{ id: "m1", tag, prompt: "make it", depends_on: [] }] }));
    assert.ok(plan.ok, `${tag} accepted`);
    assert.equal(plan.tasks[0].modality, modality, `${tag} implies ${modality}`);
    assert.equal(MODALITY_BY_TAG[tag], modality);
  }
});

test("modality: explicit values must be compatible with the tag", () => {
  // Restating the implied modality is fine.
  const ok = validatePlan(
    planBody({ tasks: [{ id: "m1", tag: "image_gen", prompt: "p", modality: "image", depends_on: [] }] })
  );
  assert.ok(ok.ok);
  assert.equal(ok.tasks[0].modality, "image");

  // "search" (literal /v1/search) is meaningful on chat tags.
  const search = validatePlan(
    planBody({ tasks: [{ id: "s1", tag: "research", prompt: "p", modality: "search", depends_on: [] }] })
  );
  assert.ok(search.ok);
  assert.equal(search.tasks[0].modality, "search");

  // Unknown vocabulary.
  const bad = validatePlan(planBody({ tasks: [{ id: "x1", tag: "chat", prompt: "p", modality: "hologram", depends_on: [] }] }));
  assert.ok(!bad.ok);
  assert.match(bad.errors.join("; "), /unknown modality "hologram"/);

  // Media modality on a chat tag.
  const wrongTag = validatePlan(planBody({ tasks: [{ id: "x2", tag: "code", prompt: "p", modality: "speech", depends_on: [] }] }));
  assert.ok(!wrongTag.ok);
  assert.match(wrongTag.errors.join("; "), /modality "speech" requires its media tag/);

  // "text" on a media tag (the tag implies its media modality).
  const textOnMedia = validatePlan(planBody({ tasks: [{ id: "x3", tag: "image_gen", prompt: "p", modality: "text", depends_on: [] }] }));
  assert.ok(!textOnMedia.ok);
  assert.match(textOnMedia.errors.join("; "), /incompatible with tag "image_gen"/);

  // "search" on a media tag.
  const searchOnMedia = validatePlan(planBody({ tasks: [{ id: "x4", tag: "video_gen", prompt: "p", modality: "search", depends_on: [] }] }));
  assert.ok(!searchOnMedia.ok);
  assert.match(searchOnMedia.errors.join("; "), /incompatible with tag "video_gen"/);
});

// ── Runner plumbing ────────────────────────────────────────────────────────

test("runner: media tasks skip the swarm wrapper and dispatch with their modality", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob(
    [
      { id: "t1", tag: "chat", prompt: "write the chorus", depends_on: [] },
      { id: "m1", tag: "music_gen", prompt: "lo-fi beat, 90 bpm", depends_on: [] },
    ],
    "swarm"
  );
  store.createJob(job, null);
  const seen: Array<{ modality: TaskModality; prompt: string }> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push({ modality: input.modality, prompt: input.prompt });
    if (input.taskId === "m1") {
      return {
        ok: true,
        text: JSON.stringify({ music: { model: "some/model", data: { created: 1, data: [{ url: "https://x/audio.wav" }] } } }),
        model: "some/model",
        provider: "some",
      };
    }
    return { ok: true, text: "chorus text", model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  assert.equal(seen.length, 2);
  const media = seen.find((entry) => entry.prompt.includes("lo-fi"));
  assert.ok(media, "music task dispatched");
  assert.equal(media.modality, "music");
  assert.equal(media.prompt, "lo-fi beat, 90 bpm", "no shared-context wrapper for media tasks");
  const chat = seen.find((entry) => entry.modality === "text");
  assert.ok(chat);
  assert.match(chat.prompt, /shared context|goal|blackboard/i, "chat task keeps the swarm wrapper");

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const musicTask = final.tasks.find((task) => task.id === "m1");
  assert.ok(musicTask);
  assert.equal(musicTask.modality, "music");
  assert.match(musicTask.result ?? "", /"music":/);
  // jobToApi surfaces the modality.
  const api = jobToApi(final) as { tasks: Array<{ id: string; modality: string }> };
  assert.equal(api.tasks.find((task) => task.id === "m1")?.modality, "music");
  assert.equal(api.tasks.find((task) => task.id === "t1")?.modality, "text");
});

test("runner: literal search modality on a chat tag", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob([
    { id: "s1", tag: "research", prompt: "latest GPQA benchmark results", modality: "search", depends_on: [] },
  ]);
  store.createJob(job, null);
  const seen: Array<{ modality: TaskModality; tag: string; prompt: string }> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push({ modality: input.modality, tag: input.tag, prompt: input.prompt });
    return {
      ok: true,
      text: JSON.stringify({ search: { query: input.prompt, results: [{ title: "GPQA", url: "https://x", snippet: "..." }] } }),
      model: null,
      provider: null,
    };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].modality, "search");
  assert.equal(seen[0].tag, "research");
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const task = final.tasks[0];
  assert.equal(task.modality, "search");
  assert.equal(task.assignedModel, null, "search dispatch has no model");
  const parsed = JSON.parse(task.result ?? "{}");
  assert.equal(parsed.search.results[0].title, "GPQA");
});

test("runner: pre-B7 rows (no modality) resolve by tag — image_gen stays image", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob([{ id: "i1", tag: "image_gen", prompt: "a red scarf", depends_on: [] }]);
  // Simulate a pre-B7 task row: modality stripped.
  (job.tasks as Array<Record<string, unknown>>)[0].modality = undefined;
  store.createJob(job, null);
  const seen: Array<TaskModality> = [];
  const dispatch: TaskDispatch = async (input) => {
    seen.push(input.modality);
    return { ok: true, text: '{"images":[]}', model: "img", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  assert.deepEqual(seen, ["image"], "tag-implied modality when modality is absent");
});

test("runner: media tasks cannot answer @ask (mailbox skipped with a reason)", async () => {
  const store = new InMemoryJobsStore();
  const job = makeJob(
    [
      { id: "t1", tag: "chat", prompt: "write page 1", depends_on: [] },
      { id: "img", tag: "image_gen", prompt: "draw page 1", depends_on: [] },
    ],
    "swarm"
  );
  store.createJob(job, null);
  const dispatch: TaskDispatch = async (input) => {
    if (input.taskId === "t1") {
      return { ok: true, text: "page 1 text. @ask img: what color is the scarf?", model: "m", provider: "p" };
    }
    return { ok: true, text: '{"images":["data:image/png;base64,xx"]}', model: "img", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  const skipped = final.log.filter((entry) => entry.event === "mailbox_skipped");
  assert.equal(skipped.length, 1, "exactly one mailbox skip");
  assert.match(skipped[0].detail ?? "", /media task \(image\)/);
  // The ask was never relayed — no mailbox answer was recorded.
  const answers = (final.blackboard?.mailbox as unknown[]) ?? [];
  assert.equal(answers.length, 0);
  assert.equal(final.status, "done");
});

// ── Envelope builders (pure) ───────────────────────────────────────────────

test("envelopes: speech b64 under the cap, digest-only above it", () => {
  const small = new Uint8Array([1, 2, 3, 4]);
  const smallEnvelope = JSON.parse(buildSpeechEnvelope(small, "audio/mpeg", "tts-1"));
  assert.equal(smallEnvelope.speech.model, "tts-1");
  assert.equal(smallEnvelope.speech.content_type, "audio/mpeg");
  assert.equal(smallEnvelope.speech.bytes, 4);
  assert.ok(smallEnvelope.speech.sha256);
  assert.ok(smallEnvelope.speech.data_b64, "small audio is embedded");
  assert.equal(smallEnvelope.speech.truncated, undefined);

  const big = new Uint8Array(MEDIA_ENVELOPE_B64_CAP_BYTES + 1);
  const bigEnvelope = JSON.parse(buildSpeechEnvelope(big, "audio/mpeg", "tts-1"));
  assert.equal(bigEnvelope.speech.truncated, true);
  assert.equal(bigEnvelope.speech.data_b64, undefined, "oversized audio is not embedded");
  assert.equal(bigEnvelope.speech.bytes, MEDIA_ENVELOPE_B64_CAP_BYTES + 1);
  assert.ok(bigEnvelope.speech.sha256, "digest kept for verification");
});

test("envelopes: search passthrough and music/video JSON cap", () => {
  const search = JSON.parse(
    buildSearchEnvelope("gpqa results", { results: [{ title: "a" }, { title: "b" }] })
  );
  assert.equal(search.search.query, "gpqa results");
  assert.equal(search.search.results.length, 2);
  const empty = JSON.parse(buildSearchEnvelope("q", {}));
  assert.deepEqual(empty.search.results, []);

  const musicPayload = JSON.stringify({ created: 1, data: [{ url: "https://x/a.wav" }] });
  const music = JSON.parse(buildMediaEnvelope("music", "some/model", musicPayload));
  assert.equal(music.music.model, "some/model");
  assert.deepEqual(music.music.data.data[0].url, "https://x/a.wav");
  assert.equal(music.music.truncated, undefined);

  const bigPayload = "x".repeat(2 * 1024 * 1024 + 100);
  const video = JSON.parse(buildMediaEnvelope("video", "some/video-model", bigPayload));
  assert.equal(video.video.truncated, true);
  assert.equal(video.video.bytes, bigPayload.length);
  assert.ok(video.video.sha256);
  assert.equal(video.video.data, undefined);
});

// ── SQLite round-trip ──────────────────────────────────────────────────────

test("sqlite: modality persists; legacy NULL rows resolve by tag", async () => {
  const { SqliteJobsStore } = await import("../../../src/lib/db/orchestrateJobs.ts");
  const store = new SqliteJobsStore();
  const job = makeJob([
    { id: "m1", tag: "music_gen", prompt: "a song", depends_on: [] },
    { id: "s1", tag: "research", prompt: "look it up", modality: "search", depends_on: [] },
    { id: "c1", tag: "chat", prompt: "summarize", depends_on: [] },
  ]);
  const created = store.createJob(job, null);
  assert.ok(created !== "conflict");
  const loaded = store.getJob(job.jobId);
  assert.ok(loaded);
  const byId = new Map(loaded.tasks.map((task) => [task.id, task]));
  assert.equal(byId.get("m1")?.modality, "music");
  assert.equal(byId.get("s1")?.modality, "search");
  assert.equal(byId.get("c1")?.modality, "text");

  // Legacy row: modality NULL + tag image_gen → resolves to "image" at read.
  assert.equal(taskModalityOf({ tag: "image_gen", modality: null as unknown as undefined }), "image");
  assert.equal(taskModalityOf({ tag: "chat", modality: undefined }), "text");
});
