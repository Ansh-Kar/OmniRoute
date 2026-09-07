/**
 * Task classifier — request → {type, complexity, modalities} (harness Layer 3,
 * build B1). The piece that lets the gateway allocate models per task NEED
 * (the "Gemini allocator"): what kind of work is this, and how heavy is it?
 *
 * Two stages, cheapest first:
 *   1. Heuristics (free, ~0 ms, always runs): body shape (image parts →
 *      vision) + keyword scoring over the user turns (code / math / search /
 *      research / chat). Deterministic and unit-tested — the mods.md
 *      `classify()` heir.
 *   2. Model fallback (opt-in, costs one cheap call): when stage 1 is
 *      ambivalent (low confidence) AND the caller supplies a dispatch
 *      function, a classifier model re-reads the request and returns strict
 *      JSON. Any parse/validation failure falls back to stage 1 — the
 *      classifier can only REFINE the decision, never break the request.
 *
 * Output feeds `POST /v1/harness/classify`, `POST /v1/harness/task`, and the
 * recommended alias is a capabilityAliases.ts name (same vocabulary), so "classified as code"
 * and "routes as code" share one vocabulary (TASK_TYPE_TO_QUERY) and can
 * never drift apart.
 */

import { TASK_TYPES, type TaskType } from "../modelTags/index.ts";

export type TaskComplexity = "fast" | "deep";

export type TaskClassification = {
  type: TaskType;
  complexity: TaskComplexity;
  /** Content modalities detected in the request (e.g. ["vision"]). */
  modalities: string[];
  confidence: "high" | "medium" | "low";
  stage: "heuristics" | "model";
  /** The capability alias the harness would route this request to. */
  alias: string;
  /** Short human-readable explanation of the decision (logs, API surface). */
  reason: string;
};

type Body = Record<string, unknown>;

// ── Stage 1: heuristics ─────────────────────────────────────────────────────

const TYPE_PATTERNS: Array<{ type: TaskType; pattern: RegExp; weight: number }> = [
  {
    type: "code",
    weight: 2,
    pattern:
      /\b(code|coding|function|bug|debug|stack ?trace|exception|compile|refactor|implement|unit ?test|api|sdk|library|regex|typescript|javascript|python|rust|golang|java|kotlin|swift|sql|css|html|docker|kubernetes|git)\b/i,
  },
  {
    type: "math",
    weight: 2,
    pattern:
      /\b(prove|proof|theorem|lemma|equation|integral|derivative|matrix|eigenvalue|probability|combinatoric|algebra|calculus|solve for|compute the|calculate the)\b/i,
  },
  {
    type: "search",
    weight: 2,
    pattern:
      /\b(latest|newest|today|yesterday|this week|this month|currently|right now|news|breaking|search (for|the web)|look up|who won|what happened|price of|stock price|weather)\b/i,
  },
  {
    type: "research",
    weight: 1,
    pattern:
      /\b(research|survey|literature|state of the art|compare .{3,40} (and|vs\.?|with) .{3,40}|trade-?offs?|deep dive|analysis of|analyze the|evaluate the)\b/i,
  },
  {
    type: "reasoning",
    weight: 1,
    pattern:
      /\b(logic|deduce|deduction|infer|inference|puzzle|riddle|paradox|step-by-step reasoning|chain of thought|think (it )?through|reason (about|through|carefully))\b/i,
  },
  {
    type: "vision",
    weight: 0,
    pattern: /$^/, // vision is decided by body shape, not keywords
  },
  {
    type: "chat",
    weight: 0,
    pattern: /$^/,
  },
];

const DEEP_MARKERS =
  /\b(step[- ]by[- ]step|thorough(ly)?|careful(ly)?|in depth|deep(ly)?|comprehensive|exhaustive|detailed|architect|design a|plan (a|the)|long[- ]form|essay|whitepaper)\b/i;

function collectRequestText(body: Body): { text: string; messageCount: number } {
  const parts: string[] = [];
  let messageCount = 0;
  const messages = body.messages;
  if (Array.isArray(messages)) {
    messageCount = messages.length;
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
            parts.push((part as Record<string, unknown>).text as string);
          }
        }
      }
    }
  }
  if (typeof body.prompt === "string") parts.push(body.prompt); // completions-style
  if (typeof body.input === "string") parts.push(body.input); // responses-style
  return { text: parts.join("\n"), messageCount };
}

/**
 * Detect content modalities from the request body: OpenAI content parts
 * (`image_url`, `input_audio`), Anthropic blocks, Gemini `inline_data`. A
 * JSON-walk keeps it protocol-agnostic and cheap.
 */
