import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.CLOUDFLARE_SANDBOX_URL;
const originalToken = process.env.CLOUDFLARE_SANDBOX_TOKEN;

beforeEach(() => {
  process.env.CLOUDFLARE_SANDBOX_URL = "https://sb.example.workers.dev";
  process.env.CLOUDFLARE_SANDBOX_TOKEN = "shared-secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.CLOUDFLARE_SANDBOX_URL;
  else process.env.CLOUDFLARE_SANDBOX_URL = originalUrl;
  if (originalToken === undefined) delete process.env.CLOUDFLARE_SANDBOX_TOKEN;
  else process.env.CLOUDFLARE_SANDBOX_TOKEN = originalToken;
});

describe("cloudflareProvider", () => {
  it("is resolvable from the registry by name", async () => {
    const { resolveContainerProvider } = await import("../src/providers/registry");
    const p = await resolveContainerProvider("cloudflare");
    expect(p.name).toBe("cloudflare");
  });

  it("reports unavailable when URL is missing", async () => {
    delete process.env.CLOUDFLARE_SANDBOX_URL;
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const result = await cloudflareProvider.checkAvailability?.();
    expect(result?.available).toBe(false);
    expect(result?.message).toMatch(/CLOUDFLARE_SANDBOX_URL/);
  });

  it("reports unavailable when token is missing", async () => {
    delete process.env.CLOUDFLARE_SANDBOX_TOKEN;
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const result = await cloudflareProvider.checkAvailability?.();
    expect(result?.available).toBe(false);
    expect(result?.message).toMatch(/CLOUDFLARE_SANDBOX_TOKEN/);
  });

  it("posts to /sandboxes/{name} on create with bearer auth", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 201 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await cloudflareProvider.create({ name: "ca-sess-abc" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sb.example.workers.dev/sandboxes/ca-sess-abc");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer shared-secret");
  });

  it("posts to /sandboxes/{name}/exec and returns the parsed result", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ stdout: "hi\n", stderr: "", exit_code: 0 }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await cloudflareProvider.exec("ca-sess-abc", ["echo", "hi"]);
    expect(out).toEqual({ stdout: "hi\n", stderr: "", exit_code: 0 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sb.example.workers.dev/sandboxes/ca-sess-abc/exec");
    const body = JSON.parse(init?.body as string);
    expect(body.argv).toEqual(["echo", "hi"]);
  });

  it("treats 409 on create as success (idempotent)", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    globalThis.fetch = (async () => new Response("conflict", { status: 409 })) as unknown as typeof fetch;
    await expect(cloudflareProvider.create({ name: "ca-sess-abc" })).resolves.toBeUndefined();
  });

  it("throws when exec returns a non-2xx status", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(cloudflareProvider.exec("ca-sess-abc", ["true"])).rejects.toThrow(/Cloudflare sandbox exec failed \(500\)/);
  });

  it("prefers secrets over env when both are set", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 201 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await cloudflareProvider.create({
      name: "ca-sess-abc",
      secrets: {
        CLOUDFLARE_SANDBOX_URL: "https://override.example.com",
        CLOUDFLARE_SANDBOX_TOKEN: "override-secret",
      },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://override.example.com/sandboxes/ca-sess-abc");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer override-secret");
  });

  it("surfaces non-zero exit_code from exec", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ stdout: "", stderr: "nope", exit_code: 2 }), { status: 200 })
    ) as unknown as typeof fetch;
    const out = await cloudflareProvider.exec("ca-sess-abc", ["false"]);
    expect(out.exit_code).toBe(2);
    expect(out.stderr).toBe("nope");
  });

  it("passes an AbortSignal to fetch so timeouts can cancel in-flight requests", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    let captured: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      captured = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ stdout: "", stderr: "", exit_code: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    await cloudflareProvider.exec("ca-sess-abc", ["true"], { timeoutMs: 1000 });
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);
  });

  it("startExec wires opts.signal so callers can cancel mid-flight", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const external = new AbortController();
    globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      const signal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    const promise = cloudflareProvider.startExec("ca-sess-abc", {
      argv: ["sleep", "5"],
      signal: external.signal,
    });
    external.abort();
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it("list queries /sandboxes?prefix= and filters by prefix", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify([
        { name: "ca-sess-one" },
        { name: "ca-sess-two" },
        { name: "other-thing" },
      ]), { status: 200 })
    );
    globalThis.fetch = fetchMock;

    const result = await cloudflareProvider.list({ prefix: "ca-sess-" });
    expect(result.map((r) => r.name).sort()).toEqual(["ca-sess-one", "ca-sess-two"]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sb.example.workers.dev/sandboxes?prefix=ca-sess-");
  });
});
