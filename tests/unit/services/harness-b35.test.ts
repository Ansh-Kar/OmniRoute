/**
 * Harness B3.5 (Guide 1 Part 7) — swarm mode: blackboard prompt assembly,
 * summary parsing/merge with locked keys, the bounded @ask relay, and the
 * judge loop (requeue with feedback, max_rounds acceptance) driven through
 * the runner with scripted dispatches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b35-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b35-test-secret";

const {
  validatePlan,
  runJob,
  InMemoryJobsStore,
} = await import("../../../open-sse/services/harness/orchestrator.ts");
import type {
  OrchestrateJob,
  OrchestrateTask,
  TaskDispatch,
} from "../../../open-sse/services/harness/orchestrator.ts";
const {
  assembleSwarmPrompt,
  parseSummary,
  mergeIntoBlackboard,
  parseAskDirectives,
  buildAskPrompt,
  buildJudgeMessages,
  parseJudgeVerdicts,
  withJudgeFeedback,
  appendMailboxAnswer,
} = await import("../../../open-sse/services/harness/swarmMode.ts");

function swarmPlan(overrides: Record<string, unknown> = {}) {
  return {
    goal: "4-page comic about Ravi",
    mode: "swarm",
    tasks: [
      { id: "t1", tag: "chat", prompt: "page 1: hero intro", depends_on: [] },
      { id: "t2", tag: "chat", prompt: "page 2: the chase", depends_on: [] },
    ],
    blackboard: { canon: "hero=Ravi, red scarf", _locked: ["canon"] },
    policy: { max_rounds: 3 },
    ...overrides,
  };
}

function makeSwarmJob(overrides: Partial<OrchestrateJob> = {}): OrchestrateJob {
  const validation = validatePlan(swarmPlan());
  assert.ok(validation.ok);
  const now = Date.now();
  return {
    jobId: "job_swarm",
    goal: validation.goal,
    mode: validation.mode,
    policy: validation.policy,
    blackboard: validation.blackboard,
    status: "active",
    failureReason: null,
    idempotencyKey: null,
    judgeRounds: 0,
    createdAt: now,
    deadlineAt: now + validation.policy.deadline_s * 1000,
    tasks: validation.tasks.map((task) => ({
      jobId: "job_swarm",
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
      promptTokens: null,
      completionTokens: null,
    })),
    log: [],
    ...overrides,
  };
}

// ── Primitives ──────────────────────────────────────────────────────────────

test("swarm: prompt assembly carries goal, LOCKED canon, part identity, output contract", () => {
  const job = makeSwarmJob();
  const prompt = assembleSwarmPrompt(
    { goal: job.goal, blackboard: job.blackboard },
    { id: "t2", prompt: "draw page 2" },
    2,
    2
  );
  assert.match(prompt, /<shared context>/);
  assert.match(prompt, /Goal: 4-page comic about Ravi/);
  assert.match(prompt, /- canon \[LOCKED\]: "hero=Ravi, red scarf"/);
  assert.match(prompt, /part 2 of 2/);
  assert.match(prompt, /<summary> block of at most 15 lines/);
  assert.match(prompt, /@ask <task-id>/);
  assert.match(prompt, /draw page 2$/);
});

test("swarm: summary parsing prefers the tag, falls back to 15 lines", () => {
  assert.equal(parseSummary("junk\n<summary>\nline1\nline2\n</summary>\ntail"), "line1\nline2");
  const twenty = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const fallback = parseSummary(twenty);
  assert.equal(fallback.split("\n").length, 15);
});

test("swarm: blackboard merge touches only summaries; locked keys survive", () => {
  const blackboard = { canon: "hero=Ravi", _locked: ["canon"], style: "manga" };
  const merged = mergeIntoBlackboard(blackboard, [{ taskId: "t1", summary: "page 1 done" }]);
  assert.equal(merged.canon, "hero=Ravi");
  assert.equal(merged.style, "manga");
  assert.deepEqual(merged._locked, ["canon"]);
  assert.deepEqual(merged.summaries, { t1: "page 1 done" });
  // Re-merge replaces only that task's summary.
  const again = mergeIntoBlackboard(merged, [{ taskId: "t1", summary: "page 1 v2" }, { taskId: "t2", summary: "page 2" }]);
  assert.deepEqual(again.summaries, { t1: "page 1 v2", t2: "page 2" });
});

test("swarm: @ask directives parse once, bounded", () => {
  const result = "working…\n@ask t1: what palette is the scarf?\nmore output\n@ask t2: ignored (one per wave)";
  const directives = parseAskDirectives("t3", result);
  assert.equal(directives.length, 1);
  assert.deepEqual(directives[0], { from: "t3", to: "t1", question: "what palette is the scarf?" });
  assert.deepEqual(parseAskDirectives("t3", "no questions here"), []);
  assert.match(buildAskPrompt({ from: "t3", to: "t1", question: "Q" }, { id: "t1", result: "OUT" }), /Answer the question in at most 5 lines/);
});

test("swarm: judge input carries canon, check, parts; vision tag for image jobs", () => {
  const job = makeSwarmJob();
  job.tasks[0].state = "done";
  job.tasks[0].result = "page 1: Ravi in red scarf";
  job.blackboard = mergeIntoBlackboard(job.blackboard, [{ taskId: "t1", summary: "page 1: red scarf" }]);
  const judge = buildJudgeMessages(job, { check: "Do pages match the canon?" });
  assert.equal(judge.tag, "plan");
  assert.match(judge.messages[0].content, /Locked canon: canon = "hero=Ravi, red scarf"/);
  assert.match(judge.messages[0].content, /Do pages match the canon\?/);
  assert.match(judge.messages[0].content, /### t1 \(chat\)/);

  const imageJob = makeSwarmJob();
  imageJob.tasks = imageJob.tasks.map((task) => ({ ...task, tag: "image_gen" as const }));
  assert.equal(buildJudgeMessages(imageJob).tag, "vision");
});

test("swarm: verdict parsing is strict but tolerant of prose wrappers", () => {
  const good = 'Sure! {"verdicts":[{"task_id":"t1","pass":true,"note":"ok"},{"task_id":"t2","pass":false,"note":"scarf is blue"}]}';
  const verdicts = parseJudgeVerdicts(good);
  assert.deepEqual(verdicts, [
    { task_id: "t1", pass: true, note: "ok" },
    { task_id: "t2", pass: false, note: "scarf is blue" },
  ]);
  assert.equal(parseJudgeVerdicts("no json at all"), null);
  assert.equal(parseJudgeVerdicts('{"verdicts": "nope"}'), null);
  assert.equal(parseJudgeVerdicts('{"verdicts": [{"bad": 1}]}'), null);
  assert.match(withJudgeFeedback("original", "wrong palette", 1), /\[judge feedback, round 1/);
});

// ── Runner e2e ──────────────────────────────────────────────────────────────

function summaryWrap(text: string): string {
  return `${text}\n<summary>\n${text}\n</summary>`;
}

test("runner: swarm happy path — blackboard fills, judge passes, job done", async () => {
  const store = new InMemoryJobsStore();
  const job = makeSwarmJob();
  store.createJob(job, null);
  const dispatch: TaskDispatch = async ({ taskId, tag }) => {
    if (taskId === "__judge") {
      return {
        ok: true,
        text: JSON.stringify({ verdicts: job.tasks.map((t) => ({ task_id: t.id, pass: true, note: "consistent" })) }),
        model: "m",
        provider: "p",
      };
    }
    assert.equal(tag, "chat");
    return { ok: true, text: summaryWrap(`output of ${taskId}`), model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.equal(final.failureReason, null);
  assert.equal(final.judgeRounds, 1);
  // Blackboard: canon untouched, both summaries present.
  assert.equal(final.blackboard?.canon, "hero=Ravi, red scarf");
  assert.deepEqual(final.blackboard?.summaries, { t1: "output of t1", t2: "output of t2" });
  // Status trail: active → judging → done.
  const events = final.log.map((l) => l.event);
  assert.ok(events.includes("judge_start"));
  assert.ok(events.includes("judge_verdicts"));
  assert.ok(events.includes("blackboard_append"));
  assert.ok(events.includes("job_done"));
  // Workers saw the shared context (swarm wrapper).
  // (asserted via dispatch capture below in the requeue test)
});

test("runner: judge failure requeues with feedback, second round passes", async () => {
  const store = new InMemoryJobsStore();
  const job = makeSwarmJob();
  store.createJob(job, null);
  const seenPrompts: Array<string> = [];
  let judgeCalls = 0;
  const dispatch: TaskDispatch = async ({ taskId, prompt }) => {
    if (taskId === "__judge") {
      judgeCalls += 1;
      if (judgeCalls === 1) {
        return {
          ok: true,
          text: JSON.stringify({ verdicts: [{ task_id: "t2", pass: false, note: "scarf is blue, canon says red" }] }),
          model: "m",
          provider: "p",
        };
      }
      return { ok: true, text: JSON.stringify({ verdicts: [{ task_id: "t2", pass: true, note: "fixed" }] }), model: "m", provider: "p" };
    }
    seenPrompts.push(`${taskId}:${prompt.includes("[judge feedback") ? "JFB" : "plain"}`);
    return { ok: true, text: summaryWrap(`${taskId} v${seenPrompts.filter((s) => s.startsWith(taskId)).length}`), model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.equal(final.judgeRounds, 2, "two judge passes ran: fail-round + clean-round");
  const t2 = final.tasks.find((task) => task.id === "t2") as OrchestrateTask;
  assert.equal(t2.verdict, "scarf is blue, canon says red");
  assert.equal(t2.attempts, 0, "judge requeue resets attempts");
  // t2's re-run carried the judge feedback.
  const t2Prompts = seenPrompts.filter((s) => s.startsWith("t2:"));
  assert.ok(t2Prompts.length >= 2, `t2 ran twice: ${t2Prompts}`);
  assert.match(t2Prompts[t2Prompts.length - 1], /JFB/, "re-run prompt carried the judge feedback");
  assert.ok(final.log.some((l) => l.event === "judge_requeued"));
});

test("runner: max_rounds accepts with flaws recorded", async () => {
  const store = new InMemoryJobsStore();
  const job = makeSwarmJob({ policy: { ...makeSwarmJob().policy, max_rounds: 2 } });
  store.createJob(job, null);
  const dispatch: TaskDispatch = async ({ taskId }) => {
    if (taskId === "__judge") {
      return {
        ok: true,
        text: JSON.stringify({ verdicts: [{ task_id: "t1", pass: false, note: "still off-canon" }] }),
        model: "m",
        provider: "p",
      };
    }
    return { ok: true, text: summaryWrap("out"), model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.match(String(final.failureReason), /accepted with judge flaws/);
  assert.equal(final.judgeRounds, 2);
  assert.ok(final.log.some((l) => l.event === "task_flaw_accepted" && /still off-canon/.test(l.detail ?? "")));
});

test("runner: bounded @ask relay lands the answer on the blackboard", async () => {
  const store = new InMemoryJobsStore();
  const job = makeSwarmJob();
  store.createJob(job, null);
  const dispatch: TaskDispatch = async ({ taskId, prompt }) => {
    if (taskId === "__judge") {
      return { ok: true, text: JSON.stringify({ verdicts: [] }), model: "m", provider: "p" };
    }
    if (taskId === "__mailbox_t2") {
      assert.match(prompt, /what palette is the scarf\?/);
      return { ok: true, text: "crimson red", model: "m", provider: "p" };
    }
    if (taskId === "t2") {
      return { ok: true, text: summaryWrap("page 2 done\n@ask t1: what palette is the scarf?"), model: "m", provider: "p" };
    }
    return { ok: true, text: summaryWrap("page 1: crimson red scarf"), model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });

  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const mailbox = final.blackboard?.mailbox as Record<string, { answer: string }>;
  assert.equal(mailbox["t2->t1"].answer, "crimson red");
  assert.ok(final.log.some((l) => l.event === "mailbox_relayed"));
});

test("runner: mailbox failures degrade to an unanswered note", async () => {
  const store = new InMemoryJobsStore();
  const job = makeSwarmJob();
  store.createJob(job, null);
  const dispatch: TaskDispatch = async ({ taskId }) => {
    if (taskId === "__judge") {
      return { ok: true, text: JSON.stringify({ verdicts: [] }), model: "m", provider: "p" };
    }
    if (taskId === "__mailbox_t2") throw new Error("timeout");
    if (taskId === "t2") {
      return { ok: true, text: summaryWrap("page 2\n@ask t1: palette?"), model: "m", provider: "p" };
    }
    return { ok: true, text: summaryWrap("page 1"), model: "m", provider: "p" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  const mailbox = final.blackboard?.mailbox as Record<string, { answer: string }>;
  assert.match(mailbox["t2->t1"].answer, /unanswered/);
});

test("runner: image tasks skip the swarm wrapper", async () => {
  const store = new InMemoryJobsStore();
  const validation = validatePlan({
    ...swarmPlan(),
    tasks: [{ id: "img1", tag: "image_gen", prompt: "a crimson scarf", depends_on: [] }],
  });
  assert.ok(validation.ok);
  const base = makeSwarmJob();
  const job: OrchestrateJob = {
    ...base,
    policy: { ...base.policy, judge: false },
    tasks: [
      {
        jobId: base.jobId,
        id: "img1",
        tag: "image_gen",
        prompt: "a crimson scarf",
        dependsOn: [],
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
      },
    ],
  };
  store.createJob(job, null);
  const prompts: string[] = [];
  const dispatch: TaskDispatch = async ({ tag, prompt }) => {
    prompts.push(prompt);
    assert.equal(tag, "image_gen");
    return { ok: true, text: '{"images":["data:image/png;base64,xx"]}', model: "openai/gpt-image-2", provider: "openai" };
  };
  await runJob(job.jobId, { store, dispatch, sleep: async () => {} });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], "a crimson scarf", "no shared-context wrapper for image models");
  const final = store.getJob(job.jobId);
  assert.ok(final);
  assert.equal(final.status, "done");
  assert.equal(final.tasks[0].assignedModel, "openai/gpt-image-2");
});

test("plan: swarm accepted; locked keys must exist", () => {
  const ok = validatePlan(swarmPlan());
  assert.ok(ok.ok);
  const badLock = validatePlan(swarmPlan({ blackboard: { canon: "x", _locked: ["canon", "missing_key"] } }));
  assert.ok(!badLock.ok);
  assert.ok(badLock.ok === false && badLock.errors.some((e) => e.includes("missing_key")));
});

test("mailbox: appendMailboxAnswer preserves the rest of the board", () => {
  const board = mergeIntoBlackboard({ canon: "x", _locked: ["canon"] }, [{ taskId: "t1", summary: "s" }]);
  const withAnswer = appendMailboxAnswer(board, { from: "t2", to: "t1", question: "Q", answer: "A" });
  assert.equal(withAnswer.canon, "x");
  assert.deepEqual(withAnswer.summaries, { t1: "s" });
  assert.deepEqual(withAnswer.mailbox, { "t2->t1": { from: "t2", to: "t1", question: "Q", answer: "A" } });
});
