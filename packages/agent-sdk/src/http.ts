/**
 * Route helpers: common boilerplate for every /v1 handler.
 *
 * - `ensureInitialized()` runs on first request
 * - `authenticate(request)` extracts + validates the API key
 * - wraps errors into the Managed Agents envelope
 * - records request latency + status into the in-process API metrics
 *   recorder for the dashboard's `/v1/metrics/api` endpoint
 *
 * Framework-agnostic — uses Web Standard Response only.
 */
import { ensureInitialized } from "./init";
import { authenticateAndIntercept } from "./auth/middleware";
import { toResponse, ApiError, tooManyRequests } from "./errors";
import { captureException } from "./sentry";
import { recordApiRequest, normalizeRoute } from "./observability/api-metrics";
import { checkAndBump } from "./auth/rate_limit";
import type { AuthContext } from "./types";

export interface RouteContext {
  auth: AuthContext;
  request: Request;
}

function maxRequestBodyBytes(): number {
  const env = process.env.GATEWAY_MAX_BODY_BYTES;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 64 * 1024 * 1024; // 64MB
}

export async function routeWrap(
  request: Request,
  handler: (ctx: RouteContext) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  let status = 500;
  try {
    // Reject oversized request bodies up front (before reading them into
    // memory). Default 64MB — comfortably above the 50MB file-upload cap
    // plus multipart overhead; override with GATEWAY_MAX_BODY_BYTES.
    const declaredLen = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > maxRequestBodyBytes()) {
      status = 413;
      return toResponse(
        new ApiError(413, "invalid_request_error", "request body too large"),
      );
    }

    await ensureInitialized();
    // `authenticateAndIntercept` returns a terminal Response for any
    // passthrough request — the handler closure never runs. Gateway-mode
    // requests fall through with a normal AuthContext.
    const result = await authenticateAndIntercept(request);
    if (result.kind === "response") {
      status = result.response.status;
      return result.response;
    }
    const auth = result.auth;

    // Per-key RPM rate limit. Fixed 60s window; backend is memory by
    // default, Redis when RATE_LIMIT_BACKEND=redis. null rateLimitRpm
    // short-circuits the check. On refusal we return 429 with a
    // Retry-After header (seconds).
    const retryAfter = await checkAndBump(auth.keyId, auth.rateLimitRpm);
    if (retryAfter != null) {
      const err = tooManyRequests(
        `rate limit exceeded (${auth.rateLimitRpm}/min for this key); retry after ${retryAfter}s`,
      );
      const res = toResponse(err);
      // Augment the response with Retry-After so well-behaved clients can
      // back off automatically. toResponse returns an immutable Response
      // so we copy it.
      const headers = new Headers(res.headers);
      headers.set("Retry-After", String(retryAfter));
      status = 429;
      return new Response(res.body, { status: 429, headers });
    }

    const res = await handler({ auth, request });
    status = res.status;
    return res;
  } catch (err) {
    // Report unexpected errors to Sentry (skip expected API errors like 400/404)
    if (!(err instanceof ApiError) || err.status >= 500) {
      captureException(err);
    }
    const res = toResponse(err);
    status = res.status;
    return res;
  } finally {
    // Record the request into the in-process API metrics recorder.
    // Must never throw — the metrics path is best-effort.
    try {
      const route = normalizeRoute(request.url);
      recordApiRequest(route, Date.now() - startedAt, status);
    } catch {
      /* best-effort */
    }
  }
}

export function jsonOk<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Parse a client-supplied `?limit=` into a sane integer.
 *
 * Coerces missing/NaN values to `fallback` and clamps to `[1, max]` so a
 * caller can't request the whole table in one response (`?limit=99999999`)
 * or poison the SQL `LIMIT` with `NaN`.
 */
export function parseLimit(
  raw: string | null | undefined,
  fallback = 100,
  max = 500,
): number {
  // Note: Number(null) and Number("") are both 0 (finite), so an absent or
  // blank param must short-circuit to the fallback before the numeric clamp.
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

/** Build a paginated list response matching Anthropic's shape. */
export function paginatedOk<T extends { id: string }>(
  data: T[],
  requestedLimit: number,
): Response {
  const hasMore = data.length === requestedLimit;
  const firstId = data.length > 0 ? data[0].id : null;
  const lastId = data.length > 0 ? data[data.length - 1].id : null;
  return jsonOk({ data, has_more: hasMore, first_id: firstId, last_id: lastId });
}

/**
 * Decode a pagination cursor. Accepts either:
 * - A raw ID string (Anthropic-style after_id)
 * - A base64url-encoded ID (legacy next_page cursor)
 */
export function decodeCursor(
  page: string | null | undefined,
): string | undefined {
  if (!page) return undefined;
  // If it looks like one of our ID prefixes, it's a raw ID (Anthropic style)
  if (page.includes("_")) return page;
  try {
    return Buffer.from(page, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}
