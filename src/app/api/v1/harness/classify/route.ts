import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { classifyRequest } from "@omniroute/open-sse/services/harness/classifier.ts";
import { selfFetchChat } from "@/lib/harness/selfFetch";
import { makeSelfFetchEmbedder } from "@/lib/harness/embedder";

/**
 * POST /api/v1/harness/classify — the task classifier, standalone (Layer 3,
 * B1). Inspect a chat-shaped request and return what KIND of work it is
 * (code / research / math / vision / search / chat), how heavy (fast / deep),
 * detected modalities, and the capability alias the harness would route it
 * to — WITHOUT executing anything.
 *
 * Stage 1 (free heuristics) always runs. When the verdict is
 * low-confidence, the refinement ladder runs cheapest-first:
 *
 *   - Stage 1.5 (B14, default ON): one /v1/embeddings call (via the full
 *     native pipeline) — the text is matched against per-type exemplar
 *     centroids. Disable with { "useEmbeddings": false }; pin a model with
 *     { "embeddingModel": "provider/model" } (the catalog default is used
 *     otherwise — no model naming required).
 *   - Stage 2 (opt-in): with { "useModel": true } a cheap classifier model
 *     re-reads the request.
 *
 * Every stage failure degrades downward, never to an error.
 *
 * Body: a chat-shaped request (messages/prompt/input — the same shape
 * /v1/chat/completions accepts) plus optional { useEmbeddings?,
 * embeddingModel?, useModel?, classifierModel? }.
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
  const hasConversation =
    Array.isArray(body.messages) ||
    typeof body.prompt === "string" ||
    typeof body.input === "string" ||
    Array.isArray(body.input);
  if (!hasConversation) {
    return NextResponse.json(
      { error: { message: "Body needs messages (or prompt/input) to classify" } },
      { status: 400 }
    );
  }

  const classification = await classifyRequest(body, {
    embed:
      body.useEmbeddings === false
        ? undefined
        : makeSelfFetchEmbedder({
            incoming: request,
            model:
              typeof body.embeddingModel === "string" && body.embeddingModel.trim()
                ? body.embeddingModel.trim()
                : undefined,
          }),
    dispatch:
      body.useModel === true
        ? (chatBody, model) => selfFetchChat({ incoming: request, body: { ...chatBody, model } })
        : undefined,
    classifierModel:
      typeof body.classifierModel === "string" && body.classifierModel.trim()
        ? body.classifierModel.trim()
        : undefined,
  });

  return NextResponse.json({
    object: "task_classification",
    classification,
  });
}
