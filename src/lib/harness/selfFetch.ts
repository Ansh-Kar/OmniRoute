/**
 * Harness self-fetch (B1) — the harness API routes execute chat work by
 * calling OmniRoute's own /v1/chat/completions with the caller's credentials
 * forwarded. This is the same pattern the MCP server uses
 * (omniRouteFetch → own HTTP API): the request goes through the FULL native
 * pipeline — admission, alias/combo resolution, failover, translation,
 * streaming — with zero duplication of handler logic.
 */

export type SelfFetchChatOptions = {
  /** The incoming harness request — its auth headers are forwarded. */
  incoming: Request;
  /** Chat body (model already rewritten to the chosen alias/model). */
  body: Record<string, unknown>;
  /** Extra time budget for the upstream call. Default 300s (SSE-friendly). */
  timeoutMs?: number;
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

/**
 * POST a chat body to this server's /v1/chat/completions, forwarding the
 * caller's auth. Returns the upstream Response with sanitized headers —
 * including streaming bodies (the ReadableStream passes through untouched).
 */
export async function selfFetchChat({
  incoming,
  body,
  timeoutMs = 300_000,
}: SelfFetchChatOptions): Promise<Response> {
  const origin = new URL(incoming.url).origin;
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of FORWARDED_AUTH_HEADERS) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(new URL("/api/v1/chat/completions", origin), {
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
