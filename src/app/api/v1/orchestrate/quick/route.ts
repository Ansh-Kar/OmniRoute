import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { orchestrateQuick, type QuickBody, type QuickDispatchResult } from "@omniroute/open-sse/services/harness/quick.ts";
import { selfFetchChat, selfFetchImages } from "@/lib/harness/selfFetch";

/**
 * POST /api/v1/orchestrate/quick — single delegated task, synchronous
 * (harness B2, Guide 1 Part 6). The brain (Guide 2) names a capability TAG —
 * `vision · image_gen · code · research · plan · chat` — never a model.
 *
 *   {"tag": "vision", "prompt": "describe this image", "images": ["..."],
 *    "policy": {"budget": "any"}}
 *   → {"ok": true, "model": "…", "provider": "…", "text": "…",
 *      "latency_ms": 812, "score": 0.91, "decision": {…}}
 *   → 503 {"ok": false, "error": "no_active_models", "tag": "vision"}
 *
 * Execution always goes through the native pipeline via self-fetch
 * (alias → priority combo failover, admission, breakers). The caller's
 * Idempotency-Key header is forwarded so the chat pipeline's NATIVE replay
 * semantics apply to quick calls unchanged (Guide 1 Part 6).
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
    return NextResponse.json(
      { ok: false, error: "invalid_request", details: ["Invalid JSON body"] },
      { status: 400 }
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", details: ["Body must be an object"] },
      { status: 400 }
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
  const toDispatchResult = async (response: Response): Promise<QuickDispatchResult> => {
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers) headers[name.toLowerCase()] = value;
    return { status: response.status, headers, json };
  };

  const result = await orchestrateQuick(raw as QuickBody, {
    dispatchChat: async (body) =>
      toDispatchResult(
        await selfFetchChat({ incoming: request, body, extraHeaders: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined })
      ),
    dispatchImages: async (body) =>
      toDispatchResult(
        await selfFetchImages({ incoming: request, body, extraHeaders: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined })
      ),
  });

  return NextResponse.json(result.payload, { status: result.status });
}
