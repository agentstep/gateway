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
import { authenticate } from "./auth/middleware";
import { isPassthroughAllowedPath } from "./auth/passthrough";
import { forwardToAnthropic } from "./proxy/forward";
import { toResponse, ApiError, tooManyRequests, unauthorized } from "./errors";
import { captureException } from "./sentry";
import { recordApiRequest, normalizeRoute } from "./observability/api-metrics";
import { checkAndBump } from "./auth/rate_limit";
import type { AuthContext } from "./types";

export interface RouteContext {
  auth: AuthContext;
  request: Request;
}

export async function routeWrap(
  request: Request,
  handler: (ctx: RouteContext) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  let status = 500;
  try {
    await ensureInitialized();
    const auth = await authenticate(request);

    // Passthrough: forward `sk-ant-api*` requests to Anthropic with no
    // gateway-side state. Allowlist the path here so gateway-only routes
    // (api-keys, settings, tenants, ...) reject passthrough — otherwise
    // an Anthropic-key holder could enumerate gateway state. The handler
    // closure never runs for passthrough requests.
    if (auth.mode === "passthrough") {
      const url = new URL(request.url);
      if (!isPassthroughAllowedPath(url.pathname)) {
        throw unauthorized();
      }
      const res = await forwardToAnthropic(request, url.pathname, {
        apiKey: auth.passthroughKey,
      });
      status = res.status;
      return res;
    }

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
