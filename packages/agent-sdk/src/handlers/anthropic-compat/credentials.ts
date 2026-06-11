/**
 * HTTP handlers for vault credentials (Anthropic-compatible structured auth).
 *
 * Credentials wrap a secret token with metadata. Secret fields are NEVER
 * returned in API responses -- only the auth shape (type + mcp_server_url,
 * and for mcp_oauth, expires_at) is exposed.
 *
 * Supported auth types:
 *   - static_bearer: simple token-based auth
 *   - mcp_oauth: OAuth 2.0 for MCP servers with optional refresh config
 *   - environment_variable: named env var injected into the sandbox.
 *     Unlike Anthropic's hosted sandboxes (egress substitution), the
 *     gateway injects the real value into the container environment;
 *     `networking` is stored and surfaced but enforcement is delegated
 *     to the environment-level networking policy.
 */
import { z } from "zod";
import { routeWrap, jsonOk, paginatedOk, parseLimit } from "../../http";
import { loadVaultForCaller } from "./vaults";
import {
  createCredential,
  getCredential,
  getRefreshConfig,
  listCredentials,
  updateCredential,
  deleteCredential,
  archiveCredential,
  findActiveCredentialBySecretName,
} from "../../db/credentials";
import type { OAuthRefreshConfig } from "../../db/credentials";
import { BLOCKED_ENV_KEYS } from "../../providers/resolve-secrets";
import { badRequest, notFound, conflict } from "../../errors";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TokenEndpointAuthSchema = z.object({
  type: z.string().min(1),
  client_secret: z.string().min(1),
});

const OAuthRefreshSchema = z.object({
  token_endpoint: z.string().url(),
  client_id: z.string().min(1),
  scope: z.string().optional(),
  refresh_token: z.string().min(1),
  token_endpoint_auth: TokenEndpointAuthSchema.optional(),
});

const StaticBearerAuthSchema = z.object({
  type: z.literal("static_bearer"),
  mcp_server_url: z.string().url().optional(),
  token: z.string().min(1),
});

const McpOauthAuthSchema = z.object({
  type: z.literal("mcp_oauth"),
  mcp_server_url: z.string().url().optional(),
  access_token: z.string().min(1),
  expires_at: z.string().optional(),
  refresh: OAuthRefreshSchema.optional(),
});

const CredentialNetworkingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("limited"), allowed_hosts: z.array(z.string().min(1)).max(100) }),
  z.object({ type: z.literal("unrestricted") }),
]);

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const EnvironmentVariableAuthSchema = z.object({
  type: z.literal("environment_variable"),
  secret_name: z.string().min(1).max(200).regex(ENV_VAR_NAME_RE, "secret_name must be a valid environment variable name"),
  secret_value: z.string().min(1),
  networking: CredentialNetworkingSchema.optional(),
});

const CreateCredentialSchema = z.object({
  display_name: z.string().min(1).max(200),
  auth: z.discriminatedUnion("type", [StaticBearerAuthSchema, McpOauthAuthSchema, EnvironmentVariableAuthSchema]),
  metadata: z.record(z.string()).optional(),
});

const UpdateStaticBearerAuthSchema = z.object({
  type: z.literal("static_bearer").optional(),
  token: z.string().min(1).optional(),
  mcp_server_url: z.string().url().nullish(),
});

const UpdateMcpOauthAuthSchema = z.object({
  type: z.literal("mcp_oauth").optional(),
  access_token: z.string().min(1).optional(),
  expires_at: z.string().nullish(),
  refresh: OAuthRefreshSchema.optional(),
});

/** Generic auth update schema -- used for initial parsing. We refine by existing credential type. */
const UpdateAuthSchema = z.object({
  type: z.enum(["static_bearer", "mcp_oauth", "environment_variable"]).optional(),
  token: z.string().min(1).optional(),
  mcp_server_url: z.string().url().nullish(),
  access_token: z.string().min(1).optional(),
  expires_at: z.string().nullish(),
  refresh: OAuthRefreshSchema.optional(),
  secret_name: z.string().optional(),
  secret_value: z.string().min(1).optional(),
  networking: CredentialNetworkingSchema.nullish(),
}).optional();

const UpdateCredentialSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  auth: UpdateAuthSchema,
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleCreateCredential(
  request: Request,
  vaultId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    const body = await request.json();
    const parsed = CreateCredentialSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const { auth: authData } = parsed.data;

    try {
      if (authData.type === "environment_variable") {
        if (BLOCKED_ENV_KEYS.has(authData.secret_name)) {
          throw badRequest(`secret_name "${authData.secret_name}" is a reserved environment variable`);
        }
        // secret_name must be unique among active credentials in the vault
        if (findActiveCredentialBySecretName(vaultId, authData.secret_name)) {
          throw conflict(
            `An active credential with secret_name "${authData.secret_name}" already exists in this vault`,
          );
        }
        const cred = createCredential({
          vault_id: vaultId,
          display_name: parsed.data.display_name,
          auth_type: "environment_variable",
          token: authData.secret_value,
          secret_name: authData.secret_name,
          networking: authData.networking ?? null,
        });
        return jsonOk(cred, 201);
      }

      if (authData.type === "mcp_oauth") {
        const refreshConfig: OAuthRefreshConfig | null = authData.refresh
          ? {
              token_endpoint: authData.refresh.token_endpoint,
              client_id: authData.refresh.client_id,
              scope: authData.refresh.scope,
              refresh_token: authData.refresh.refresh_token,
              token_endpoint_auth: authData.refresh.token_endpoint_auth,
            }
          : null;
        const cred = createCredential({
          vault_id: vaultId,
          display_name: parsed.data.display_name,
          auth_type: "mcp_oauth",
          token: authData.access_token,
          mcp_server_url: authData.mcp_server_url ?? null,
          expires_at: authData.expires_at ?? null,
          refresh_config: refreshConfig,
        });
        return jsonOk(cred, 201);
      }

      // static_bearer
      const cred = createCredential({
        vault_id: vaultId,
        display_name: parsed.data.display_name,
        auth_type: "static_bearer",
        token: authData.token,
        mcp_server_url: authData.mcp_server_url ?? null,
      });
      return jsonOk(cred, 201);
    } catch (err) {
      // UNIQUE constraint on (vault_id, display_name)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed") || msg.includes("SQLITE_CONSTRAINT")) {
        throw conflict(
          `Credential "${parsed.data.display_name}" already exists in this vault`,
        );
      }
      throw err;
    }
  });
}

