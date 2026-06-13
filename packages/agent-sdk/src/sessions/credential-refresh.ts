/**
 * Automatic MCP OAuth refresh — Phase 3.1 of the credential model.
 *
 * mcp_oauth credentials carry an expiry and an encrypted refresh config
 * (refresh_token + token_endpoint + client auth). Until now refresh only
 * happened via the manual validate endpoint; this module refreshes
 * expiring credentials at turn time, so a session never injects a stale
 * token. Called by the driver before `loadSessionSecrets`.
 *
 * Failures are non-fatal: a credential that can't be refreshed is left
 * as-is (the MCP connection will surface the auth error), matching the
 * "invalid credentials don't block sessions" contract.
 */
import { getCredential, getRefreshConfig, listCredentialsWithTokens, updateCredential } from "../db/credentials";

/** Refresh when the token expires within this window (or already has). */
const EXPIRY_SKEW_MS = 5 * 60_000;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

/**
 * Refresh one mcp_oauth credential via the standard refresh_token grant.
 * Persists the new access token (and rotated refresh token, when the
 * endpoint returns one). Returns true when the credential was refreshed.
 */
export async function refreshCredential(credentialId: string): Promise<boolean> {
  const cred = getCredential(credentialId);
  if (!cred || cred.auth.type !== "mcp_oauth") return false;
  const config = getRefreshConfig(credentialId);
  if (!config) return false;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.client_id,
    refresh_token: config.refresh_token,
    ...(config.scope ? { scope: config.scope } : {}),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (config.token_endpoint_auth?.type === "client_secret_basic") {
    headers.Authorization = `Basic ${btoa(`${config.client_id}:${config.token_endpoint_auth.client_secret}`)}`;
  } else if (config.token_endpoint_auth?.client_secret) {
    body.set("client_secret", config.token_endpoint_auth.client_secret);
  }

  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.warn(
      `[credentials] refresh failed for ${credentialId}: ${res.status} ${errText.slice(0, 200)}`,
    );
    return false;
  }

  const token = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!token?.access_token) {
    console.warn(`[credentials] refresh for ${credentialId} returned no access_token`);
    return false;
  }

  updateCredential(credentialId, {
    token: token.access_token,
    expires_at: token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : undefined,
    // Some providers rotate the refresh token on every grant.
    ...(token.refresh_token
      ? { refresh_config: { ...config, refresh_token: token.refresh_token } }
      : {}),
  });
  return true;
}

function isExpiring(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry recorded — assume long-lived
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t - Date.now() <= EXPIRY_SKEW_MS;
}

/**
 * Refresh every expiring mcp_oauth credential in the given vaults.
 * Best-effort and bounded (15s per token endpoint); errors are logged,
 * never thrown — the turn proceeds with whatever tokens exist.
 */
export async function refreshExpiringCredentials(vaultIds: string[]): Promise<void> {
  for (const vid of vaultIds) {
    for (const cred of listCredentialsWithTokens(vid)) {
      if (cred.auth.type !== "mcp_oauth") continue;
      if (!isExpiring(cred.auth.expires_at)) continue;
      try {
        const ok = await refreshCredential(cred.id);
        if (ok) console.log(`[credentials] refreshed expiring mcp_oauth credential ${cred.id}`);
      } catch (err) {
        console.warn(`[credentials] refresh threw for ${cred.id}:`, err);
      }
    }
  }
}
