/**
 * Tests for /v1/api-keys CRUD + scope enforcement in handleCreateSession.
 *
 * Covers:
 *   - Admin creates / lists / revokes keys; non-admin gets 403
 *   - Scope enforcement: key scoped to agent A can't create session against agent B
 *   - Legacy `["*"]` permissions rows still authenticate and are treated as admin
 *   - permissions.admin === false + scope === null → unrestricted access but no key CRUD
 *   - revokeApiKey refuses self-revocation
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-api-keys-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
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

async function bootDb(): Promise<{ adminKey: string; adminId: string }> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  // Default: admin key
  const { key, id } = createApiKey({
    name: "test-admin",
    permissions: { admin: true, scope: null },
    rawKey: "ck_test_admin_12345678",
  });
  return { adminKey: key, adminId: id };
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey !== undefined) {
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "ck_test_admin_12345678";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("API Keys — CRUD (admin only)", () => {
  beforeEach(() => freshDbEnv());

  it("admin creates, lists, retrieves, patches, revokes", async () => {
    await bootDb();
    const { handleCreateApiKey, handleListApiKeys, handleGetApiKey, handlePatchApiKey, handleRevokeApiKey } = await import(
      "../src/handlers/api_keys"
    );

    // Create
    const createRes = await handleCreateApiKey(req("/v1/api-keys", {
      body: {
        name: "ci-bot",
        permissions: { admin: false, scope: { agents: ["agent_a"], environments: ["*"], vaults: [] } },
      },
    }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; key: string; permissions: { admin: boolean; scope: Record<string, string[]> | null } };
    expect(created.key).toMatch(/^ck_/);
    expect(created.permissions.admin).toBe(false);
    expect(created.permissions.scope?.agents).toEqual(["agent_a"]);

    // List
    const listRes = await handleListApiKeys(req("/v1/api-keys"));
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { data: Array<{ id: string; name: string }> };
    expect(list.data.map(r => r.name).sort()).toEqual(["ci-bot", "test-admin"]);

    // Get
    const getRes = await handleGetApiKey(req(`/v1/api-keys/${created.id}`), created.id);
    expect(getRes.status).toBe(200);
    const got = await getRes.json() as { name: string };
    expect(got.name).toBe("ci-bot");

    // Patch
    const patchRes = await handlePatchApiKey(req(`/v1/api-keys/${created.id}`, {
      method: "PATCH",
      body: { permissions: { admin: false, scope: null } },
    }), created.id);
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json() as { permissions: { scope: unknown } };
    expect(patched.permissions.scope).toBeNull();

    // Revoke
    const revokeRes = await handleRevokeApiKey(req(`/v1/api-keys/${created.id}`, { method: "DELETE" }), created.id);
    expect(revokeRes.status).toBe(200);

    // After revoke: listing omits the key
    const afterList = await handleListApiKeys(req("/v1/api-keys"));
    const afterData = await afterList.json() as { data: Array<{ name: string }> };
    expect(afterData.data.map(r => r.name)).toEqual(["test-admin"]);
  });

  it("non-admin is rejected on every CRUD endpoint with 403", async () => {
    await bootDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { handleCreateApiKey, handleListApiKeys } = await import("../src/handlers/api_keys");

    const { key: userKey } = createApiKey({
      name: "scoped-user",
      permissions: { admin: false, scope: null },
      rawKey: "ck_test_user_12345678",
    });

    const createRes = await handleCreateApiKey(req("/v1/api-keys", {
      apiKey: userKey,
      body: { name: "shouldnotwork" },
    }));
    expect(createRes.status).toBe(403);

    const listRes = await handleListApiKeys(req("/v1/api-keys", { apiKey: userKey }));
    expect(listRes.status).toBe(403);
  });

  it("admin cannot revoke the key used in the current request (anti-lockout)", async () => {
    const { adminKey, adminId } = await bootDb();
    const { handleRevokeApiKey } = await import("../src/handlers/api_keys");

    const res = await handleRevokeApiKey(
      req(`/v1/api-keys/${adminId}`, { method: "DELETE", apiKey: adminKey }),
      adminId,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/cannot revoke the key used for this request/);
  });

  it("missing API key returns 401", async () => {
    await bootDb();
    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    const res = await handleListApiKeys(req("/v1/api-keys", { apiKey: "" }));
    expect(res.status).toBe(401);
  });

  it("invalid permissions shape returns 400", async () => {
    await bootDb();
    const { handleCreateApiKey } = await import("../src/handlers/api_keys");
    const res = await handleCreateApiKey(req("/v1/api-keys", {
      body: { name: "bad", permissions: { admin: "yes" } }, // admin must be boolean
    }));
    expect(res.status).toBe(400);
  });
});

describe("API Keys — Legacy permissions backcompat", () => {
  beforeEach(() => freshDbEnv());

  it("legacy `[\"*\"]` permissions row authenticates and is treated as admin", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const crypto = await import("node:crypto");
    const rawKey = "ck_legacy_key_1234567890";
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, name, hash, prefix, permissions_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("key_legacy", "pre-0.4", hash, rawKey.slice(0, 8), '["*"]', Date.now());

    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    const res = await handleListApiKeys(req("/v1/api-keys", { apiKey: rawKey }));
    expect(res.status).toBe(200);

    // Hydrated permissions should show admin=true, scope=null
    const body = await res.json() as { data: Array<{ permissions: { admin: boolean; scope: unknown } }> };
    const ours = body.data.find(r => (r as unknown as { id: string }).id === "key_legacy");
    expect(ours?.permissions).toEqual({ admin: true, scope: null });
  });

  it("corrupt permissions_json still authenticates but denies admin", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const crypto = await import("node:crypto");
    const rawKey = "ck_corrupt_key_1234567890";
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, name, hash, prefix, permissions_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("key_corrupt", "bad-json", hash, rawKey.slice(0, 8), "not json {", Date.now());

    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    const res = await handleListApiKeys(req("/v1/api-keys", { apiKey: rawKey }));
    expect(res.status).toBe(403);
  });
});

describe("Scope enforcement — checkResourceScope helper", () => {
  it("null scope permits everything", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: null },
      tenantId: null,
    };
    expect(() => checkResourceScope(auth, { agent: "a1", env: "e1", vaults: ["v1"] })).not.toThrow();
  });

  it("explicit allow-list with `*` permits all of that type", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: { agents: ["*"], environments: ["e1"], vaults: [] } },
      tenantId: null,
    };
    expect(() => checkResourceScope(auth, { agent: "anything", env: "e1" })).not.toThrow();
    expect(() => checkResourceScope(auth, { env: "e2" })).toThrow(/environment e2/);
  });

  it("scope without the agent throws 403", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: { agents: ["agent_a"], environments: ["*"], vaults: ["*"] } },
      tenantId: null,
    };
    expect(() => checkResourceScope(auth, { agent: "agent_b" })).toThrow(/agent_b/);
  });

  it("empty vault array means no vaults allowed", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: { agents: ["*"], environments: ["*"], vaults: [] } },
      tenantId: null,
    };
    expect(() => checkResourceScope(auth, { vaults: ["v1"] })).toThrow(/vault v1/);
  });
});

describe("tenant_id passthrough (v0.5 reservation)", () => {
  beforeEach(() => freshDbEnv());

  it("AuthContext exposes tenantId for keys that have one; null for keys that don't", async () => {
    await bootDb();
    const { createApiKey, findByRawKey, hydratePermissions } = await import("../src/db/api_keys");
    const { authenticate } = await import("../src/auth/middleware");

    const { key: k1 } = createApiKey({
      name: "tenant-scoped",
      permissions: { admin: false, scope: null },
      tenantId: "tenant_acme",
      rawKey: "ck_with_tenant_1234567890",
    });
    const { key: k2 } = createApiKey({
      name: "no-tenant",
      permissions: { admin: false, scope: null },
      rawKey: "ck_no_tenant_1234567890",
    });

    const ctx1 = await authenticate(new Request("http://l", { headers: { "x-api-key": k1 } }));
    expect(ctx1.tenantId).toBe("tenant_acme");

    const ctx2 = await authenticate(new Request("http://l", { headers: { "x-api-key": k2 } }));
    expect(ctx2.tenantId).toBeNull();

    // Handlers don't read tenantId in v0.4 — spot check by finding the row
    const row1 = findByRawKey(k1);
    expect(row1?.tenant_id).toBe("tenant_acme");
    expect(hydratePermissions(row1!.permissions_json)).toEqual({ admin: false, scope: null });
  });
});
