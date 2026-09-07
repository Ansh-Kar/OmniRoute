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
