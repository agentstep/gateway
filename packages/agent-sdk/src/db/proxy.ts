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
import { getDb } from "./client";
import { nowMs } from "../util/clock";

export type ProxiedResourceType = "agent" | "environment" | "session";

export function isProxied(id: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT resource_id FROM proxy_resources WHERE resource_id = ?`,
    )
    .get(id) as { resource_id: string } | undefined;
  return !!row;
}

/**
 * Look up the tenant the resource was created under. Returns:
 *   - `undefined` → not a proxied resource at all
 *   - `null`      → legacy (pre-v0.5) row with no tenant stamped
 *   - string      → the tenant id
 */
export function getProxiedTenantId(id: string): string | null | undefined {
  const db = getDb();
  const row = db
    .prepare(`SELECT tenant_id FROM proxy_resources WHERE resource_id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

export function markProxied(
  id: string,
  type: ProxiedResourceType,
  tenantId: string | null = null,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO proxy_resources (resource_id, resource_type, tenant_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, type, tenantId, nowMs());
}

export function unmarkProxied(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM proxy_resources WHERE resource_id = ?`).run(id);
}
