/**
 * Tests for the Cloudflare Sandbox provider.
 *
 * Mocks the bridge Worker HTTP API to verify the provider correctly
 * translates ContainerProvider calls to bridge REST requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.CLOUDFLARE_SANDBOX_URL = "https://bridge.example.com";
  process.env.CLOUDFLARE_SANDBOX_SECRET = "test-secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLOUDFLARE_SANDBOX_URL;
  delete process.env.CLOUDFLARE_SANDBOX_SECRET;
});

describe("Cloudflare Sandbox provider", () => {
  it("checkAvailability returns true when bridge is healthy", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const result = await cloudflareProvider.checkAvailability!();
    expect(result.available).toBe(true);
  });

  it("checkAvailability returns false when bridge is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused"));
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const result = await cloudflareProvider.checkAvailability!();
    expect(result.available).toBe(false);
    expect(result.message).toContain("unreachable");
  });

  it("checkAvailability returns false when URL not configured", async () => {
    delete process.env.CLOUDFLARE_SANDBOX_URL;
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const result = await cloudflareProvider.checkAvailability!();
    expect(result.available).toBe(false);
    expect(result.message).toContain("CLOUDFLARE_SANDBOX_URL");
  });

  it("create sends POST /sandboxes with name", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "ca-sess-test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    await cloudflareProvider.create({ name: "ca-sess-test" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example.com/sandboxes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "ca-sess-test" });
    expect(init.headers.Authorization).toBe("Bearer test-secret");
  });

  it("delete sends DELETE /sandboxes/:name", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    await cloudflareProvider.delete("ca-sess-test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example.com/sandboxes/ca-sess-test");
    expect(init.method).toBe("DELETE");
  });

  it("delete does not throw on failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("gone"));
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    await expect(cloudflareProvider.delete("ca-sess-test")).resolves.toBeUndefined();
  });

  it("list sends GET /sandboxes and filters by prefix", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sandboxes: [
            { name: "ca-sess-abc" },
            { name: "ca-sess-def" },
            { name: "other-123" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const result = await cloudflareProvider.list({ prefix: "ca-sess-" });
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("ca-sess-abc");
    expect(result[1].name).toBe("ca-sess-def");
  });

  it("exec sends POST /sandboxes/:name/exec with argv and stdin", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ stdout: "hello\n", stderr: "", exit_code: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const result = await cloudflareProvider.exec("ca-sess-test", ["echo", "hello"], {
      stdin: "input data",
      timeoutMs: 5000,
    });

    expect(result.stdout).toBe("hello\n");
    expect(result.exit_code).toBe(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example.com/sandboxes/ca-sess-test/exec");
    const body = JSON.parse(init.body);
    expect(body.argv).toEqual(["echo", "hello"]);
    expect(body.stdin).toBe("input data");
    expect(body.timeoutMs).toBe(5000);
  });

  it("exec throws on 5xx response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("internal error", { status: 502 }),
    );
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    await expect(
      cloudflareProvider.exec("ca-sess-test", ["cat", "/nonexistent"]),
    ).rejects.toThrow(/cloudflare/);
  });

  it("sends Authorization header with secret", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ stdout: "", stderr: "", exit_code: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    await cloudflareProvider.exec("test", ["ls"]);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-secret");
  });
});
