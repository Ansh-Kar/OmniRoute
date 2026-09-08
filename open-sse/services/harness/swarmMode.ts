/**
 * Swarm mode primitives (harness B3.5, Guide 1 Part 7) — blackboard prompt
 * assembly, summary-block parsing, the bounded A2A question relay, and the
 * judge pass. Pure functions over job/task shapes; the wave runner in
 * orchestrator.ts drives them.
 *
 * The guide's three failure modes for free-form agent chat — context drift,
 * token burn, unbounded loops — are avoided by construction: workers share
 * state ONLY through blackboard summaries (append-parsed by the harness,
 * never worker-written), may ask at most ONE bounded question per wave
 * (relayed by the harness, 30s timeout, answer lands on the blackboard),
 * and refinement is hard-capped by max_rounds.
 */

import type { OrchestrateJob, OrchestrateTask } from "./orchestrator.ts";

// ── Prompt assembly ─────────────────────────────────────────────────────────

export const SUMMARY_LINE_CAP = 15;

/**
 * Wrap a worker task's prompt with the shared context (guide Part 7.1):
 * goal, blackboard snapshot (locked keys marked LOCKED), part identity,
 * and the output contract — end with a ≤15-line <summary> block.
 */
export function assembleSwarmPrompt(
  job: Pick<OrchestrateJob, "goal" | "blackboard">,
  task: Pick<OrchestrateTask, "id" | "prompt">,
  partIndex: number,
  partCount: number
): string {
  const lines = [
    "<shared context>",
    `Goal: ${job.goal}`,
  ];
  const blackboard = job.blackboard ?? {};
  const locked = new Set(
    Array.isArray(blackboard._locked) ? (blackboard._locked as string[]) : []
  );
  const keys = Object.keys(blackboard).filter((key) => key !== "_locked");
  if (keys.length > 0) {
    lines.push("Blackboard (shared state; LOCKED keys must not be contradicted):");
    for (const key of keys) {
      const marker = locked.has(key) ? " [LOCKED]" : "";
      lines.push(`- ${key}${marker}: ${truncate(JSON.stringify(blackboard[key]), 400)}`);
    }
  } else {
    lines.push("Blackboard: (empty — you are setting the conventions)");
  }
  lines.push(
    `You are part ${partIndex} of ${partCount}. Other parts: ${"[see blackboard]"}.`,
    "Read the blackboard; match established conventions.",
    `When done, your output MUST end with a <summary> block of at most ${SUMMARY_LINE_CAP} lines for the blackboard.`,
    "If you need one specific fact from another part, include a line exactly:",
    "  @ask <task-id>: <one-line question>",
    "</shared context>",
    "",
    task.prompt
  );
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── Summary parsing + blackboard merge ──────────────────────────────────────

/**
 * Extract a task's blackboard summary from its result: the <summary> block
 * when present, else the first SUMMARY_LINE_CAP lines (lenient). The harness
 * — never the worker — writes it to the blackboard.
 */
export function parseSummary(result: string): string {
  const tagged = result.match(/<summary>([\s\S]*?)<\/summary>/);
  const body = (tagged ? tagged[1] : result).trim();
  const lines = body.split("\n").slice(0, SUMMARY_LINE_CAP);
  return lines.join("\n").trim();
}

/**
 * Merge parsed summaries + mailbox answers into the blackboard. Workers
 * never touch anything outside `summaries` / `mailbox`; locked keys and all
 * other entries are preserved verbatim (guide Part 7.2).
 */
export function mergeIntoBlackboard(
  blackboard: Record<string, unknown> | null,
  appends: Array<{ taskId: string; summary: string }>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(blackboard ?? {}) };
  const summaries = { ...((next.summaries as Record<string, unknown>) ?? {}) };
  for (const { taskId, summary } of appends) {
    summaries[taskId] = summary;
  }
  next.summaries = summaries;
  return next;
}

export function appendMailboxAnswer(
  blackboard: Record<string, unknown> | null,
  entry: { from: string; to: string; question: string; answer: string }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(blackboard ?? {}) };
  const mailbox = { ...((next.mailbox as Record<string, unknown>) ?? {}) };
  mailbox[`${entry.from}->${entry.to}`] = entry;
  next.mailbox = mailbox;
  return next;
}

// ── Bounded A2A question relay ──────────────────────────────────────────────

export const MAILBOX_TIMEOUT_MS = 30_000;

export type AskDirective = { from: string; to: string; question: string };

/**
 * Parse `@ask <task-id>: <question>` directives from a worker's result —
 * at most one per worker per wave (guide Part 7.3), answered by the harness
 * (a bounded dispatch to the asked worker's specialty), never by pausing
 * anyone. Unanswerable → the asker proceeds with a note.
 */
