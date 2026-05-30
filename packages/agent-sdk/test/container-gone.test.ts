/**
 * Tests for `ContainerGone` translation.
 *
 * sprites.dev returns 404 "sprite not found" when the upstream container has
 * been reaped (idle TTL, manual delete, host restart). The gateway used to
 * surface that as a generic 502, which forced clients to retry blindly. We
 * now throw a typed `ContainerGone` so the driver can drop the stale pool
 * entry and re-acquire transparently — see sessions/driver.ts catch block.
 *
 * Codifies the contract:
 *   - httpExec (HTTP POST exec) translates 404 → ContainerGone
 *   - startExec (streaming HTTP POST exec) translates 404 → ContainerGone
 *   - non-404 errors still surface as ApiError(502)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ContainerGone } from "../src/providers/types";

const origFetch = globalThis.fetch;

function mockFetch(response: { status: number; body?: string }): typeof globalThis.fetch {
  return vi.fn(async () =>
    new Response(response.body ?? "", { status: response.status, headers: { "content-type": "application/json" } })
  ) as unknown as typeof globalThis.fetch;
}

describe("ContainerGone translation", () => {
  beforeEach(() => {
    process.env.SPRITE_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    // Reset config cache between tests so SPRITE_TOKEN change takes effect
    const g = globalThis as typeof globalThis & { __caConfigCache?: unknown };
    delete g.__caConfigCache;
  });

  it("httpExec: 404 with sprite-not-found body throws ContainerGone (not ApiError)", async () => {
    globalThis.fetch = mockFetch({ status: 404, body: '{"error":"sprite not found"}' });
    const { httpExec } = await import("../src/containers/client");
    let caught: unknown;
    try {
      await httpExec("sandbox_xyz", ["echo", "hi"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContainerGone);
    expect((caught as ContainerGone).sandboxName).toBe("sandbox_xyz");
  });

  it("httpExec: 502 still throws ApiError (not ContainerGone)", async () => {
    globalThis.fetch = mockFetch({ status: 502, body: "upstream down" });
    const { httpExec } = await import("../src/containers/client");
    let caught: unknown;
    try {
      await httpExec("sandbox_xyz", ["echo", "hi"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(ContainerGone);
    expect(String((caught as Error).message)).toContain("502");
  });

  it("startExec: 404 throws ContainerGone with the sandbox name", async () => {
    globalThis.fetch = mockFetch({ status: 404, body: '{"error":"sprite not found"}' });
    const { startExec } = await import("../src/containers/exec");
    let caught: unknown;
    try {
      await startExec("sandbox_abc", { argv: ["echo", "hi"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContainerGone);
    expect((caught as ContainerGone).sandboxName).toBe("sandbox_abc");
  });

  it("startExec: 500 still throws ApiError", async () => {
    globalThis.fetch = mockFetch({ status: 500, body: "internal" });
    const { startExec } = await import("../src/containers/exec");
    let caught: unknown;
    try {
      await startExec("sandbox_abc", { argv: ["echo", "hi"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(ContainerGone);
    expect(String((caught as Error).message)).toContain("500");
  });
});
