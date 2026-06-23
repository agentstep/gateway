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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GKE_API_SERVER;
  delete process.env.GKE_TOKEN;
  delete process.env.GKE_SANDBOX_NAMESPACE;
  delete process.env.GKE_SANDBOX_IMAGE;
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
      "https://gke.example.com/apis/agents.x-k8s.io/v1beta1/namespaces/agents/sandboxes",
    );
    expect(createInit.method).toBe("POST");
    expect(createInit.headers.Authorization).toBe("Bearer ya29.token");
    const body = JSON.parse(createInit.body);
    expect(body.kind).toBe("Sandbox");
    expect(body.apiVersion).toBe("agents.x-k8s.io/v1beta1");
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
      "https://gke.example.com/apis/agents.x-k8s.io/v1beta1/namespaces/agents/sandboxes/ca-sess-gke-2",
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
});
