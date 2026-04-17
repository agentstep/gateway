/**
 * Proxy routing table: tracks which resource IDs belong to Anthropic's
 * hosted Managed Agents API. The route handlers check `isProxied(id)`
 * before touching local state — if true, they forward to Anthropic.
 *
 * Anthropic owns the IDs (they're assigned by their API on create). We
 * store them in this table after a successful proxy-create so subsequent
 * requests for that ID auto-route without the client needing to specify
 * anything.
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

export function markProxied(id: string, type: ProxiedResourceType): void {
  const db = getDrizzle();
  db.insert(schema.proxyResources)
    .values({ resource_id: id, resource_type: type, created_at: nowMs() })
    .onConflictDoNothing()
    .run();
}

export function unmarkProxied(id: string): void {
  const db = getDrizzle();
  db.delete(schema.proxyResources)
    .where(eq(schema.proxyResources.resource_id, id))
    .run();
}
