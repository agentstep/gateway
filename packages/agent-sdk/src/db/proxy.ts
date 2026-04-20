/**
 * Proxy routing table: tracks which resource IDs belong to Anthropic's
 * hosted Managed Agents API. The route handlers check `isProxied(id)`
 * before touching local state — if true, they forward to Anthropic.
 *
 * Anthropic owns the IDs (they're assigned by their API on create). We
 * store them in this table after a successful proxy-create so subsequent
 * requests for that ID auto-route without the client needing to specify
 * anything.
 *
 * v0.5: `tenant_id` is captured at mark time so cross-tenant access
 * checks work for sessions/agents/envs that have no local mirror row.
 * Legacy rows written before v0.5 have null here; they're treated as
 * global-admin-only for safety.
 */
import { eq } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { nowMs } from "../util/clock";

export type ProxiedResourceType = "agent" | "environment" | "session";

export function isProxied(id: string): boolean {
  const db = getDrizzle();
  const row = db
    .select({ resource_id: schema.proxyResources.resource_id })
    .from(schema.proxyResources)
    .where(eq(schema.proxyResources.resource_id, id))
    .get();
  return !!row;
}

/**
 * Look up the tenant the resource was created under. Returns:
 *   - `undefined` → not a proxied resource at all
 *   - `null`      → legacy (pre-v0.5) row with no tenant stamped
 *   - string      → the tenant id
 */
export function getProxiedTenantId(id: string): string | null | undefined {
  const db = getDrizzle();
  const row = db
    .select({ tenant_id: schema.proxyResources.tenant_id })
    .from(schema.proxyResources)
    .where(eq(schema.proxyResources.resource_id, id))
    .get();
  if (!row) return undefined;
  return row.tenant_id;
}

export function markProxied(
  id: string,
  type: ProxiedResourceType,
  tenantId: string | null = null,
): void {
  const db = getDrizzle();
  db.insert(schema.proxyResources)
    .values({ resource_id: id, resource_type: type, tenant_id: tenantId, created_at: nowMs() })
    .onConflictDoNothing()
    .run();
}

export function unmarkProxied(id: string): void {
  const db = getDrizzle();
  db.delete(schema.proxyResources)
    .where(eq(schema.proxyResources.resource_id, id))
    .run();
}
