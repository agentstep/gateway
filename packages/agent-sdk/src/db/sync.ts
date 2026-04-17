/**
 * Anthropic sync table — maps local resource IDs to remote Anthropic IDs.
 *
 * Used by the sync-and-proxy flow: AgentStep manages config locally,
 * syncs to Anthropic at session start, then proxies execution traffic.
 */
import { eq, and } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { nowMs } from "../util/clock";

export type SyncResourceType = "agent" | "environment" | "vault" | "session";

interface SyncRow {
  local_id: string;
  resource_type: SyncResourceType;
  remote_id: string;
  synced_at: number;
  config_hash: string | null;
}

export function getSyncedRemoteId(localId: string, type: SyncResourceType): string | null {
  const db = getDrizzle();
  const row = db
    .select({ remote_id: schema.anthropicSync.remote_id })
    .from(schema.anthropicSync)
    .where(
      and(
        eq(schema.anthropicSync.local_id, localId),
        eq(schema.anthropicSync.resource_type, type),
      ),
    )
    .get();
  return row?.remote_id ?? null;
}

export function getSyncRow(localId: string, type: SyncResourceType): SyncRow | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.anthropicSync)
    .where(
      and(
        eq(schema.anthropicSync.local_id, localId),
        eq(schema.anthropicSync.resource_type, type),
      ),
    )
    .get();
  return (row as SyncRow | undefined) ?? null;
}

export function upsertSync(
  localId: string,
  type: SyncResourceType,
  remoteId: string,
  configHash?: string,
): void {
  const db = getDrizzle();
  db.insert(schema.anthropicSync)
    .values({
      local_id: localId,
      resource_type: type,
      remote_id: remoteId,
      synced_at: nowMs(),
      config_hash: configHash ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.anthropicSync.local_id, schema.anthropicSync.resource_type],
      set: {
        remote_id: remoteId,
        synced_at: nowMs(),
        config_hash: configHash ?? null,
      },
    })
    .run();
}

export function removeSync(localId: string, type: SyncResourceType): void {
  const db = getDrizzle();
  db.delete(schema.anthropicSync)
    .where(
      and(
        eq(schema.anthropicSync.local_id, localId),
        eq(schema.anthropicSync.resource_type, type),
      ),
    )
    .run();
}

/**
 * Resolve a local session ID to its remote Anthropic session ID.
 * For pure proxy sessions (where Anthropic assigned the ID), the local ID IS the remote ID.
 * For sync-and-proxy sessions, looks up the mapping in anthropic_sync.
 */
export function resolveRemoteSessionId(localSessionId: string): string {
  const remoteId = getSyncedRemoteId(localSessionId, "session");
  return remoteId ?? localSessionId;
}
