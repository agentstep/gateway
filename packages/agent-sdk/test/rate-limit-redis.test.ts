/**
 * v0.5 PR4b — pluggable rate-limit backend (memory / redis).
 *
 * Uses an in-test fake Redis client injected via the
 * `_setRedisClientForTesting` hook so we don't depend on a real Redis
 * server in CI. The fake mimics INCR/PEXPIRE semantics enough to
 * exercise the fixed-window counter, error handling, and TTL reset.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

function freshStore(): void {
  const g = globalThis as typeof globalThis & {
    __caRateLimitBuckets?: unknown;
    __caRateLimitRedis?: unknown;
  };
  g.__caRateLimitBuckets = new Map();
  g.__caRateLimitRedis = undefined;
}

interface FakeBucket { count: number; expireAt: number | null }

class FakeRedis {
  store = new Map<string, FakeBucket>();
  incrCalls = 0;
  expireCalls = 0;
  throwNextIncr = false;

  async incr(key: string): Promise<number> {
    this.incrCalls++;
    if (this.throwNextIncr) {
      this.throwNextIncr = false;
      throw new Error("simulated redis outage");
    }
    const b = this.store.get(key) ?? { count: 0, expireAt: null };
    // Simulate TTL expiry.
    if (b.expireAt != null && Date.now() >= b.expireAt) {
      b.count = 0;
      b.expireAt = null;
    }
    b.count++;
    this.store.set(key, b);
    return b.count;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.expireCalls++;
    const b = this.store.get(key);
    if (!b) return 0;
    b.expireAt = Date.now() + ms;
    return 1;
  }
}

describe("rate-limit Redis backend", () => {
  beforeEach(() => {
    freshStore();
    process.env.RATE_LIMIT_BACKEND = "redis";
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_BACKEND;
  });

  it("uses Redis when RATE_LIMIT_BACKEND=redis", async () => {
    const fake = new FakeRedis();
    const mod = await import("../src/auth/rate_limit");
    mod._setRedisClientForTesting(fake);

    // Two calls: both allowed at limit=2.
    expect(await mod.checkAndBump("key1", 2)).toBeNull();
    expect(await mod.checkAndBump("key1", 2)).toBeNull();
    // Third is refused — returns Retry-After seconds.
    const retry = await mod.checkAndBump("key1", 2);
    expect(retry).not.toBeNull();
    expect(retry).toBeGreaterThanOrEqual(1);

    // INCR hit three times, PEXPIRE only on the first (fresh-bucket set).
    expect(fake.incrCalls).toBe(3);
    expect(fake.expireCalls).toBe(1);
  });

  it("fails open to memory on Redis error — request isn't dropped", async () => {
    // The Redis path intentionally fails *open* (not closed) so that a
    // Redis outage doesn't cascade into a gateway-wide 429 storm. This
    // test confirms the fallback returns a null (allowed) decision on
    // transient error rather than throwing or returning retry-after.
    const fake = new FakeRedis();
    fake.throwNextIncr = true;
    const mod = await import("../src/auth/rate_limit");
    mod._setRedisClientForTesting(fake);

    // First call: Redis throws → memory backend takes over. Count=1 in memory.
    expect(await mod.checkAndBump("key-error", 2)).toBeNull();
    // And the warning landed on the console path (not asserted here —
    // just documenting the design intent).
    expect(fake.incrCalls).toBe(1);
  });

  it("falls back to memory when ioredis isn't installed", async () => {
    const mod = await import("../src/auth/rate_limit");
    mod._setRedisClientForTesting("unavailable");

    // Should still work via the memory path — refusal after the limit.
    expect(await mod.checkAndBump("no-redis", 1)).toBeNull();
    const retry = await mod.checkAndBump("no-redis", 1);
    expect(retry).not.toBeNull();
  });

  it("null limit is always allowed regardless of backend", async () => {
    const fake = new FakeRedis();
    const mod = await import("../src/auth/rate_limit");
    mod._setRedisClientForTesting(fake);

    for (let i = 0; i < 5; i++) {
      expect(await mod.checkAndBump("unlimited", null)).toBeNull();
    }
    // No Redis calls made — null shortcircuits before the backend lookup.
    expect(fake.incrCalls).toBe(0);
  });

  it("memory backend is default when RATE_LIMIT_BACKEND is unset", async () => {
    delete process.env.RATE_LIMIT_BACKEND;
    const fake = new FakeRedis();
    const mod = await import("../src/auth/rate_limit");
    mod._setRedisClientForTesting(fake);

    expect(await mod.checkAndBump("mem-default", 1)).toBeNull();
    const retry = await mod.checkAndBump("mem-default", 1);
    expect(retry).not.toBeNull();
    // Never touched Redis.
    expect(fake.incrCalls).toBe(0);
  });
});
