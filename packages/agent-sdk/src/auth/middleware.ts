/**
 * Authentication middleware.
 *
 * Extracts an API key from `x-api-key` (preferred per Managed Agents spec)
 * or `Authorization: Bearer <token>`.
 *
 * Two key spaces:
 *
 *   - Gateway keys (`ck_*` shape) — hashed with sha256 and looked up in
 *     the local `api_keys` table. Returns a normal AuthContext.
 *
 *   - Anthropic API keys (`sk-ant-api*` shape) — when
 *     `anthropic_passthrough_enabled` is true, returns a passthrough
 *     AuthContext that routeWrap forwards directly to Anthropic. Never
 *     compared against the local table; the prefix dispatch ensures the
 *     two spaces can't collide.
 *
 * `sk-ant-oat*` (OAuth tokens) do NOT enter the passthrough path — they
 * fall through to the gateway lookup and 401 (matching the existing
 * anthropic-provider posture in `handlers/sessions.ts`).
 */
import { findByRawKey, hydratePermissions } from "../db/api_keys";
import { getConfig } from "../config";
import { isAnthropicApiKey } from "./passthrough";
import type { AuthContext } from "../types";
import { unauthorized } from "../errors";

export function extractKey(request: Request): string | null {
  const xKey = request.headers.get("x-api-key");
  if (xKey && xKey.length > 0) return xKey;

  const auth = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

export async function authenticate(request: Request): Promise<AuthContext> {
  const key = extractKey(request);
  if (!key) throw unauthorized();

  // Shape-based dispatch: sk-ant-api* keys are *never* looked up in the
  // local api_keys table — they're either passthrough (when enabled) or
  // rejected. This eliminates the "lookup miss reveals which keys exist"
  // side channel and makes the two key spaces strictly disjoint.
  if (isAnthropicApiKey(key)) {
    if (!getConfig().anthropicPassthroughEnabled) throw unauthorized();
    return {
      keyId: "passthrough",
      name: "anthropic-passthrough",
      permissions: { admin: false, scope: null },
      tenantId: null,
      isGlobalAdmin: false,
      budgetUsd: null,
      rateLimitRpm: null,
      spentUsd: 0,
      mode: "passthrough",
      passthroughKey: key,
    };
  }

  const row = findByRawKey(key);
  if (!row) throw unauthorized();

  const permissions = hydratePermissions(row.permissions_json);
  return {
    keyId: row.id,
    name: row.name,
    permissions,
    tenantId: row.tenant_id,
    // Global admin: null tenant + admin bit. Legacy ["*"] keys hydrate
    // as {admin: true, scope: null} with tenantId still null, so they
    // remain global admins across a 0.4 → 0.5 upgrade. This is the
    // documented default; `gateway tenants migrate-legacy` is the
    // explicit step that changes it.
    isGlobalAdmin: row.tenant_id === null && permissions.admin,
    budgetUsd: row.budget_usd ?? null,
    rateLimitRpm: row.rate_limit_rpm ?? null,
    spentUsd: row.spent_usd ?? 0,
    mode: "gateway",
  };
}
