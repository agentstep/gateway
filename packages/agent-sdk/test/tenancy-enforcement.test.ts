/**
 * v0.5 tenant enforcement across handlers.
 *
 * Covers the "no cross-tenant visibility" guarantees that PR1b wires up:
 *   - Tenant users only see their own tenant's resources in list endpoints.
 *   - GET/PATCH/DELETE by id return 404 (not 403) for cross-tenant ids.
 *   - Session create stamps tenant_id from the agent/env tenant and
 *     refuses cross-tenant agent+env pairs with a 400.
 *   - Global admin (null tenant + admin) sees everything.
 *
 * A new tenant ("tenant_acme") is created alongside the default tenant;
 * one admin key is minted into each and we exercise both.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tenancy-enf-test-"));
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

interface TestKeys {
  globalKey: string;
  globalId: string;
  acmeAdminKey: string;
  acmeAdminId: string;
}

async function bootTenants(): Promise<TestKeys> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { seedDefaultTenant, createTenant } = await import("../src/db/tenants");
  const { createApiKey } = await import("../src/db/api_keys");

  seedDefaultTenant();
  createTenant({ id: "tenant_acme", name: "acme" });

  // Global admin — tenant_id = null, admin = true.
  const global = createApiKey({
    name: "global-admin",
    permissions: { admin: true, scope: null },
    tenantId: null,
    rawKey: "ck_test_global_admin_0001",
  });

  // Tenant admin for the acme tenant — tenant_id = tenant_acme, admin = true.
  const acme = createApiKey({
    name: "acme-admin",
    permissions: { admin: true, scope: null },
    tenantId: "tenant_acme",
    rawKey: "ck_test_acme_admin_0001",
  });

  return {
    globalKey: global.key,
    globalId: global.id,
    acmeAdminKey: acme.key,
    acmeAdminId: acme.id,
  };
}

function req(
  url: string,
  apiKey: string,
  opts: { method?: string; body?: unknown } = {},
): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("v0.5 tenant enforcement — agents", () => {
  beforeEach(() => freshDbEnv());

  it("list + get + patch + delete are scoped to caller's tenant", async () => {
    const { globalKey, acmeAdminKey } = await bootTenants();
    const { handleCreateAgent, handleListAgents, handleGetAgent, handleUpdateAgent, handleDeleteAgent } =
      await import("../src/handlers/agents");

    // Global admin creates one agent in each tenant.
    const defRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "default-a", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    );
    expect(defRes.status).toBe(201);
    const defAgent = await readJson(defRes);

    const acmeRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "acme-a", model: "claude-sonnet-4-6", tenant_id: "tenant_acme" },
      }),
    );
    expect(acmeRes.status).toBe(201);
    const acmeAgent = await readJson(acmeRes);

    // Global admin sees both.
    const allList = await readJson(
      await handleListAgents(req("/v1/agents", globalKey)),
    );
    const allIds = (allList.data as Array<{ id: string }>).map(a => a.id);
    expect(allIds).toContain(defAgent.id);
    expect(allIds).toContain(acmeAgent.id);

    // Acme admin sees only their tenant's agent.
    const acmeList = await readJson(
      await handleListAgents(req("/v1/agents", acmeAdminKey)),
    );
    const acmeIds = (acmeList.data as Array<{ id: string }>).map(a => a.id);
    expect(acmeIds).toContain(acmeAgent.id);
    expect(acmeIds).not.toContain(defAgent.id);

    // Acme admin can't fetch default-tenant agent — 404 (not 403) to
    // prevent id-probing across tenants.
    const crossGet = await handleGetAgent(
      req(`/v1/agents/${defAgent.id}`, acmeAdminKey),
      defAgent.id as string,
    );
    expect(crossGet.status).toBe(404);

    // Cross-tenant patch → 404.
    const crossPatch = await handleUpdateAgent(
      req(`/v1/agents/${defAgent.id}`, acmeAdminKey, { body: { name: "stolen" } }),
      defAgent.id as string,
    );
    expect(crossPatch.status).toBe(404);

    // Cross-tenant delete → 404.
    const crossDel = await handleDeleteAgent(
      req(`/v1/agents/${defAgent.id}`, acmeAdminKey, { method: "DELETE" }),
      defAgent.id as string,
    );
    expect(crossDel.status).toBe(404);
  });

  it("tenant user cannot create an agent in another tenant", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { handleCreateAgent, handleListAgents } = await import("../src/handlers/agents");

    // Body tenant_id is ignored for tenant users — their own tenant always wins.
    const res = await handleCreateAgent(
      req("/v1/agents", acmeAdminKey, {
        body: { name: "still-acme", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    );
    expect(res.status).toBe(201);

    // Now verify: the default-tenant admin should not see this agent.
    const { createApiKey } = await import("../src/db/api_keys");
    const def = createApiKey({
      name: "default-admin",
      permissions: { admin: true, scope: null },
      tenantId: "tenant_default",
      rawKey: "ck_test_default_admin_0001",
    });
    const defList = await readJson(
      await handleListAgents(req("/v1/agents", def.key)),
    );
    const names = (defList.data as Array<{ name: string }>).map(a => a.name);
    expect(names).not.toContain("still-acme");
  });
});

describe("v0.5 tenant enforcement — environments", () => {
  beforeEach(() => freshDbEnv());

  it("list + get are scoped; cross-tenant get → 404", async () => {
    const { globalKey, acmeAdminKey } = await bootTenants();
    const { handleListEnvironments, handleGetEnvironment } = await import(
      "../src/handlers/environments"
    );
    // Seed env rows directly in each tenant to avoid provider checks.
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");
    const db = getDb();
    const defEnvId = newId("env");
    const acmeEnvId = newId("env");
    const now = nowMs();
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'def-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_default', ?)`,
    ).run(defEnvId, now);
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'acme-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
    ).run(acmeEnvId, now);

    // Global admin sees both.
    const all = await readJson(
      await handleListEnvironments(req("/v1/environments", globalKey)),
    );
    const allIds = (all.data as Array<{ id: string }>).map(e => e.id);
    expect(allIds).toContain(defEnvId);
    expect(allIds).toContain(acmeEnvId);

    // Acme admin sees only their tenant.
    const acme = await readJson(
      await handleListEnvironments(req("/v1/environments", acmeAdminKey)),
    );
    const acmeIds = (acme.data as Array<{ id: string }>).map(e => e.id);
    expect(acmeIds).toContain(acmeEnvId);
    expect(acmeIds).not.toContain(defEnvId);

    // Acme admin cross-tenant GET → 404.
    const crossGet = await handleGetEnvironment(
      req(`/v1/environments/${defEnvId}`, acmeAdminKey),
      defEnvId,
    );
    expect(crossGet.status).toBe(404);
  });
});

describe("v0.5 tenant enforcement — sessions", () => {
  beforeEach(() => freshDbEnv());

  it("cross-tenant agent + env is refused with 400", async () => {
    const { globalKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");

    // Agent in default tenant, env in acme tenant — both created by the
    // global admin who can pick tenants.
    const agentRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "cross-a", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    );
    const agent = await readJson(agentRes);

    const envId = newId("env");
    getDb()
      .prepare(
        `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
         VALUES (?, 'other-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
      )
      .run(envId, nowMs());

    const res = await handleCreateSession(
      req("/v1/sessions", globalKey, {
        body: { agent: agent.id, environment_id: envId },
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    const err = body.error as { message: string };
    expect(err.message).toMatch(/different tenants/);
  });

  it("session create stamps tenant_id from the agent/env tenant", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateSession, handleListSessions } = await import(
      "../src/handlers/sessions"
    );
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");

    const agentRes = await handleCreateAgent(
      req("/v1/agents", acmeAdminKey, {
        body: { name: "acme-agent", model: "claude-sonnet-4-6" },
      }),
    );
    const agent = await readJson(agentRes);

    const envId = newId("env");
    getDb()
      .prepare(
        `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
         VALUES (?, 'acme-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
      )
      .run(envId, nowMs());

    const createRes = await handleCreateSession(
      req("/v1/sessions", acmeAdminKey, {
        body: { agent: agent.id, environment_id: envId },
      }),
    );
    expect(createRes.status).toBe(201);
    const session = await readJson(createRes);

    // Row-level check: tenant_id stamped onto sessions row.
    const row = getDb()
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .get(session.id) as { tenant_id: string | null };
    expect(row.tenant_id).toBe("tenant_acme");

    // A default-tenant admin should NOT see this session.
    const { createApiKey } = await import("../src/db/api_keys");
    const def = createApiKey({
      name: "default-admin",
      permissions: { admin: true, scope: null },
      tenantId: "tenant_default",
      rawKey: "ck_test_default_admin_sess",
    });
    const defList = await readJson(
      await handleListSessions(req("/v1/sessions", def.key)),
    );
    const defIds = (defList.data as Array<{ id: string }>).map(s => s.id);
    expect(defIds).not.toContain(session.id);
  });
});

describe("v0.5 tenant enforcement — api keys", () => {
  beforeEach(() => freshDbEnv());

  it("list is tenant-scoped; global admin sees all, tenant admin only own", async () => {
    const { globalKey, globalId, acmeAdminKey, acmeAdminId } = await bootTenants();
    const { handleListApiKeys } = await import("../src/handlers/api_keys");

    // Global admin: returns both keys (global-admin itself + acme-admin).
    const all = await readJson(await handleListApiKeys(req("/v1/api-keys", globalKey)));
    const allIds = (all.data as Array<{ id: string }>).map(r => r.id);
    expect(allIds).toContain(globalId);
    expect(allIds).toContain(acmeAdminId);

    // Acme admin: only the acme key shows up. Global-admin key (tenant=null)
    // is invisible to tenant users.
    const scoped = await readJson(await handleListApiKeys(req("/v1/api-keys", acmeAdminKey)));
    const scopedIds = (scoped.data as Array<{ id: string }>).map(r => r.id);
    expect(scopedIds).toContain(acmeAdminId);
    expect(scopedIds).not.toContain(globalId);
  });

  it("tenant admin cannot GET/PATCH/REVOKE another tenant's key (404)", async () => {
    const { globalId, acmeAdminKey } = await bootTenants();
    const { handleGetApiKey, handlePatchApiKey, handleRevokeApiKey } = await import(
      "../src/handlers/api_keys"
    );

    const get = await handleGetApiKey(
      req(`/v1/api-keys/${globalId}`, acmeAdminKey),
      globalId,
    );
    expect(get.status).toBe(404);

    const patch = await handlePatchApiKey(
      req(`/v1/api-keys/${globalId}`, acmeAdminKey, {
        method: "PATCH",
        body: { permissions: { admin: false, scope: null } },
      }),
      globalId,
    );
    expect(patch.status).toBe(404);

    const rev = await handleRevokeApiKey(
      req(`/v1/api-keys/${globalId}`, acmeAdminKey, { method: "DELETE" }),
      globalId,
    );
    expect(rev.status).toBe(404);
  });
});
