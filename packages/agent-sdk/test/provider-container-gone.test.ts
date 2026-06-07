/**
 * Cloud providers must throw ContainerGone (not a generic Error) when their
 * backing sandbox is missing, so the turn driver drops the stale pool entry,
 * re-acquires a fresh sandbox, and retries the turn instead of failing it.
 *
 * SDK providers (e2b, vercel, modal) check their in-memory instance map before
 * touching the SDK, so the map-miss path is exercised without the optional SDK
 * packages installed. daytona/fly are driven via a mocked fetch returning 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContainerGone } from "../src/providers/types";

describe("ContainerGone on missing sandbox", () => {
  describe("SDK providers (in-memory map miss)", () => {
    it("e2b.exec throws ContainerGone", async () => {
      const { e2bProvider } = await import("../src/providers/e2b");
      await expect(e2bProvider.exec("ca-sess-missing", ["echo", "hi"])).rejects.toBeInstanceOf(ContainerGone);
    });
    it("e2b.startExec throws ContainerGone", async () => {
      const { e2bProvider } = await import("../src/providers/e2b");
      await expect(e2bProvider.startExec("ca-sess-missing", { argv: ["echo"] })).rejects.toBeInstanceOf(ContainerGone);
    });
    it("vercel.exec throws ContainerGone", async () => {
      const { vercelProvider } = await import("../src/providers/vercel");
      await expect(vercelProvider.exec("ca-sess-missing", ["echo", "hi"])).rejects.toBeInstanceOf(ContainerGone);
    });
    it("modal.exec throws ContainerGone", async () => {
      const { modalProvider } = await import("../src/providers/modal");
      await expect(modalProvider.exec("ca-sess-missing", ["echo", "hi"])).rejects.toBeInstanceOf(ContainerGone);
    });
  });

  describe("REST providers (404 from upstream)", () => {
    const originalFetch = globalThis.fetch;
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.DAYTONA_API_KEY;
      delete process.env.FLY_API_TOKEN;
      delete process.env.FLY_APP_NAME;
    });

    it("daytona.exec throws ContainerGone on 404", async () => {
      process.env.DAYTONA_API_KEY = "k";
      fetchMock.mockResolvedValueOnce(new Response("sandbox not found", { status: 404 }));
      const { daytonaProvider } = await import("../src/providers/daytona");
      await expect(daytonaProvider.exec("ca-sess-missing", ["echo", "hi"])).rejects.toBeInstanceOf(ContainerGone);
    });

    it("fly.exec throws ContainerGone when the machine isn't in the app list", async () => {
      process.env.FLY_API_TOKEN = "t";
      process.env.FLY_APP_NAME = "app";
      // refreshMachineMap → empty list → name not found → ContainerGone.
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
      const { flyProvider } = await import("../src/providers/fly");
      await expect(flyProvider.exec("ca-sess-missing", ["echo", "hi"])).rejects.toBeInstanceOf(ContainerGone);
    });
  });
});
