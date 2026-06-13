/**
 * Automatic MCP OAuth refresh — expiring mcp_oauth credentials are
 * refreshed via the refresh_token grant before turns inject them.
 * The token endpoint is stubbed via global fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credref-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as Record<string, unknown>;
  for (const k of [
    "__caDb", "__caDrizzle", "__caInitialized", "__caInitPromise", "__caBusEmitters",
    "__caConfigCache", "__caRuntime", "__caActors",
  ]) delete g[k];
  if (g.__caSweeperHandle) { clearInterval(g.__caSweeperHandle as NodeJS.Timeout); delete g.__caSweeperHandle; }
  if (g.__caDeploymentsHandle) { clearInterval(g.__caDeploymentsHandle as NodeJS.Timeout); delete g.__caDeploymentsHandle; }
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedCredential(expiresAt: string | null) {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createVault } = await import("../src/db/vaults");
  const vault = createVault({ agent_id: null, name: `v-${Math.random()}`, tenant_id: null });
  const { createCredential } = await import("../src/db/credentials");
  const cred = createCredential({
    vault_id: vault.id,
    display_name: "linear",
    auth_type: "mcp_oauth",
    token: "old-access-token",
    mcp_server_url: "https://mcp.linear.app/mcp",
    expires_at: expiresAt,
    refresh_config: {
      refresh_token: "refresh-1",
      client_id: "client-1",
      token_endpoint: "https://auth.example.com/token",
      token_endpoint_auth: { type: "none" },
    } as never,
  });
  return { vault, cred };
}

describe("credential refresh", () => {
  beforeEach(() => freshDbEnv());

  it("refreshes an expired mcp_oauth credential and persists the new token", async () => {
    const { vault, cred } = await seedCredential(new Date(Date.now() - 60_000).toISOString());

    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({ access_token: "new-access-token", expires_in: 3600, refresh_token: "refresh-2" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { refreshExpiringCredentials } = await import("../src/sessions/credential-refresh");
    await refreshExpiringCredentials([vault.id]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://auth.example.com/token");
    expect(calls[0].body).toContain("grant_type=refresh_token");
    expect(calls[0].body).toContain("refresh_token=refresh-1");

    const { getCredentialToken, getRefreshConfig } = await import("../src/db/credentials");
    expect(getCredentialToken(cred.id)).toBe("new-access-token");
    // Rotated refresh token persisted for the next grant.
    expect(getRefreshConfig(cred.id)?.refresh_token).toBe("refresh-2");
  });

  it("leaves unexpired and no-expiry credentials alone", async () => {
    const { vault } = await seedCredential(new Date(Date.now() + 3_600_000).toISOString());
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const { refreshExpiringCredentials } = await import("../src/sessions/credential-refresh");
    await refreshExpiringCredentials([vault.id]);
    expect(fetchSpy).not.toHaveBeenCalled();

    const { vault: v2 } = await seedCredential(null); // no expiry recorded
    await refreshExpiringCredentials([v2.id]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a failing token endpoint is non-fatal and keeps the old token", async () => {
    const { vault, cred } = await seedCredential(new Date(Date.now() - 1000).toISOString());
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 400 })) as typeof fetch;

    const { refreshExpiringCredentials } = await import("../src/sessions/credential-refresh");
    await expect(refreshExpiringCredentials([vault.id])).resolves.toBeUndefined();

    const { getCredentialToken } = await import("../src/db/credentials");
    expect(getCredentialToken(cred.id)).toBe("old-access-token");
  });
});