export function handleListCredentials(
  request: Request,
  vaultId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    const url = new URL(req.url);
    const requestedLimit = parseLimit(url.searchParams.get("limit"), 100);
    const data = listCredentials(vaultId);
    return paginatedOk(data, requestedLimit);
  });
}

export function handleGetCredential(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    const cred = getCredential(credentialId);
    if (!cred || cred.vault_id !== vaultId) {
      throw notFound(`credential not found: ${credentialId}`);
    }
    return jsonOk(cred);
  });
}

export function handleUpdateCredential(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    // Verify the credential belongs to this vault
    const existing = getCredential(credentialId);
    if (!existing || existing.vault_id !== vaultId) {
      throw notFound(`credential not found: ${credentialId}`);
    }

    const body = await request.json();
    const parsed = UpdateCredentialSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    try {
      const authData = parsed.data.auth;

      if (existing.auth.type === "environment_variable") {
        if (authData?.type && authData.type !== "environment_variable") {
          throw badRequest("credential auth type cannot be changed; archive and create a new credential");
        }
        // secret_name is immutable after creation (matches upstream semantics)
        if (authData?.secret_name !== undefined && authData.secret_name !== existing.auth.secret_name) {
          throw badRequest("secret_name is immutable; archive the credential and create a new one");
        }
        const updated = updateCredential(credentialId, {
          display_name: parsed.data.display_name,
          token: authData?.secret_value,
          networking: authData?.networking === undefined ? undefined : authData.networking,
        });
        if (!updated) throw notFound(`credential not found: ${credentialId}`);
        return jsonOk(updated);
      }

      // Use existing credential's auth type to interpret update fields
      const isMcpOauth = existing.auth.type === "mcp_oauth" ||
        authData?.type === "mcp_oauth";

      if (isMcpOauth && authData) {
        // mcp_oauth update fields
        const refreshConfig: OAuthRefreshConfig | undefined = authData.refresh
          ? {
              token_endpoint: authData.refresh.token_endpoint,
              client_id: authData.refresh.client_id,
              scope: authData.refresh.scope,
              refresh_token: authData.refresh.refresh_token,
              token_endpoint_auth: authData.refresh.token_endpoint_auth,
            }
          : undefined;
        const updated = updateCredential(credentialId, {
          display_name: parsed.data.display_name,
          auth_type: authData.type,
          token: authData.access_token,
          expires_at: authData.expires_at,
          refresh_config: refreshConfig,
        });
        if (!updated) throw notFound(`credential not found: ${credentialId}`);
        return jsonOk(updated);
      }

      // static_bearer update fields
      const updated = updateCredential(credentialId, {
        display_name: parsed.data.display_name,
        auth_type: authData?.type,
        token: authData?.token,
        mcp_server_url: authData?.mcp_server_url,
      });
      if (!updated) throw notFound(`credential not found: ${credentialId}`);
      return jsonOk(updated);
    } catch (err) {
      if (err instanceof Error && (err.message.includes("UNIQUE constraint failed") || err.message.includes("SQLITE_CONSTRAINT"))) {
        throw conflict(
          `Credential "${parsed.data.display_name}" already exists in this vault`,
        );
      }
      throw err;
    }
  });
}

export function handleArchiveCredential(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    const cred = archiveCredential(vaultId, credentialId);
    if (!cred) throw notFound(`credential not found: ${credentialId}`);
    return jsonOk(cred);
  });
}

export function handleDeleteCredential(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    // Verify the credential belongs to this vault
    const existing = getCredential(credentialId);
    if (!existing || existing.vault_id !== vaultId) {
      throw notFound(`credential not found: ${credentialId}`);
    }

    const deleted = deleteCredential(credentialId);
    if (!deleted) throw notFound(`credential not found: ${credentialId}`);
    return jsonOk({ id: credentialId, type: "vault_credential_deleted" });
  });
}

export function handleMcpOauthValidate(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    const cred = getCredential(credentialId);
    if (!cred || cred.vault_id !== vaultId) throw notFound(`credential not found: ${credentialId}`);
    if (cred.auth.type !== "mcp_oauth") {
      throw badRequest("credential is not mcp_oauth type");
    }

    const config = getRefreshConfig(credentialId);
    if (!config) throw badRequest("credential has no refresh configuration");

    // Call the token endpoint to validate the refresh token
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

    try {
      const res = await fetch(config.token_endpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        return jsonOk({
          type: "mcp_oauth_validation_result",
          credential_id: credentialId,
          valid: true,
        });
      }
      const errText = await res.text().catch(() => "");
      return jsonOk({
        type: "mcp_oauth_validation_result",
        credential_id: credentialId,
        valid: false,
        error: `token endpoint returned ${res.status}: ${errText.slice(0, 200)}`,
      });
    } catch (err) {
      return jsonOk({
        type: "mcp_oauth_validation_result",
        credential_id: credentialId,
        valid: false,
        error: err instanceof Error ? err.message : "token endpoint unreachable",
      });
    }
  });
}
