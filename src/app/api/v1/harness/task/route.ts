import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { classifyRequest } from "@omniroute/open-sse/services/harness/classifier.ts";
import { selfFetchChat } from "@/lib/harness/selfFetch";

/**
 * POST /api/v1/harness/task — classify + route + execute, one call (Layer 3,
 * B1). The "Gemini allocator" as a single endpoint for agents that don't want
 * to pick models at all:
 *
 *   { "messages": [...], "tools": [...] }        → classified, routed, executed
 *   { "model": "auto", "messages": [...] }        → same; model field ignored
 *   ?alias=code                                   → forced route, no classification
 *   ?classify_only=true                           → decision only, no execution
 *   ?tier=auto                                    → complexity picks the budget:
 *                                                  fast → alias:cheap, deep → alias:best
 *
 * Routing rewrites the request's model to the classification's capability
 * alias (a reserved name that resolves — through getComboForModel — to an
 * ephemeral priority combo over the tag index's current best specialists,
 * with native failover/admission/breakers), then executes on this server's
 * own /v1/chat/completions with the caller's credentials forwarded. The
 * upstream response — including streaming — is passed through verbatim.
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request: Request) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      { error: { message: "Body must be a chat-shaped request object" } },
      { status: 400 }
    );
  }

  const body = raw as Record<string, unknown>;
  const { searchParams } = new URL(request.url);
  const classifyOnly = searchParams.get("classify_only") === "true";
  const forcedAlias = searchParams.get("alias");
  // B4 complexity tiers (Guide 2 fast-free/deep→best): with ?tier=auto the
  // classification's complexity picks the budget — fast → cheap (flash/mini
  // tier), deep → best (top axis-ranked specialists) — by suffixing the
  // alias. Default (no param) keeps B1's bare-alias behavior.
  const tierAuto = searchParams.get("tier") === "auto";

  // Harness control fields never leak into the chat request.
  const { useModel: _um, classifierModel: _cm, ...chatBody } = body;
  void _um;
  void _cm;

  const classification =
    forcedAlias && forcedAlias.trim()
      ? null
      : await classifyRequest(body, {
          // Stage 2 is not worth a call here — the verdict is immediately
          // exercised, and a wrong-but-sane route fails over natively.
        });

  const alias = forcedAlias?.trim() || classification?.alias || "chat";
  const budget = tierAuto
    ? (classification?.complexity ?? "fast") === "deep"
      ? ("best" as const)
      : ("cheap" as const)
    : null;
  if (classifyOnly) {
    return NextResponse.json({
      object: "harness_task_decision",
      classification: classification ?? { alias, reason: "forced via ?alias=" },
      alias,
      ...(budget ? { budget } : {}),
    });
  }

  const executed = await selfFetchChat({
    incoming: request,
    body: { ...chatBody, model: budget ? `${alias}:${budget}` : alias },
  });

  // Attach the routing decision as a response header (unless the client
  // opted out) — observability without touching the body.
  const headers = new Headers(executed.headers);
  try {
    headers.set("X-Harness-Tier", classification ? classification.complexity : "forced");
    headers.set("X-Harness-Route", alias);
    if (budget) headers.set("X-Harness-Budget", budget);
  } catch {
    // Unencodable value — skip the observability headers.
  }
  return new Response(executed.body, { status: executed.status, headers });
}
