// @ts-nocheck — test file with loose typing on handler responses
/**
 * Anthropic API passthrough — auth + routeWrap interception tests.
 *
 * Verifies the contract:
 *   - sk-ant-api* + flag off → 401, no upstream call
 *   - sk-ant-api* + flag on  → forwarded with that key, no DB writes
 *   - sk-ant-api* on a gateway-only route → 401, no upstream call
 *   - sk-ant-oat* (OAuth) → not treated as passthrough → 401
 *   - Garbage key → 401, never sent upstream (fail-closed)
 *   - Existing gateway keys still work when passthrough is enabled
 *   - Side channel: same status for unknown gateway key vs disabled
 *     passthrough (both are 401 from authenticate)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-passthrough-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  delete process.env.ANTHROPIC_PASSTHROUGH_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function stubFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    const opts = (init ?? {}) as RequestInit;
    const rawHeaders = (opts.headers ?? {}) as Record<string, string> | Headers;
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      for (const [k, v] of rawHeaders.entries()) headers[k.toLowerCase()] = v;
    } else {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    }
    calls.push({
      url: String(url),
      method: (opts.method ?? "GET").toUpperCase(),
      headers,
      body: typeof opts.body === "string" ? opts.body : null,
    });
    return new Response(JSON.stringify({ id: "remote_xyz", type: "agent" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const PASSTHROUGH_KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OAUTH_KEY = "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("anthropic passthrough auth", () => {
  let stub: ReturnType<typeof stubFetch> | null = null;

  beforeEach(() => {
    freshDbEnv();
  });

  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it("isAnthropicApiKey: matches sk-ant-api*, rejects sk-ant-oat* and gateway keys", async () => {
    const { isAnthropicApiKey } = await import("../src/auth/passthrough");
    expect(isAnthropicApiKey(PASSTHROUGH_KEY)).toBe(true);
    expect(isAnthropicApiKey(OAUTH_KEY)).toBe(false);
    expect(isAnthropicApiKey("ck_abc123")).toBe(false);
    expect(isAnthropicApiKey("sk-ant-api")).toBe(false); // too short
    expect(isAnthropicApiKey("")).toBe(false);
    expect(isAnthropicApiKey("sk-foo-api1234567890123456789012345")).toBe(false);
  });

  it("isPassthroughAllowedPath: allows Anthropic-mirror routes, rejects gateway-only routes", async () => {
    const { isPassthroughAllowedPath } = await import("../src/auth/passthrough");
    // Allowed
    expect(isPassthroughAllowedPath("/v1/agents")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/agents/agt_123")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/sessions")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/sessions/sess_123/events")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/sessions/sess_123/events/stream")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/vaults")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/vaults/vlt_1/entries/KEY")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/files")).toBe(true);
    expect(isPassthroughAllowedPath("/v1/environments")).toBe(true);
    // Rejected (gateway-only)
    expect(isPassthroughAllowedPath("/v1/api-keys")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/settings/anything")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/metrics")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/tenants")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/upstream-keys")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/audit")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/license")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/whoami")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/traces/abc")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/models")).toBe(false);
    expect(isPassthroughAllowedPath("/v1/skills")).toBe(false);
    expect(isPassthroughAllowedPath("/")).toBe(false);
  });

  it("rejects sk-ant-api* with 401 when passthrough is disabled (default)", async () => {
    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", { apiKey: PASSTHROUGH_KEY }));
    expect(res.status).toBe(401);
    expect(stub.calls).toHaveLength(0); // never forwarded upstream
  });

  it("forwards sk-ant-api* to Anthropic when passthrough is enabled", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", { apiKey: PASSTHROUGH_KEY }));
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe("https://api.anthropic.com/v1/agents");
    expect(stub.calls[0].headers["x-api-key"]).toBe(PASSTHROUGH_KEY);
    expect(stub.calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(stub.calls[0].headers["anthropic-beta"]).toBe("managed-agents-2026-04-01");
  });

  it("rejects sk-ant-api* on gateway-only routes (e.g. /v1/api-keys) with 401", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    stub = stubFetch();
    const res = await handleListApiKeys(req("/v1/api-keys", { apiKey: PASSTHROUGH_KEY }));
    expect(res.status).toBe(401);
    expect(stub.calls).toHaveLength(0); // gateway state never enumerated
  });

  it("rejects sk-ant-oat* (OAuth tokens) — never enters passthrough", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", { apiKey: OAUTH_KEY }));
    expect(res.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects garbage keys (fail-closed — never forward arbitrary strings to Anthropic)", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", { apiKey: "definitely-not-a-key" }));
    expect(res.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("never looks up sk-ant-api* against the local api_keys table (no side channel)", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { getDb } = await import("../src/db/client");
    getDb(); // migrations
    const { createApiKey } = await import("../src/db/api_keys");
    // Plant a gateway key — passthrough must NOT route through
    // findByRawKey for sk-ant-api* keys, even when other keys exist.
    createApiKey({ name: "gateway-1", rawKey: "ck_real_gateway_key" });

    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", { apiKey: PASSTHROUGH_KEY }));
    // 200 means the request reached the stubbed Anthropic endpoint —
    // i.e. shape-routing kicked in before the api_keys lookup.
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].headers["x-api-key"]).toBe(PASSTHROUGH_KEY);
  });

  it("gateway keys still authenticate normally when passthrough is enabled", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { key } = createApiKey({ name: "test", rawKey: "ck_test_gateway_key" });

    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", { apiKey: key }));
    expect(res.status).toBe(200);
    // Gateway-key path must NOT call Anthropic — it serves from the local DB.
    expect(stub.calls).toHaveLength(0);
  });

  it("passthrough writes nothing to the local DB (pure proxy, no session/sync rows)", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { getDb } = await import("../src/db/client");
    const db = getDb();

    const { handleCreateSession } = await import("../src/handlers/sessions");
    stub = stubFetch();
    // Stub returns a session-shaped object so the response is well-formed.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "sess_remote_xyz", type: "session" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof globalThis.fetch;

    const res = await handleCreateSession(
      req("/v1/sessions", {
        method: "POST",
        body: { agent: "agt_remote", environment_id: "env_remote" },
        apiKey: PASSTHROUGH_KEY,
      }),
    );
    expect(res.status).toBe(201);

    // No local rows should have been created. Sessions, sync, and proxy
    // tables must all be empty.
    const sessCount = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    const syncCount = (db.prepare("SELECT COUNT(*) AS n FROM anthropic_sync").get() as { n: number }).n;
    const proxyCount = (db.prepare("SELECT COUNT(*) AS n FROM proxy_resources").get() as { n: number }).n;
    expect(sessCount).toBe(0);
    expect(syncCount).toBe(0);
    expect(proxyCount).toBe(0);
  });

  it("forwards POST body verbatim to Anthropic with the passthrough key", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { handleCreateSession } = await import("../src/handlers/sessions");
    stub = stubFetch();

    const body = { agent: "agt_remote", environment_id: "env_remote", title: "hello" };
    await handleCreateSession(
      req("/v1/sessions", { method: "POST", body, apiKey: PASSTHROUGH_KEY }),
    );

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("POST");
    expect(stub.calls[0].body).toBe(JSON.stringify(body));
    expect(stub.calls[0].headers["x-api-key"]).toBe(PASSTHROUGH_KEY);
  });

  it("missing key still 401s when passthrough is enabled", async () => {
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "true";
    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", {}));
    expect(res.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("reads ANTHROPIC_PASSTHROUGH_ENABLED from settings DB as well as env", async () => {
    // No env var set — flip via writeSetting and verify forwarding works.
    const { getDb } = await import("../src/db/client");
    getDb();
    const { writeSetting } = await import("../src/config");
    writeSetting("anthropic_passthrough_enabled", "true");

    const { handleListAgents } = await import("../src/handlers/agents");
    stub = stubFetch();
    const res = await handleListAgents(req("/v1/agents", { apiKey: PASSTHROUGH_KEY }));
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
  });
});
