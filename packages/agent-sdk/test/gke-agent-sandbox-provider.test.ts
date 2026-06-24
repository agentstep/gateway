/**
 * Tests for the Google GKE Agent Sandbox provider.
 *
 * Mocks the Kubernetes REST API (Sandbox CRD lifecycle + pod readiness)
 * to verify the provider builds correct requests. Exec uses the
 * Kubernetes WebSocket channel protocol and is covered separately by a
 * mocked WebSocket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const READY_POD = {
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
};

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.GKE_API_SERVER = "https://gke.example.com";
  process.env.GKE_TOKEN = "ya29.token";
  process.env.GKE_SANDBOX_NAMESPACE = "agents";
  // Pin the CRD version for the lifecycle tests so they don't make a version-
  // discovery call (the discovery path is covered by its own tests below).
  process.env.GKE_SANDBOX_API_VERSION = "v1alpha1";
  delete (globalThis as Record<string, unknown>).__caGkeApiVersion;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GKE_API_SERVER;
  delete process.env.GKE_TOKEN;
  delete process.env.GKE_SANDBOX_NAMESPACE;
  delete process.env.GKE_SANDBOX_IMAGE;
  delete process.env.GKE_SANDBOX_API_VERSION;
  delete (globalThis as Record<string, unknown>).__caGkeApiVersion;
});

describe("GKE Agent Sandbox provider", () => {
  it("checkAvailability requires API server and token", async () => {
    delete process.env.GKE_TOKEN;
    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    const result = await gkeAgentSandboxProvider.checkAvailability!();
    expect(result.available).toBe(false);
    expect(result.message).toContain("GKE_TOKEN");
  });

  it("checkAvailability returns true when configured", async () => {
    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    const result = await gkeAgentSandboxProvider.checkAvailability!();
    expect(result.available).toBe(true);
  });

  it("create posts a Sandbox manifest then waits for the pod to be ready", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ metadata: { name: "ca-sess-gke-1" } }, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(READY_POD));

    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    await gkeAgentSandboxProvider.create({ name: "ca-sess-gke-1" });

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe(
      "https://gke.example.com/apis/agents.x-k8s.io/v1alpha1/namespaces/agents/sandboxes",
    );
    expect(createInit.method).toBe("POST");
    expect(createInit.headers.Authorization).toBe("Bearer ya29.token");
    const body = JSON.parse(createInit.body);
    expect(body.kind).toBe("Sandbox");
    expect(body.apiVersion).toBe("agents.x-k8s.io/v1alpha1");
    expect(body.metadata.name).toBe("ca-sess-gke-1");
    expect(body.spec.podTemplate.spec.containers[0].image).toBe("node:22");

    const [podUrl] = fetchMock.mock.calls[1];
    expect(podUrl).toBe("https://gke.example.com/api/v1/namespaces/agents/pods/ca-sess-gke-1");
  });

  it("create tolerates an already-existing sandbox (409)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "already exists" }, 409));
    fetchMock.mockResolvedValueOnce(jsonResponse(READY_POD));
    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    await expect(gkeAgentSandboxProvider.create({ name: "ca-sess-gke-dup" })).resolves.toBeUndefined();
  });

  it("uses a custom image when configured", async () => {
    process.env.GKE_SANDBOX_IMAGE = "ghcr.io/acme/sandbox:1";
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(READY_POD));
    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    await gkeAgentSandboxProvider.create({ name: "ca-sess-gke-img" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.spec.podTemplate.spec.containers[0].image).toBe("ghcr.io/acme/sandbox:1");
  });

  it("delete sends DELETE on the Sandbox resource", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    await gkeAgentSandboxProvider.delete("ca-sess-gke-2");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://gke.example.com/apis/agents.x-k8s.io/v1alpha1/namespaces/agents/sandboxes/ca-sess-gke-2",
    );
    expect(init.method).toBe("DELETE");
  });

  it("delete is best-effort and does not throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection reset"));
    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    await expect(gkeAgentSandboxProvider.delete("ca-sess-gke-3")).resolves.toBeUndefined();
  });

  it("list returns Sandbox names filtered by prefix", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { metadata: { name: "ca-sess-a" } },
          { metadata: { name: "ca-sess-b" } },
          { metadata: { name: "system-thing" } },
        ],
      }),
    );
    const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
    const result = await gkeAgentSandboxProvider.list({ prefix: "ca-sess-" });
    expect(result).toEqual([{ name: "ca-sess-a" }, { name: "ca-sess-b" }]);
  });

  // ── CRD API-version resolution ──────────────────────────────────────────
  // The served version varies by deployment: the open-source operator
  // (through v0.4.6) serves v1alpha1 — verified live, where a v1beta1 request
  // 404s — while the managed offering may serve a newer version. The provider
  // discovers the preferred version from `/apis/agents.x-k8s.io` rather than
  // hardcoding it (the original code hardcoded v1beta1 and 404'd on real
  // clusters).
  describe("API version resolution", () => {
    it("discovers the served version from /apis/agents.x-k8s.io when not pinned", async () => {
      delete process.env.GKE_SANDBOX_API_VERSION; // force discovery
      // 1) discovery → preferred version, 2) create 201, 3) pod Ready
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ preferredVersion: { version: "v1alpha1" } }),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ metadata: { name: "ca-sess-disc" } }, 201));
      fetchMock.mockResolvedValueOnce(jsonResponse(READY_POD));

      const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
      await gkeAgentSandboxProvider.create({ name: "ca-sess-disc" });

      const [discUrl] = fetchMock.mock.calls[0];
      expect(discUrl).toBe("https://gke.example.com/apis/agents.x-k8s.io");
      const [createUrl] = fetchMock.mock.calls[1];
      expect(createUrl).toBe(
        "https://gke.example.com/apis/agents.x-k8s.io/v1alpha1/namespaces/agents/sandboxes",
      );
    });

    it("honours a newer discovered version (e.g. v1beta1) without code changes", async () => {
      delete process.env.GKE_SANDBOX_API_VERSION;
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ preferredVersion: { version: "v1beta1" } }),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));
      fetchMock.mockResolvedValueOnce(jsonResponse(READY_POD));

      const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
      await gkeAgentSandboxProvider.create({ name: "ca-sess-beta" });

      const [createUrl, createInit] = fetchMock.mock.calls[1];
      expect(createUrl).toContain("/agents.x-k8s.io/v1beta1/");
      expect(JSON.parse(createInit.body).apiVersion).toBe("agents.x-k8s.io/v1beta1");
    });

    it("falls back to v1alpha1 when discovery is unreachable (no extra call cached)", async () => {
      delete process.env.GKE_SANDBOX_API_VERSION;
      fetchMock.mockRejectedValueOnce(new Error("discovery down")); // discovery fails
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));
      fetchMock.mockResolvedValueOnce(jsonResponse(READY_POD));

      const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
      await gkeAgentSandboxProvider.create({ name: "ca-sess-fb" });

      const [createUrl] = fetchMock.mock.calls[1];
      expect(createUrl).toContain("/agents.x-k8s.io/v1alpha1/");
    });

    it("a pinned GKE_SANDBOX_API_VERSION skips discovery entirely", async () => {
      process.env.GKE_SANDBOX_API_VERSION = "v1beta1";
      // No discovery call — first fetch is the create itself.
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));
      fetchMock.mockResolvedValueOnce(jsonResponse(READY_POD));

      const { gkeAgentSandboxProvider } = await import("../src/providers/gke-agent-sandbox");
      await gkeAgentSandboxProvider.create({ name: "ca-sess-pin" });

      const [firstUrl] = fetchMock.mock.calls[0];
      expect(firstUrl).toBe(
        "https://gke.example.com/apis/agents.x-k8s.io/v1beta1/namespaces/agents/sandboxes",
      );
    });
  });
});
