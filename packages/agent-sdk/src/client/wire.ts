/**
 * Wire helpers shared by both transports: query-string building, JSON
 * response parsing with error envelope unwrapping, and SSE body parsing.
 */
import type { GatewayEvent } from "../events/registry";
import { ApiClientError } from "./types";

/** Build a query string ("" or "?k=v&..."), skipping undefined values. */
export function buildQuery(
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/**
 * Parse a handler/fetch Response: unwrap the error envelope into a
 * `ApiClientError` on non-2xx, return undefined on 204, JSON otherwise.
 */
export async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw await toApiError(res);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function toApiError(res: Response): Promise<ApiClientError> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } };
    if (parsed?.error?.message) {
      return new ApiClientError(parsed.error.message, res.status, parsed.error.type ?? "api_error");
    }
  } catch {
    /* not a JSON envelope — fall through */
  }
  return new ApiClientError(text || `HTTP ${res.status}`, res.status);
}

/**
 * Parse an SSE Response body into GatewayEvents. Handles multi-line `data:`
 * fields, filters `ping` keepalives, and cancels the reader when the
 * consumer stops iterating.
 */
export async function* parseSseResponse(res: Response): AsyncGenerator<GatewayEvent, void, unknown> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentData = "";

  const flush = (): GatewayEvent | null => {
    if (!currentData) return null;
    const data = currentData;
    currentData = "";
    try {
      const parsed = JSON.parse(data) as GatewayEvent;
      if ((parsed as { type?: string }).type !== "ping") return parsed;
    } catch {
      /* skip malformed frame */
    }
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep the incomplete trailing line

      for (const line of lines) {
        if (line === "") {
          // Event boundary
          const evt = flush();
          if (evt) yield evt;
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).replace(/^ /, "");
          currentData = currentData ? `${currentData}\n${chunk}` : chunk;
        }
        // ignore id:/event: lines — the payload carries type and seq
      }
    }
    // Flush any trailing frame after the stream ends
    const evt = flush();
    if (evt) yield evt;
  } finally {
    reader.cancel().catch(() => {});
  }
}
