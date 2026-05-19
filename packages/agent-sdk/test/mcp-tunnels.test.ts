import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-mcp-tunnels-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caMcpTunnels?: unknown;
    __caConfigCache?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caMcpTunnels;
  delete g.__caConfigCache;
}

beforeEach(() => {
  freshDbEnv();
});

// Minimal in-memory transport for testing the dispatcher.
function makeFakeTransport() {
  const sent: any[] = [];
  let onMessage: ((f: any) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  return {
    sent,
    transport: {
      send(frame: any) {
        if (closed) throw new Error("closed");
        sent.push(frame);
      },
      close() {
        closed = true;
        onClose?.();
      },
      onMessage(h: (f: any) => void) { onMessage = h; },
      onClose(h: () => void) { onClose = h; },
    },
    deliver(frame: any) { onMessage?.(frame); },
    closeFromRemote() {
      closed = true;
      onClose?.();
    },
    isClosed() { return closed; },
  };
}

describe("mcp tunnels — wire protocol", () => {
  it("parseTunnelUrl handles standard, root, and invalid forms", async () => {
    const { parseTunnelUrl } = await import("../src/mcp/tunnels");
    expect(parseTunnelUrl("tunnel://abc123/sse")).toEqual({ tunnelId: "abc123", path: "/sse" });
    expect(parseTunnelUrl("tunnel://abc123/")).toEqual({ tunnelId: "abc123", path: "/" });
    expect(parseTunnelUrl("tunnel://abc123")).toEqual({ tunnelId: "abc123", path: "/" });
    expect(parseTunnelUrl("tunnel:///sse")).toBeNull();
    expect(parseTunnelUrl("https://example.com")).toBeNull();
  });

  it("dispatchTunneledRequest sends a framed request and resolves with the matching response", async () => {
    const { registerTunnel, dispatchTunneledRequest } = await import("../src/mcp/tunnels");
    const fake = makeFakeTransport();
    registerTunnel("t1", fake.transport);

    const promise = dispatchTunneledRequest("t1", {
      path: "/sse",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(fake.sent).toHaveLength(1);
    const req = fake.sent[0];
    expect(req.type).toBe("request");
    expect(req.path).toBe("/sse");
    expect(req.method).toBe("POST");
    expect(typeof req.id).toBe("string");

    fake.deliver({
      type: "response",
      id: req.id,
      status: 200,
      headers: {},
      body: "ok",
    });

    const res = await promise;
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("times out when no response arrives", async () => {
    const { registerTunnel, dispatchTunneledRequest } = await import("../src/mcp/tunnels");
    const fake = makeFakeTransport();
    registerTunnel("t-timeout", fake.transport);

    await expect(
      dispatchTunneledRequest("t-timeout", { path: "/", method: "GET" }, { timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/);
  });

  it("rejects pending requests when the tunnel closes", async () => {
    const { registerTunnel, dispatchTunneledRequest, isTunnelConnected } = await import("../src/mcp/tunnels");
    const fake = makeFakeTransport();
    registerTunnel("t-close", fake.transport);
    expect(isTunnelConnected("t-close")).toBe(true);

    const promise = dispatchTunneledRequest("t-close", { path: "/", method: "GET" }, { timeoutMs: 5000 });
    fake.closeFromRemote();
    await expect(promise).rejects.toThrow(/tunnel closed/);
    expect(isTunnelConnected("t-close")).toBe(false);
  });

  it("replaces an existing tunnel and rejects the old pending requests", async () => {
    const { registerTunnel, dispatchTunneledRequest } = await import("../src/mcp/tunnels");
    const first = makeFakeTransport();
    const second = makeFakeTransport();
    registerTunnel("t-replace", first.transport);

    const pending = dispatchTunneledRequest("t-replace", { path: "/", method: "GET" }, { timeoutMs: 5000 });
    registerTunnel("t-replace", second.transport);

    await expect(pending).rejects.toThrow(/replaced/);
    expect(first.isClosed()).toBe(true);
  });

  it("auto-replies to ping with pong", async () => {
    const { registerTunnel } = await import("../src/mcp/tunnels");
    const fake = makeFakeTransport();
    registerTunnel("t-ping", fake.transport);

    fake.deliver({ type: "ping" });
    expect(fake.sent.find((f: any) => f.type === "pong")).toBeTruthy();
  });

  it("dispatch throws when no tunnel is registered", async () => {
    const { dispatchTunneledRequest } = await import("../src/mcp/tunnels");
    await expect(
      dispatchTunneledRequest("nope", { path: "/", method: "GET" }),
    ).rejects.toThrow(/not connected/);
  });
});

describe("mcp tunnels — persistence", () => {
  it("creates a tunnel, returns a one-shot token, and authenticates with it", async () => {
    const { createMcpTunnel, authenticateTunnel } = await import("../src/db/mcp_tunnels");
    const { id, token } = createMcpTunnel({ name: "prod-warehouse" });

    expect(id).toMatch(/^mtun_/);
    expect(token).toMatch(/^mtk_/);

    const row = authenticateTunnel(id, token);
    expect(row).not.toBeNull();
    expect(row?.name).toBe("prod-warehouse");

    expect(authenticateTunnel(id, "mtk_wrongtoken_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(authenticateTunnel("mtun_doesnotexist", token)).toBeNull();
  });

  it("revoke makes authenticateTunnel return null", async () => {
    const { createMcpTunnel, authenticateTunnel, revokeMcpTunnel } = await import("../src/db/mcp_tunnels");
    const { id, token } = createMcpTunnel({ name: "to-revoke" });
    expect(authenticateTunnel(id, token)).not.toBeNull();

    expect(revokeMcpTunnel(id)).toBe(true);
    expect(authenticateTunnel(id, token)).toBeNull();
    // Revoke is idempotent — second call is a no-op.
    expect(revokeMcpTunnel(id)).toBe(false);
  });

  it("listMcpTunnels filters revoked rows and respects tenant_id", async () => {
    const { createMcpTunnel, listMcpTunnels, revokeMcpTunnel } = await import("../src/db/mcp_tunnels");
    const a = createMcpTunnel({ name: "a", tenantId: "tenant_x" });
    createMcpTunnel({ name: "b", tenantId: "tenant_y" });
    const c = createMcpTunnel({ name: "c", tenantId: "tenant_x" });
    revokeMcpTunnel(c.id);

    const tenantX = listMcpTunnels("tenant_x");
    expect(tenantX.map((r) => r.name)).toEqual(["a"]);
    expect(tenantX.every((r) => r.tenant_id === "tenant_x")).toBe(true);
    expect(tenantX[0].id).toBe(a.id);

    const all = listMcpTunnels();
    expect(all.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });
});
