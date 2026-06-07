/**
 * #6 — daytona/fly must not inline very large stdin as a single `echo '<b64>'`
 * argument (ARG_MAX / MAX_ARG_STRLEN ~128KB). Past a threshold they write the
 * base64 to a temp file in bounded chunks (each a separate small exec) and then
 * decode it into the command. Small stdin keeps the fast inline path.
 *
 * #3 fail-safe — the SDK providers' list() must never throw when the SDK or
 * credentials are absent; it falls back to the in-memory view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ["DAYTONA_API_KEY", "FLY_API_TOKEN", "FLY_APP_NAME", "E2B_API_KEY"]) delete process.env[k];
  vi.restoreAllMocks();
});

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

describe("daytona large-stdin chunking (#6)", () => {
  it("inlines small stdin in a single exec", async () => {
    process.env.DAYTONA_API_KEY = "k";
    fetchMock.mockResolvedValue(jsonOk({ result: "ok", exitCode: 0 }));
    const { daytonaProvider } = await import("../src/providers/daytona");
    await daytonaProvider.exec("ca-sess-small", ["echo", "hi"], { stdin: "tiny" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]).command).toContain("base64 -d | 'echo' 'hi'");
  });

  it("writes large stdin to a temp file in chunks, then decodes it", async () => {
    process.env.DAYTONA_API_KEY = "k";
    fetchMock.mockResolvedValue(jsonOk({ result: "ok", exitCode: 0 }));
    const { daytonaProvider } = await import("../src/providers/daytona");
    const big = "a".repeat(120_000); // base64 ~160k chars > 96k threshold
    await daytonaProvider.exec("ca-sess-big", ["echo", "hi"], { stdin: big });

    // N chunk-writes + 1 final exec.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const writes = fetchMock.mock.calls.slice(0, -1);
    for (const w of writes) {
      const c = bodyOf(w).command as string;
      expect(c).toMatch(/^printf '%s' '.*' >> \/tmp\/_stdin_/);
    }
    const final = bodyOf(fetchMock.mock.calls.at(-1)!).command as string;
    expect(final).toMatch(/^base64 -d \/tmp\/_stdin_.*\.b64 \| 'echo' 'hi' ; rm -f \/tmp\/_stdin_/);
  });
});

describe("fly large-stdin chunking (#6)", () => {
  it("writes large stdin to a temp file in chunks, then decodes it", async () => {
    process.env.FLY_API_TOKEN = "t";
    process.env.FLY_APP_NAME = "app";
    const { flyProvider } = await import("../src/providers/fly");

    // Seed the name->machineId map via list().
    fetchMock.mockResolvedValueOnce(jsonOk([{ id: "m1", name: "ca-sess-fly" }]));
    await flyProvider.list({ prefix: "ca-sess-fly" });

    // All subsequent exec calls (chunk writes + final) return a buffered result.
    fetchMock.mockResolvedValue(jsonOk({ stdout: "out", exit_code: 0 }));
    const big = "b".repeat(120_000);
    await flyProvider.exec("ca-sess-fly", ["echo", "hi"], { stdin: big });

    const execCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/exec"));
    expect(execCalls.length).toBeGreaterThan(1);
    const final = bodyOf(execCalls.at(-1)!).command as string[];
    expect(final[0]).toBe("bash");
    expect(final[2]).toMatch(/^base64 -d \/tmp\/_stdin_.*\.b64 \| 'echo' 'hi' ; rm -f/);
    const firstWrite = bodyOf(execCalls[0]).command as string[];
    expect(firstWrite[2]).toMatch(/^printf '%s' '.*' >> \/tmp\/_stdin_/);
  });
});

describe("SDK provider list() fail-safe (#3)", () => {
  it("e2b.list returns the in-memory view (no throw) when no API key is set", async () => {
    const { e2bProvider } = await import("../src/providers/e2b");
    await expect(e2bProvider.list({ prefix: "ca-sess-" })).resolves.toEqual([]);
  });
  it("modal.list does not throw when reconnect is unavailable", async () => {
    const { modalProvider } = await import("../src/providers/modal");
    await expect(modalProvider.list({ prefix: "ca-sess-none" })).resolves.toEqual([]);
  });
});