export function parseAskDirectives(taskId: string, result: string): AskDirective[] {
  const match = result.match(/@ask\s+([A-Za-z0-9_-]+)\s*:\s*(.+)/);
  if (!match) return [];
  const question = match[2].trim().slice(0, 500);
  if (!question) return [];
  return [{ from: taskId, to: match[1], question }];
}

export function buildAskPrompt(ask: AskDirective, targetTask: Pick<OrchestrateTask, "id" | "result">): string {
  const targetOutput = truncate(targetTask.result ?? "(no output yet)", 1200);
  return [
    `Another worker (${ask.from}) working on the same job asks you (worker ${ask.to}) one bounded question:`,
    `"${ask.question}"`,
    "",
    "Your most recent output was:",
    targetOutput,
    "",
    "Answer the question in at most 5 lines. Be specific and factual.",
  ].join("\n");
}

// ── Judge pass ──────────────────────────────────────────────────────────────

export const JUDGE_INSTRUCTION = [
  "You are the consistency judge for a multi-part job. Reply with ONLY a JSON object, no prose:",
  '{"verdicts": [{"task_id": "<id>", "pass": true, "note": "<short reason>"}]}',
  "Judge EVERY part against its spec and the shared conventions. A part FAILS only when its output",
  "materially contradicts the locked canon, misses its stated deliverable, or is unusable.",
].join("\n");

export type JudgeVerdict = { task_id: string; pass: boolean; note: string };

/**
 * Build the judge dispatch: the check (caller-supplied or the default
 * locked-canon consistency check), the canon, and every part's summary.
 * Vision jobs judge on the vision tag, everything else on plan (guide
 * Part 6: "vision tag for image outputs, plan tag otherwise").
 */
export function buildJudgeMessages(
  job: Pick<OrchestrateJob, "goal" | "blackboard" | "tasks">,
  options: { check?: string; specKey?: string } = {}
): { tag: "plan" | "vision"; messages: Array<{ role: string; content: string }> } {
  const blackboard = job.blackboard ?? {};
  const locked = Array.isArray(blackboard._locked) ? (blackboard._locked as string[]) : [];
  const canon = locked.map((key) => `${key} = ${JSON.stringify(blackboard[key])}`).join("; ");
  const check =
    options.check ??
    (canon ? `Do all outputs match the locked canon? List violations per task.` : "Are all parts consistent with each other and complete? List violations per task.");
  const parts = job.tasks
    .filter((task) => task.state === "done")
    .map((task) => {
      const summary = (blackboard.summaries as Record<string, string> | undefined)?.[task.id];
      return `### ${task.id} (${task.tag})\n${truncate(summary ?? task.result ?? "", 600)}`;
    })
    .join("\n\n");
  // B7: image/video outputs need a vision-capable judge (it inspects the
  // generated media envelope); speech/music/search stay text-judged. The
  // tags are checked directly (validation guarantees image/video modality
  // only ever pairs with image_gen/video_gen) — this also covers pre-B7
  // rows that carry no modality at all.
  const hasVisualTasks = job.tasks.some(
    (task) =>
      task.modality === "image" ||
      task.modality === "video" ||
      task.tag === "image_gen" ||
      task.tag === "video_gen"
  );
  return {
    tag: hasVisualTasks ? "vision" : "plan",
    messages: [
      {
        role: "user",
        content: [
          `Job goal: ${job.goal}`,
          canon ? `Locked canon: ${canon}` : "",
          options.specKey ? `Spec key under review: ${options.specKey}` : "",
          "",
          "Parts produced:",
          parts,
          "",
          `Check: ${check}`,
          "",
          JUDGE_INSTRUCTION,
        ]
          .filter((line) => line !== "")
          .join("\n"),
      },
    ],
  };
}

/** Parse the judge's verdict JSON; any garbage → null (retry/accept path). */
export function parseJudgeVerdicts(raw: string): JudgeVerdict[] | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { verdicts?: unknown };
    if (!Array.isArray(parsed.verdicts)) return null;
    const verdicts: JudgeVerdict[] = [];
    for (const entry of parsed.verdicts) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as JudgeVerdict).task_id === "string" &&
        typeof (entry as JudgeVerdict).pass === "boolean"
      ) {
        verdicts.push({
          task_id: (entry as JudgeVerdict).task_id,
          pass: (entry as JudgeVerdict).pass,
          note: typeof (entry as JudgeVerdict).note === "string" ? (entry as JudgeVerdict).note.slice(0, 500) : "",
        });
      }
    }
    // Zero valid entries = unparseable judge output. Returning [] would
    // read as "everything passed" — never fabricate a clean verdict.
    return verdicts.length > 0 ? verdicts : null;
  } catch {
    return null;
  }
}

/** Prompt for a judge-failed task's re-run: the verdict is injected. */
export function withJudgeFeedback(originalPrompt: string, verdict: string, round: number): string {
  return `${originalPrompt}\n\n[judge feedback, round ${round}: the previous output failed review — "${verdict}". Fix exactly this.]`;
}
