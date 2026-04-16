/**
 * In-memory fixed-window rate limiter, keyed by API key id.
 *
 * v0.4: single-process only. Documented as such. When a gateway is
 * clustered (multiple `gateway serve` workers behind a proxy), each
 * process tracks its own window — the effective limit per key is
 * `limit × workers`. Acceptable for the "stop runaway scripts" use case
 * that virtual keys target. For actual fairness across a cluster, swap
 * to a Redis backend via the `RATE_LIMIT_BACKEND` env var.
 *
 * Fixed window (not sliding or token bucket) — over-allows at boundaries
 * by up to 2×, but is trivial to reason about and removes the need for
 * sample buffers. Good enough for ops-level limits.
 */

interface Bucket {
  /** First ms of the current window. */
  windowStart: number;
  /** Count of requests observed in the current window. */
  count: number;
}

/** HMR-safe singleton on globalThis so dev server reloads don't lose counters. */
type GlobalBucketStore = typeof globalThis & {
  __caRateLimitBuckets?: Map<string, Bucket>;
};
const g = globalThis as GlobalBucketStore;
if (!g.__caRateLimitBuckets) g.__caRateLimitBuckets = new Map();
const buckets = g.__caRateLimitBuckets;

const WINDOW_MS = 60_000;

/**
 * Check-and-bump: returns `null` if the request is allowed, or a
 * non-negative integer (seconds until the next window starts) if
 * refused.
 *
 * `limitPerMinute === null` → unlimited (always returns null).
 */
export function checkAndBump(keyId: string, limitPerMinute: number | null): number | null {
  if (limitPerMinute == null || limitPerMinute <= 0) return null;
  const now = Date.now();
  let b = buckets.get(keyId);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    // New window
    b = { windowStart: now, count: 1 };
    buckets.set(keyId, b);
    return null;
  }
  if (b.count >= limitPerMinute) {
    const retryAfterMs = WINDOW_MS - (now - b.windowStart);
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
  b.count++;
  return null;
}

/** Test hook: clear all counters. No-op in production code paths. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Test hook: inspect the counter for a key (or undefined if no window active). */
export function peekRateLimit(keyId: string): Bucket | undefined {
  return buckets.get(keyId);
}
