/**
 * Harness self-fetch (B1/B2) — the harness API routes execute chat and image
 * work by calling OmniRoute's own HTTP API with the caller's credentials
 * forwarded. Same pattern the MCP server uses (omniRouteFetch → own HTTP
 * API): the request goes through the FULL native pipeline — admission,
 * alias/combo resolution, failover, translation, streaming, idempotency
 * replay — with zero duplication of handler logic.
 */

export type SelfFetchChatOptions = {
  /** The incoming harness request — its auth headers are forwarded. */
  incoming: Request;
  /** Chat body (model already rewritten to the chosen alias/model). */
  body: Record<string, unknown>;
  /** Extra time budget for the upstream call. Default 300s (SSE-friendly). */
  timeoutMs?: number;
  /**
   * Additional headers to forward (e.g. Idempotency-Key — the chat
   * pipeline's native replay then applies to the harness call too).
   */
  extraHeaders?: Record<string, string>;
};

const FORWARDED_AUTH_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
] as const;

/** Hop-by-hop / framing headers never forwarded from the upstream response. */
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding", // undici re-decodes; forwarding the header corrupts the body
  "content-length",
]);

async function selfFetchJson(
  path: string,
  incoming: Request,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> | undefined,
  timeoutMs: number
): Promise<Response> {
  const origin = new URL(incoming.url).origin;
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of FORWARDED_AUTH_HEADERS) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(new URL(path, origin), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

/**
 * POST a chat body to this server's /v1/chat/completions, forwarding the
 * caller's auth. Returns the upstream Response with sanitized headers —
 * including streaming bodies (the ReadableStream passes through untouched).
 */
export async function selfFetchChat({
  incoming,
  body,
  timeoutMs = 300_000,
  extraHeaders,
}: SelfFetchChatOptions): Promise<Response> {
  return selfFetchJson("/api/v1/chat/completions", incoming, body, extraHeaders, timeoutMs);
}

/**
 * POST an images-generations body to this server's own images API (B2
 * /quick's image_gen path). Same credential-forwarding contract.
 */
export async function selfFetchImages({
  incoming,
  body,
  timeoutMs = 300_000,
  extraHeaders,
}: Omit<SelfFetchChatOptions, "body"> & { body: Record<string, unknown> }): Promise<Response> {
  return selfFetchJson("/api/v1/images/generations", incoming, body, extraHeaders, timeoutMs);
}

/**
 * B7 multimodal self-fetches — the orchestrator's media task dispatches.
 * All share the credential-forwarding contract (the incoming request's
 * auth rides the internal fetch, so admission/budget policies apply).
 */

/** GET a model-list JSON from this server's own API with the caller's auth
 *  forwarded (B14: the embedder's default-model resolution reads
 *  GET /v1/embeddings this way — the catalog logic stays in its route). */
export async function selfFetchList(
  path: string,
  incoming: Request,
  timeoutMs = 2_500
): Promise<Response> {
  const origin = new URL(incoming.url).origin;
  const headers = new Headers();
  for (const name of FORWARDED_AUTH_HEADERS) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(new URL(path, origin), { headers, signal: AbortSignal.timeout(timeoutMs) });
  return upstream;
}

/** POST /v1/embeddings — B14: the classifier's embedding source. The call
 *  rides the FULL native pipeline (provider selection, failover, keys),
 *  with the caller's auth forwarded. Short default timeout: classification
 *  is a refinement and must never stall the request. */
export async function selfFetchEmbeddings({
  incoming,
  body,
  timeoutMs = 2_500,
  extraHeaders,
}: Omit<SelfFetchChatOptions, "body"> & { body: Record<string, unknown> }): Promise<Response> {
  return selfFetchJson("/api/v1/embeddings", incoming, body, extraHeaders, timeoutMs);
}

/** POST /v1/search — literal web search (no model; provider selected by the route). */
export async function selfFetchSearch({
  incoming,
  body,
  timeoutMs = 120_000,
  extraHeaders,
}: Omit<SelfFetchChatOptions, "body"> & { body: Record<string, unknown> }): Promise<Response> {
  return selfFetchJson("/api/v1/search", incoming, body, extraHeaders, timeoutMs);
}

/** POST /v1/audio/speech — text-to-speech; the response is audio bytes, not JSON. */
export async function selfFetchSpeech({
  incoming,
  body,
  timeoutMs = 300_000,
  extraHeaders,
}: Omit<SelfFetchChatOptions, "body"> & { body: Record<string, unknown> }): Promise<Response> {
  return selfFetchJson("/api/v1/audio/speech", incoming, body, extraHeaders, timeoutMs);
}

/** POST /v1/music/generations — music generation. */
export async function selfFetchMusic({
  incoming,
  body,
  timeoutMs = 600_000,
  extraHeaders,
}: Omit<SelfFetchChatOptions, "body"> & { body: Record<string, unknown> }): Promise<Response> {
  return selfFetchJson("/api/v1/music/generations", incoming, body, extraHeaders, timeoutMs);
}

/** POST /v1/videos/generations — video generation. */
export async function selfFetchVideos({
  incoming,
  body,
  timeoutMs = 600_000,
  extraHeaders,
}: Omit<SelfFetchChatOptions, "body"> & { body: Record<string, unknown> }): Promise<Response> {
  return selfFetchJson("/api/v1/videos/generations", incoming, body, extraHeaders, timeoutMs);
}
