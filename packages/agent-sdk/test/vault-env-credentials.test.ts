// @ts-nocheck — test file with loose typing on handler responses
/**
 * environment_variable vault credentials: API shape + secret injection.
 *
 * Mirrors the Anthropic Managed Agents credential type:
 *   auth: { type: "environment_variable", secret_name, secret_value, networking? }
 * secret_value is write-only; injection happens via loadSessionSecrets
 * under the declared secret_name.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-envcred-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  delete g.__caActors;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  if (g.__caDeploymentSchedulerHandle) {
    clearInterval(g.__caDeploymentSchedulerHandle as NodeJS.Timeout);
    delete g.__caDeploymentSchedulerHandle;
  }
}

async function bootDb(): Promise<void> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
}

function req(url: string, opts: { method?: string; body?: unknown } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-api-key": "test-api-key-12345" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function createTestVault(): Promise<Record<string, unknown>> {
  const { handleCreateVault } = await import("../src/handlers/anthropic-compat/vaults");
  const res = await handleCreateVault(req("/anthropic/v1/vaults", { body: { display_name: "Alice" } }));
  return await res.json();
}

const ENV_AUTH = {
  type: "environment_variable",
  secret_name: "NOTION_API_KEY",
  secret_value: "sk-secret-notion-value",
  networking: { type: "limited", allowed_hosts: ["api.notion.com"] },
};

async function createEnvCredential(
  vaultId: string,
  overrides: Record<string, unknown> = {},
  displayName = "Notion API key for sandbox",
): Promise<Response> {
  const { handleCreateCredential } = await import("../src/handlers/anthropic-compat/credentials");
  return handleCreateCredential(
    req(`/anthropic/v1/vaults/${vaultId}/credentials`, {
      body: { display_name: displayName, auth: { ...ENV_AUTH, ...overrides } },
    }),
    vaultId,
  );
}

beforeEach(async () => {
  freshDbEnv();
  await bootDb();
});

describe("create environment_variable credential", () => {
  it("creates and returns the auth shape without the secret value", async () => {
    const vault = await createTestVault();
    const res = await createEnvCredential(vault.id);
    expect(res.status).toBe(201);
    const cred = await res.json();
    expect(cred.type).toBe("vault_credential");
    expect(cred.auth).toEqual({
      type: "environment_variable",
      secret_name: "NOTION_API_KEY",
      networking: { type: "limited", allowed_hosts: ["api.notion.com"] },
    });
    expect(JSON.stringify(cred)).not.toContain("sk-secret-notion-value");
  });

  it("accepts unrestricted networking and no networking at all", async () => {
    const vault = await createTestVault();
    const r1 = await createEnvCredential(vault.id, {
      secret_name: "KEY_ONE",
      networking: { type: "unrestricted" },
    }, "Key one");
    expect((await r1.json()).auth.networking).toEqual({ type: "unrestricted" });
    const r2 = await createEnvCredential(vault.id, { secret_name: "KEY_TWO", networking: undefined }, "Key two");
    expect((await r2.json()).auth.networking).toBeNull();
  });

  it("rejects invalid env var names and reserved keys", async () => {
    const vault = await createTestVault();
    expect((await createEnvCredential(vault.id, { secret_name: "BAD-NAME" })).status).toBe(400);
    expect((await createEnvCredential(vault.id, { secret_name: "1LEADING" })).status).toBe(400);
    expect((await createEnvCredential(vault.id, { secret_name: "PATH" })).status).toBe(400);
    expect((await createEnvCredential(vault.id, { secret_name: "LD_PRELOAD" })).status).toBe(400);
  });

  it("409s on duplicate secret_name among active credentials; archiving frees it", async () => {
    const { handleArchiveCredential } = await import("../src/handlers/anthropic-compat/credentials");
    const vault = await createTestVault();
    const first = await (await createEnvCredential(vault.id)).json();

    const dup = await createEnvCredential(vault.id, undefined);
    expect(dup.status).toBe(409);

    await handleArchiveCredential(req(`/x`, { method: "POST" }), vault.id, first.id);
    const replacement = await createEnvCredential(vault.id);
    expect(replacement.status).toBe(409); // display_name still collides
    const replacement2 = await (async () => {
      const { handleCreateCredential } = await import("../src/handlers/anthropic-compat/credentials");
      return handleCreateCredential(
        req(`/anthropic/v1/vaults/${vault.id}/credentials`, {
          body: { display_name: "Notion key v2", auth: ENV_AUTH },
        }),
        vault.id,
      );
    })();
    expect(replacement2.status).toBe(201);
  });
});

describe("update environment_variable credential", () => {
  it("rotates secret_value and updates networking, keeps secret_name", async () => {
    const { handleUpdateCredential } = await import("../src/handlers/anthropic-compat/credentials");
    const vault = await createTestVault();
    const cred = await (await createEnvCredential(vault.id)).json();

    const updated = await (await handleUpdateCredential(
      req(`/x`, {
        body: {
          auth: {
            type: "environment_variable",
            secret_value: "sk-rotated-value",
            networking: { type: "unrestricted" },
          },
        },
      }),
      vault.id,
      cred.id,
    )).json();
    expect(updated.auth.secret_name).toBe("NOTION_API_KEY");
    expect(updated.auth.networking).toEqual({ type: "unrestricted" });

    const { getCredentialToken } = await import("../src/db/credentials");
    expect(getCredentialToken(cred.id)).toBe("sk-rotated-value");
  });

  it("rejects secret_name changes (immutable key)", async () => {
    const { handleUpdateCredential } = await import("../src/handlers/anthropic-compat/credentials");
    const vault = await createTestVault();
    const cred = await (await createEnvCredential(vault.id)).json();

    const res = await handleUpdateCredential(
      req(`/x`, { body: { auth: { type: "environment_variable", secret_name: "OTHER_NAME" } } }),
      vault.id,
      cred.id,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("immutable");
  });

  it("rejects auth type changes", async () => {
    const { handleUpdateCredential } = await import("../src/handlers/anthropic-compat/credentials");
    const vault = await createTestVault();
    const cred = await (await createEnvCredential(vault.id)).json();

    const res = await handleUpdateCredential(
      req(`/x`, { body: { auth: { type: "static_bearer", token: "tok" } } }),
      vault.id,
      cred.id,
    );
    expect(res.status).toBe(400);
  });
});

describe("secret injection", () => {
  it("loadSessionSecrets exposes the secret under secret_name", async () => {
    const vault = await createTestVault();
    await createEnvCredential(vault.id);

    const { loadSessionSecrets } = await import("../src/sessions/secrets");
    const secrets = loadSessionSecrets([vault.id]);
    const notion = secrets.find((s) => s.key === "NOTION_API_KEY");
    expect(notion).toBeDefined();
    expect(notion.value).toBe("sk-secret-notion-value");
    // No MCP_AUTH_* or CREDENTIAL_* aliases for env-var credentials
    expect(secrets.some((s) => s.key.startsWith("MCP_AUTH_"))).toBe(false);
    expect(secrets.some((s) => s.key.startsWith("CREDENTIAL_"))).toBe(false);
  });

  it("skips archived env-var credentials", async () => {
    const { handleArchiveCredential } = await import("../src/handlers/anthropic-compat/credentials");
    const vault = await createTestVault();
    const cred = await (await createEnvCredential(vault.id)).json();
    await handleArchiveCredential(req(`/x`, { method: "POST" }), vault.id, cred.id);

    const { loadSessionSecrets } = await import("../src/sessions/secrets");
    const secrets = loadSessionSecrets([vault.id]);
    expect(secrets.find((s) => s.key === "NOTION_API_KEY")).toBeUndefined();
  });
});
