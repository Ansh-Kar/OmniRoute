/**
 * Swarm strategy — fork(parallel-execution) coverage.
 *
 * The one-call multi-task fan-out that fusion (same task, panel + judge) and
 * pipeline (different tasks, sequential) both lack: assign N different tasks,
 * pick a specialist for each (explicit `provider/model`, `fromTags`
 * provider/category/benchmark retrieval, or the combo's defaultModel), run
 * them in parallel under a bounded pool, and return labeled per-task results
 * (or a synthesized merge).
 *
 * Drives the REAL combo engine (handleComboChat) with the LIVE provider
 * registry — the tag index is assembled from static build-time config, so
 * fromTags resolution is deterministic without network or DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-swarm-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "swarm-test-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const {
  buildSwarmSynthesisPrompt,
  parseSwarmRunConfig,
  parseSwarmTaskSpecs,
  resolveSwarmTargets,
  SWARM_DEFAULTS,
} = await import("../../../open-sse/services/swarm.ts");
const { getModelTagIndex, findModelsByTags } = await import(
  "../../../open-sse/services/modelTags/index.ts"
);
const { createComboSchema } = await import("../../../src/shared/validation/schemas.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

function okResponse(content: string, model = "worker"): Response {
  return new Response(
    JSON.stringify({ model, choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function errResponse(status = 500): Response {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function swarmCombo(config: Record<string, unknown>, models: unknown[] = []) {
  return { name: "swarm-test", strategy: "swarm", models, config };
}

const TOOLS = [{ type: "function", function: { name: "f", parameters: {} } }];

// ── End-to-end dispatch ─────────────────────────────────────────────────────

test("swarm: different tasks fan out to different models in parallel", async () => {
  const calls: Array<{ model: string; body: Body }> = [];
  const handleSingleModel = async (b: Body, m: string) => {
    calls.push({ model: m, body: b });
    return okResponse(`ans-${m}`);
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "build me a landing page" }] },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "copy", task: "Write the landing page copy.", model: "openai/gpt-5.5" },
          { label: "art", task: "Describe the hero illustration.", model: "anthropic/claude-opus-4.6" },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(calls.length, 2, "exactly one call per task");
  assert.deepEqual(
    calls.map((c) => c.model).sort(),
    ["anthropic/claude-opus-4.6", "openai/gpt-5.5"]
  );

  // Worker bodies: task instruction prepended, stream forced off, tools and
  // the request-side `swarm` override never leak upstream.
  for (const c of calls) {
    assert.equal(c.body.stream, false, "workers run non-streaming");
    assert.ok(!("tools" in c.body), "tools must be stripped from workers");
    assert.ok(!("swarm" in c.body), "body.swarm must not leak to providers");
    const messages = c.body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0].role, "system", "task instruction is the leading system turn");
    assert.ok(
      messages[0].content.includes("landing page") || messages[0].content.includes("illustration"),
      "each worker sees its own task"
    );
    assert.equal(messages.length, 2, "original user turn preserved after the system turn");
  }

  // Response: synthetic OpenAI chat completion with labeled sections.
  const json = await res.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.model, "swarm/swarm-test");
  assert.ok(json.choices[0].message.content.includes("## copy"), "copy section labeled");
  assert.ok(json.choices[0].message.content.includes("## art"), "art section labeled");
  assert.ok(json.choices[0].message.content.includes("ans-openai/gpt-5.5"));
  assert.ok(json.choices[0].message.content.includes("ans-anthropic/claude-opus-4.6"));
});

test("swarm: body.swarm.tasks overrides the combo's configured tasks", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`out-${m}`);
  };

  const res = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "Q" }],
      swarm: { tasks: [{ label: "runtime", task: "runtime task", model: "grok/grok-4" }] },
    },
    combo: swarmCombo({
      swarm: {
        tasks: [{ label: "config", task: "config task", model: "openai/gpt-5.5" }],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["grok/grok-4"], "configured task must not run when body.swarm overrides");
  const json = await res.json();
  assert.ok(json.choices[0].message.content.includes("## runtime"));
  assert.ok(!json.choices[0].message.content.includes("## config"));
});

test("swarm: fromTags resolves distinct specialists across distinct providers", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`t-${m}`);
  };

  const spec = { category: "chat", minBenchmark: 85 };
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "plan a product launch" }] },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "strategy", task: "Draft the go-to-market strategy.", fromTags: spec },
          { label: "risks", task: "List the top risks.", fromTags: spec },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  assert.equal(seen.length, 2, "one worker per task");
  assert.equal(new Set(seen).size, 2, "identical tag specs must yield DIFFERENT models");
  const providers = seen.map((m) => m.slice(0, m.indexOf("/")));
  assert.equal(new Set(providers).size, 2, "swarm spans distinct providers");

  // Determinism: the same spec reproduces the same retrieval order.
  const expected = findModelsByTags(getModelTagIndex(), {
    category: "chat",
    minBenchmark: 85,
    distinctModels: true,
    diverseProviders: true,
  });
  assert.deepEqual(seen, expected.slice(0, 2).map((e) => e.id));
});

test("swarm: partial failure keeps the successful sections and reports the failed one", async () => {
  const handleSingleModel = async (_b: Body, m: string) => {
    if (m === "flaky/x") return errResponse(503);
    return okResponse(`good-${m}`);
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "solid", task: "solid task", model: "solid/y" },
          { label: "flaky", task: "flaky task", model: "flaky/x" },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200, "one dead task must not sink the run");
  const json = await res.json();
  const content = json.choices[0].message.content as string;
  assert.ok(content.includes("## solid"));
  assert.ok(content.includes("good-solid/y"));
  assert.ok(content.includes("task failed"), "failed task is reported, not hidden");
});

test("swarm: total failure returns 503 with per-task reasons", async () => {
  const handleSingleModel = async () => errResponse(500);

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "a", task: "a task", model: "p/one" },
          { label: "b", task: "b task", model: "p/two" },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 503);
  const json = await res.json();
  const message = json.error?.message ?? "";
  assert.ok(message.includes("a=status_500"), `per-task reason missing: ${message}`);
  assert.ok(message.includes("b=status_500"));
});

test("swarm: synthesize merges outputs through the judge, keeping stream + tools", async () => {
  const calls: Array<{ model: string; body: Body }> = [];
  let callIndex = 0;
  const handleSingleModel = async (b: Body, m: string) => {
    const n = callIndex++;
    calls.push({ model: m, body: b });
    // The first two calls are the workers; the third is the judge — which by
    // default IS the first task's model, so key off the call index.
    if (n < 2) return okResponse(`work-${m}`);
    return okResponse("SYNTHESIZED FINAL");
  };

  const res = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "Q" }],
      stream: true,
      tools: TOOLS,
      tool_choice: "auto",
    },
    combo: swarmCombo({
      swarm: {
        synthesize: true,
        tasks: [
          { label: "one", task: "first task", model: "openai/gpt-5.5" },
          { label: "two", task: "second task", model: "anthropic/claude-opus-4.6" },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  assert.equal(calls.length, 3, "two workers + one judge");

  // Workers: tools stripped, non-streaming, own task instruction.
  const workers = calls.slice(0, 2);
  for (const w of workers) {
    assert.ok(!("tools" in w.body));
    assert.equal(w.body.stream, false);
  }

  // Judge: the FIRST task's model by default, on the ORIGINAL body — client
  // stream flag and tools preserved, synthesis prompt appended as a user turn.
  const judge = calls[2];
  assert.equal(judge.model, "openai/gpt-5.5", "judge defaults to the first successful worker");
  assert.deepEqual(judge.body.tools, TOOLS, "judge keeps the client's tools");
  assert.equal(judge.body.stream, true, "judge keeps the client's stream flag");
  const messages = judge.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[messages.length - 1].role, "user");
  assert.ok(messages[messages.length - 1].content.includes("SYNTHESIZER"));

  const text = await res.text();
  assert.ok(text.includes("SYNTHESIZED FINAL"), "the judge's response is returned verbatim");
});

test("swarm: synthesize honors an explicit judgeModel", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`out-${m}`);
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: swarmCombo({
      swarm: {
        synthesize: true,
        judgeModel: "auto/claude-opus",
        tasks: [
          { label: "one", task: "first task", model: "openai/gpt-5.5" },
          { label: "two", task: "second task", model: "anthropic/claude-opus-4.6" },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  assert.equal(seen[seen.length - 1], "auto/claude-opus", "explicit judge runs last");
  const text = await res.text();
  assert.ok(text.includes("out-auto/claude-opus"));
});

test("swarm: tool-bearing request without synthesis bypasses the fan-out", async () => {
  const calls: Array<{ model: string; body: Body }> = [];
  const handleSingleModel = async (b: Body, m: string) => {
    calls.push({ model: m, body: b });
    return okResponse("tool answer");
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "use the tool" }], tools: TOOLS },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "one", task: "first task", model: "openai/gpt-5.5" },
          { label: "two", task: "second task", model: "anthropic/claude-opus-4.6" },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, "no fan-out for tool-bearing requests without synthesis");
  assert.equal(calls[0].model, "openai/gpt-5.5", "routed to the first task's worker");
  assert.deepEqual(calls[0].body.tools, TOOLS, "tools kept intact on the bypass");
  const text = await res.text();
  assert.ok(text.includes("tool answer"));
});

test("swarm: no tasks anywhere is a 400, not a silent pass-through", async () => {
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: swarmCombo({}),
    handleSingleModel: async () => okResponse("x"),
    log,
    settings: {},
    allCombos: [],
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error?.message ?? "", /no tasks/i);
});

test("swarm: task count above the #1905 cap is refused before fan-out", async () => {
  const tasks = Array.from({ length: SWARM_DEFAULTS.maxTasks + 1 }, (_, i) => ({
    label: `t${i}`,
    task: `task ${i}`,
    model: `p/m${i}`,
  }));
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: swarmCombo({ swarm: { tasks } }),
    handleSingleModel: async () => okResponse("x"),
    log,
    settings: {},
    allCombos: [],
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error?.message ?? "", /maxTasks/);
});

test("swarm: combo.models steps with prompts become parallel tasks", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`step-${m}`);
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: {
      name: "swarm-steps",
      strategy: "swarm",
      models: [
        { model: "openai/gpt-5.5", prompt: "Summarize the document." },
        { model: "anthropic/claude-opus-4.6", prompt: "Extract the action items." },
      ],
      config: {},
    },
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  assert.deepEqual(seen.sort(), ["anthropic/claude-opus-4.6", "openai/gpt-5.5"]);
  const json = await res.json();
  assert.ok(json.choices[0].message.content.includes("task-1"), "step labels default to task-N");
  assert.ok(json.choices[0].message.content.includes("step-openai/gpt-5.5"));
});

test("swarm: resultFormat json returns structured per-task records", async () => {
  const handleSingleModel = async (_b: Body, m: string) => okResponse(`content-${m}`);
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: swarmCombo({
      swarm: {
        resultFormat: "json",
        tasks: [{ label: "only", task: "the task", model: "p/m" }],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });
  assert.equal(res.status, 200);
  const outer = await res.json();
  const parsed = JSON.parse(outer.choices[0].message.content);
  assert.equal(parsed.object, "swarm_run");
  assert.equal(parsed.okCount, 1);
  assert.equal(parsed.results[0].label, "only");
  assert.equal(parsed.results[0].model, "p/m");
  assert.equal(parsed.results[0].content, "content-p/m");
});

test("swarm: config.swarm on a non-swarm strategy warns and routes normally", async () => {
  const warnings: string[] = [];
  const noisyLog = { ...log, warn: (scope: string, msg: string) => warnings.push(`${scope}:${msg}`) };
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse("plain");
  };

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: {
      name: "miswired",
      strategy: "priority",
      models: [{ model: "openai/gpt-5.5" }],
      config: { swarm: { tasks: [{ label: "x", task: "y", model: "p/m" }] } },
    },
    handleSingleModel,
    log: noisyLog,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200, "priority routing is unaffected");
  assert.deepEqual(seen, ["openai/gpt-5.5"], "swarm tasks must not run");
  assert.ok(
    warnings.some((w) => w.includes("config.swarm") && w.includes("miswired")),
    "operator gets a #6455-style warning"
  );
});

test("swarm: lane-full workers are skipped, others still run", async () => {
  const seen: string[] = [];
  const handleSingleModel = async (_b: Body, m: string) => {
    seen.push(m);
    return okResponse(`ok-${m}`);
  };
  const perTargetAdmission = async ({ modelStr }: { modelStr: string }) =>
    modelStr !== "busy/lane";

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Q" }] },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "free", task: "a", model: "free/lane" },
          { label: "busy", task: "b", model: "busy/lane" },
        ],
      },
    }),
    handleSingleModel,
    log,
    settings: {},
    allCombos: [],
    perTargetAdmission,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["free/lane"], "lane-full worker never dispatched");
  const json = await res.json();
  const content = json.choices[0].message.content as string;
  assert.ok(content.includes("ok-free/lane"));
  assert.ok(content.includes("no_worker_or_lane_full"));
});

// ── Schema ──────────────────────────────────────────────────────────────────

test("swarm: schema accepts an empty models list when config.swarm carries tasks", () => {
  const parsed = createComboSchema.parse({
    name: "tag-only-swarm",
    strategy: "swarm",
    models: [],
    config: {
      swarm: {
        tasks: [{ label: "a", task: "do it", fromTags: { category: "chat", minBenchmark: 85 } }],
      },
    },
  });
  assert.equal(parsed.strategy, "swarm");
});

test("swarm: schema still rejects an empty models list without swarm tasks", () => {
  assert.throws(
    () =>
      createComboSchema.parse({
        name: "empty-combo",
        strategy: "swarm",
        models: [],
        config: {},
      }),
    /at least one model/
  );
});

// ── Pure units ──────────────────────────────────────────────────────────────

test("swarm: parseSwarmTaskSpecs drops malformed entries, never throws", () => {
  assert.equal(parseSwarmTaskSpecs(undefined), null);
  assert.equal(parseSwarmTaskSpecs("nope"), null);
  assert.equal(parseSwarmTaskSpecs([]), null);
  assert.equal(parseSwarmTaskSpecs([{}]), null, "entry without a task string is dropped");
  assert.equal(parseSwarmTaskSpecs([{ task: "   " }]), null, "blank task is dropped");
  const specs = parseSwarmTaskSpecs([
    { task: "keep me", model: " p/m " },
    { task: "tags", fromTags: { category: "bogus" } },
    { task: "tags-ok", fromTags: { category: "coder", minBenchmark: 90, providers: ["a", ""] } },
    null,
    42,
  ]);
  assert.ok(specs);
  assert.equal(specs.length, 3);
  assert.equal(specs[0].model, "p/m");
  assert.equal(specs[1].fromTags, undefined, "invalid category drops fromTags");
  assert.deepEqual(specs[2].fromTags, { category: "coder", minBenchmark: 90, providers: ["a"] });
});

test("swarm: parseSwarmRunConfig requires tasks, passes through options", () => {
  assert.equal(parseSwarmRunConfig({ tasks: [] }), null);
  assert.equal(parseSwarmRunConfig({ synthesize: true }), null);
  const cfg = parseSwarmRunConfig({
    tasks: [{ task: "t" }],
    synthesize: true,
    judgeModel: " j/m ",
    defaultModel: "d/m",
    maxConcurrency: 3.7,
    resultFormat: "json",
  });
  assert.ok(cfg);
  assert.equal(cfg.synthesize, true);
  assert.equal(cfg.judgeModel, "j/m");
  assert.equal(cfg.defaultModel, "d/m");
  assert.equal(cfg.maxConcurrency, 3);
  assert.equal(cfg.resultFormat, "json");
});

test("swarm: resolveSwarmTargets — hidden explicit model falls back, unresolved reported", () => {
  const tasks = [
    { label: "hidden", task: "t1", model: "hid/den" },
    { label: "defaultable", task: "t2" },
  ];
  const resolved = resolveSwarmTargets(tasks, {
    defaultModel: "d/m",
    isVisible: (m) => !m.startsWith("hid/"),
  });
  assert.equal(resolved[0].model, "d/m", "hidden model falls through to defaultModel");
  assert.equal(resolved[0].source, "default");
  assert.equal(resolved[1].model, "d/m");

  // Without a default, a task with no model and no tags is unresolved.
  const bare = resolveSwarmTargets([{ label: "lost", task: "t" }], {
    isVisible: () => true,
  });
  assert.equal(bare[0].model, null, "no model, no tags, no default → unresolved");
  assert.equal(bare[0].source, "unresolved");
});

test("swarm: buildSwarmSynthesisPrompt labels outputs and notes failures", () => {
  const prompt = buildSwarmSynthesisPrompt([
    { label: "a", task: "t", model: "p/m", ok: true, content: "AAA" },
    { label: "b", task: "t", model: "q/n", ok: false, error: "timeout" },
  ]);
  assert.ok(prompt.includes("### a (worker: p/m)"));
  assert.ok(prompt.includes("AAA"));
  assert.ok(prompt.includes("FAILED"));
  assert.ok(prompt.includes("b (timeout)"));
  assert.ok(!prompt.includes("### b"));
});

test("swarm: maxConcurrency is clamped to a sane positive integer", () => {
  // Negative / fractional values collapse to 1 via Math.max(1, floor(n)).
  const cfg = parseSwarmRunConfig({ tasks: [{ task: "t" }], maxConcurrency: -4 });
  assert.equal(cfg?.maxConcurrency, 1);
});