function detectModalities(body: Body): string[] {
  const serialized = JSON.stringify(body).slice(0, 200_000); // cap the walk
  const modalities = new Set<string>();
  if (/"type"\s*:\s*"image(_url|_input)?"/.test(serialized) || /"image_url"/.test(serialized)) {
    modalities.add("vision");
  }
  if (/"type"\s*:\s*"input_audio"/.test(serialized) || /"input_audio"/.test(serialized)) {
    modalities.add("audio");
  }
  if (/"mimeType"\s*:\s*"image\//i.test(serialized)) modalities.add("vision");
  if (/"mimeType"\s*:\s*"audio\//i.test(serialized)) modalities.add("audio");
  return [...modalities];
}

function aliasForType(type: TaskType): string {
  // image_gen is classified for informational purposes but has no chat-shaped
  // alias; the harness routes such requests to the media endpoints (B5).
  return type === "image_gen" ? "chat" : type;
}

/** Stage 1 — deterministic heuristics. Always safe; never throws. */
export function classifyRequestBody(body: Body): TaskClassification {
  const { text, messageCount } = collectRequestText(body);
  const modalities = detectModalities(body);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // Body shape first: an image-bearing request is a vision task, full stop.
  if (modalities.includes("vision")) {
    return {
      type: "vision",
      complexity: estimateComplexity(text, messageCount),
      modalities,
      confidence: "high",
      stage: "heuristics",
      alias: aliasForType("vision"),
      reason: "request carries image content",
    };
  }

  const scores = new Map<TaskType, number>();
  for (const { type, pattern, weight } of TYPE_PATTERNS) {
    if (weight === 0) continue;
    const matches = text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"));
    if (matches) scores.set(type, (scores.get(type) ?? 0) + weight * Math.min(matches.length, 3));
  }
  // Tool-bearing requests lean code (agents that call tools are usually
  // coding/acting), but weakly — a keyword winner still beats it.
  if (hasTools) scores.set("code", (scores.get("code") ?? 0) + 1);

  let best: TaskType = "chat";
  let bestScore = 0;
  let runnerUp = 0;
  for (const type of TASK_TYPES) {
    const score = scores.get(type) ?? 0;
    if (score > bestScore) {
      runnerUp = bestScore;
      best = type;
      bestScore = score;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (bestScore === 0) {
    return {
      type: "chat",
      complexity: estimateComplexity(text, messageCount),
      modalities,
      confidence: "low",
      stage: "heuristics",
      alias: aliasForType("chat"),
      reason: "no capability signal — default assistant route",
    };
  }
  return {
    type: best,
    complexity: estimateComplexity(text, messageCount),
    modalities,
    confidence: bestScore - runnerUp >= 2 || bestScore >= 4 ? "high" : "medium",
    stage: "heuristics",
    alias: aliasForType(best),
    reason: `keyword signal: ${best} (score ${bestScore})`,
  };
}

function estimateComplexity(text: string, messageCount: number): TaskComplexity {
  if (text.length > 6000) return "deep";
  if (messageCount > 12) return "deep";
  if (DEEP_MARKERS.test(text)) return "deep";
  return "fast";
}

// ── Stage 2: model fallback (opt-in) ────────────────────────────────────────

export type ClassifierDispatch = (
  body: Body,
  model: string
) => Promise<Response>;

const STAGE2_PROMPT = [
  "Classify the user's request for model routing. Reply with ONLY a JSON object, no prose:",
  '{"type": "code|research|math|reasoning|vision|search|chat", "complexity": "fast|deep", "reason": "<=12 words"}',
  "- code: writing/reviewing/debugging code, technical implementation",
  "- research: multi-source synthesis, comparisons, literature",
  "- math: mathematics, formal proofs, computation",
  "- vision: image understanding (only if the request discusses images)",
  "- search: current facts, news, lookups that need the web",
  "- chat: general conversation, writing, explanations",
  "- complexity deep: needs careful multi-step reasoning or long output; fast otherwise",
].join("\n");

/**
 * Classify a request. Stage 1 always runs; stage 2 (a cheap model call) only
 * when stage 1 confidence is low AND the caller provides a dispatch function.
 * Stage-2 failures (non-JSON, bad enum, HTTP error) degrade to stage 1.
 */
export async function classifyRequest(
  body: Body,
  options: { dispatch?: ClassifierDispatch; classifierModel?: string } = {}
): Promise<TaskClassification> {
  const heuristic = classifyRequestBody(body);
  if (heuristic.confidence !== "low" || !options.dispatch) return heuristic;

  const model = options.classifierModel?.trim() || "chat"; // the chat capability alias
  try {
    const response = await options.dispatch(
      {
        model,
        stream: false,
        messages: [
          { role: "system", content: STAGE2_PROMPT },
          { role: "user", content: JSON.stringify(body).slice(0, 24_000) },
        ],
      },
      model
    );
    if (!response.ok) return heuristic;
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return heuristic;
    const parsed = JSON.parse(match[0]) as { type?: unknown; complexity?: unknown; reason?: unknown };
    const type = TASK_TYPES.includes(parsed.type as TaskType) ? (parsed.type as TaskType) : null;
    if (!type) return heuristic;
    return {
      type,
      complexity: parsed.complexity === "deep" ? "deep" : "fast",
      modalities: heuristic.modalities,
      confidence: "medium",
      stage: "model",
      alias: aliasForType(type),
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, 120)
          : "model-classified",
    };
  } catch {
    return heuristic;
  }
}
