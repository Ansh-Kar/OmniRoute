/**
 * Harness B4 (Layer 2 — hermes abstraction + NIM hardening) — tests for:
 *
 *   1. nimRateLimitTracker: sliding 60s request windows, Retry-After-derived
 *      cooldowns (with sane caps), learned RPM ceilings, and saturation
 *      detection — the in-memory layer behind the nvidia 429 key-rotation
 *      failover in chatCore.
 *   2. hermesCombos: the `hermes/*` reserved namespace (Guide 2 hermes plugin
 *      mapped onto capability aliases) — registry shape, membership,
 *      resolution, tier contract (hermes/fast → chat:cheap,
 *      hermes/smart → chat:best), and the reserved "hermes" provider prefix.
 *   3. /harness/task ?tier=auto: complexity picks the budget
 *      (fast → cheap, deep → best); default behavior unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-harness-b4-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "harness-b4-test-secret";

const {
  recordNimRequest,
  recordNim429,
  nimWindowCount,
  nimObservedCeiling,
  nimCooldownRemainingMs,
  isNimConnectionSaturated,
  resetNimRateLimitTracker,
} = await import("../../../open-sse/services/nimRateLimitTracker.ts");
const { HERMES_COMBOS, isHermesComboName, buildHermesCombo } = await import(
  "../../../open-sse/services/harness/hermesCombos.ts"
);
const {
  buildCapabilityAliasCombo,
  CAPABILITY_ALIAS_BEST_SIZE,
  CAPABILITY_ALIASES,
} = await import("../../../open-sse/services/harness/capabilityAliases.ts");
const { isReservedProviderPrefix } = await import(
  "../../../src/shared/constants/reservedProviderPrefixes.ts"
);

// ── NIM sliding-window tracker ──────────────────────────────────────────────

test("nim: window counts requests per connection, isolated across keys", () => {
  resetNimRateLimitTracker();
  recordNimRequest("key1");
  recordNimRequest("key1");
  recordNimRequest("key1");
  recordNimRequest("key2");
  assert.equal(nimWindowCount("key1"), 3);
  assert.equal(nimWindowCount("key2"), 1);
  assert.equal(nimWindowCount("unknown"), 0);
  recordNimRequest(""); // no-op on empty id
  assert.equal(nimWindowCount(""), 0);
});

test("nim: 429 with Retry-After honors the header and learns the ceiling", () => {
  resetNimRateLimitTracker();
  recordNimRequest("key1");
  recordNimRequest("key1");
  recordNimRequest("key1");
  const cooldown = recordNim429("key1", 5000);
  assert.equal(cooldown, 5000, "Retry-After is authoritative when sane");
  const remaining = nimCooldownRemainingMs("key1");
  assert.ok(remaining > 4000 && remaining <= 5000, `remaining in (4000, 5000], got ${remaining}`);
  assert.equal(nimObservedCeiling("key1"), 3, "window size at 429 time is the learned ceiling");
  assert.equal(isNimConnectionSaturated("key1"), true, "cooldown active → saturated");
});

test("nim: 429 without Retry-After falls back to a window-derived cooldown", () => {
  resetNimRateLimitTracker();
  recordNimRequest("key1");
  recordNimRequest("key1");
  const cooldown = recordNim429("key1", null);
  // Fresh window: oldest entry ages out in ~60s → estimate 60s.
  assert.equal(cooldown, 60_000);
  assert.ok(nimCooldownRemainingMs("key1") > 59_000);
  assert.equal(nimObservedCeiling("key1"), 2);
});

test("nim: 429 on an empty window uses the default cooldown and learns nothing", () => {
  resetNimRateLimitTracker();
  const cooldown = recordNim429("cold-key", null);
  assert.equal(cooldown, 20_000, "DEFAULT_429_COOLDOWN_MS when the window is empty");
  assert.ok(nimCooldownRemainingMs("cold-key") > 19_000);
  assert.equal(nimObservedCeiling("cold-key"), null, "no window → no ceiling learned");
});

test("nim: absurd Retry-After is capped, never trusted verbatim", () => {
  resetNimRateLimitTracker();
  recordNimRequest("key1");
  const cooldown = recordNim429("key1", 3_600_000); // one hour
  assert.equal(cooldown, 300_000, "capped at MAX_429_COOLDOWN_MS (5 min)");
  // Negative / zero / NaN retry-after values are treated as absent.
  resetNimRateLimitTracker();
  recordNimRequest("key2");
  const fallback = recordNim429("key2", -5);
  assert.equal(fallback, 60_000, "negative Retry-After → window-derived fallback");
});

test("nim: unsaturated connection with no 429 history is not saturated", () => {
  resetNimRateLimitTracker();
  recordNimRequest("key1");
  recordNimRequest("key1");
  assert.equal(isNimConnectionSaturated("key1"), false, "no ceiling learned yet");
  assert.equal(isNimConnectionSaturated(""), false);
});

test("nim: cooldown decays to zero", async () => {
  resetNimRateLimitTracker();
  recordNim429("key1", 400);
  assert.ok(nimCooldownRemainingMs("key1") > 0);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(nimCooldownRemainingMs("key1"), 0, "cooldown expires");
});

test("nim: reset clears windows, cooldowns, and ceilings", () => {
  resetNimRateLimitTracker();
  recordNimRequest("key1");
  recordNim429("key1", 5000);
  resetNimRateLimitTracker();
  assert.equal(nimWindowCount("key1"), 0);
  assert.equal(nimCooldownRemainingMs("key1"), 0);
  assert.equal(nimObservedCeiling("key1"), null);
});

// ── Hermes combos (Guide 2 plugin mapped onto aliases) ──────────────────────

test("hermes: registry targets are all valid capability aliases", () => {
  for (const [name, entry] of Object.entries(HERMES_COMBOS)) {
    assert.ok(name.startsWith("hermes/"), `${name} is namespaced`);
    const base = entry.target.split(":")[0];
    assert.ok(
      Object.prototype.hasOwnProperty.call(CAPABILITY_ALIASES, base),
      `${name} target ${entry.target} resolves to a capability alias`
    );
  }
});

test("hermes: tier contract — fast→cheap, smart→best", () => {
  assert.equal(HERMES_COMBOS["hermes/fast"].target, "chat:cheap");
  assert.equal(HERMES_COMBOS["hermes/smart"].target, "chat:best");
  assert.equal(HERMES_COMBOS["hermes/code-best"].target, "code:best");
  assert.equal(HERMES_COMBOS["hermes/reason"].target, "reasoning:best");
});

test("hermes: membership is exact-match only", () => {
  assert.equal(isHermesComboName("hermes/fast"), true);
  assert.equal(isHermesComboName("hermes/smart"), true);
  assert.equal(isHermesComboName("hermes/nope"), false);
  assert.equal(isHermesComboName("hermes/"), false);
  assert.equal(isHermesComboName("HERMES/FAST"), false);
  assert.equal(isHermesComboName(42), false);
  assert.equal(isHermesComboName(null), false);
  assert.equal(isHermesComboName("hermes/fast:best"), false, "no budget suffix on hermes names");
});

test("hermes: buildHermesCombo resolves through the underlying alias", () => {
  const combo = buildHermesCombo("hermes/code");
  assert.ok(combo, "hermes/code resolves");
  assert.equal(combo.name, "hermes/code", "combo is rebranded under the hermes name");
  assert.equal(combo.strategy, "priority");
  assert.equal(combo._capabilityAlias, true);
  assert.ok(combo.models.length >= 1);
  assert.match(combo.description, /hermes combo/);
  const direct = buildCapabilityAliasCombo("code");
  assert.ok(direct);
  assert.deepEqual(
    combo.models,
    direct.models,
    "hermes/code carries exactly the code alias candidates"
  );
});

test("hermes: hermes/smart caps at the best-tier size", () => {
  const combo = buildHermesCombo("hermes/smart");
  assert.ok(combo, "hermes/smart resolves");
  assert.ok(
    combo.models.length <= CAPABILITY_ALIAS_BEST_SIZE,
    `best tier caps at ${CAPABILITY_ALIAS_BEST_SIZE}, got ${combo.models.length}`
  );
});

test("hermes: unknown names return null (fall through, never mis-route)", () => {
  assert.equal(buildHermesCombo("hermes/unknown"), null);
  assert.equal(buildHermesCombo("code"), null, "bare aliases are not hermes combos");
  assert.equal(buildHermesCombo(""), null);
});

test("hermes: the prefix is reserved — no custom provider node can shadow it", () => {
  assert.equal(isReservedProviderPrefix("hermes"), true);
});

// ── /harness/task ?tier=auto (complexity → budget) ──────────────────────────

async function postTask(query: string, content: string): Promise<Record<string, unknown>> {
  const { POST } = await import("../../../src/app/api/v1/harness/task/route.ts");
  const response = await POST(
    new Request(`http://localhost/api/v1/harness/task${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content }] }),
    })
  );
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

test("tier=auto: deep complexity picks the best budget", async () => {
  const body = await postTask(
    "?classify_only=true&tier=auto",
    "Please write a comprehensive in-depth analysis of distributed consensus, step by step."
  );
  assert.equal(body.object, "harness_task_decision");
  const classification = body.classification as { complexity?: string };
  assert.equal(classification.complexity, "deep", "DEEP_MARKERS classify as deep");
  assert.equal(body.budget, "best");
});

test("tier=auto: fast complexity picks the cheap budget", async () => {
  const body = await postTask("?classify_only=true&tier=auto", "hi");
  const classification = body.classification as { complexity?: string };
  assert.equal(classification.complexity, "fast");
  assert.equal(body.budget, "cheap");
});

test("default (no tier param): no budget field, B1 behavior unchanged", async () => {
  const body = await postTask(
    "?classify_only=true",
    "Please write a comprehensive in-depth analysis, step by step."
  );
  assert.equal(body.budget, undefined, "budget only appears with ?tier=auto");
  assert.ok(body.alias, "alias still routed");
});

test("tier=auto with forced alias: complexity defaults to fast → cheap", async () => {
  const body = await postTask(
    "?classify_only=true&tier=auto&alias=code",
    "irrelevant — classification is skipped"
  );
  const classification = body.classification as { reason?: string };
  assert.match(classification.reason, /forced/);
  assert.equal(body.budget, "cheap", "no classification → fast default → cheap");
  assert.equal(body.alias, "code");
});
