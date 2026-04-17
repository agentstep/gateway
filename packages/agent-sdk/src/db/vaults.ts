/**
 * Vault persistence: SQLite-backed key-value stores scoped to agents.
 *
 * Data persists across sessions. When `vault_ids` is set on a session,
 * the driver provisions vault data into the container at turn start.
 */
import { eq, and, asc, desc } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import { encryptValue, decryptValue } from "./vault-crypto";
import type { Vault, VaultEntry, VaultRow } from "../types";

function hydrateVault(row: VaultRow): Vault {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function createVault(input: {
  agent_id: string;
  name: string;
}): Vault {
  const db = getDrizzle();
  const id = newId("vault");
  const now = nowMs();

  db.insert(schema.vaults).values({
    id,
    agent_id: input.agent_id,
    name: input.name,
    created_at: now,
    updated_at: now,
  }).run();

  return getVault(id)!;
}

export function getVault(id: string): Vault | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.vaults)
    .where(eq(schema.vaults.id, id))
    .get() as VaultRow | undefined;
  return row ? hydrateVault(row) : null;
}

export function listVaults(opts: { agent_id?: string }): Vault[] {
  const db = getDrizzle();
  const query = db
    .select()
    .from(schema.vaults)
    .orderBy(desc(schema.vaults.created_at));

  if (opts.agent_id) {
    const rows = query
      .where(eq(schema.vaults.agent_id, opts.agent_id))
      .all() as VaultRow[];
    return rows.map(hydrateVault);
  }

  const rows = query.all() as VaultRow[];
  return rows.map(hydrateVault);
}

export function deleteVault(id: string): boolean {
  const db = getDrizzle();
  const res = db
    .delete(schema.vaults)
    .where(eq(schema.vaults.id, id))
    .run();
  return res.changes > 0;
}

export function setEntry(vaultId: string, key: string, value: string): void {
  const db = getDrizzle();
  const now = nowMs();
  const encrypted = encryptValue(value);

  db.insert(schema.vaultEntries)
    .values({ vault_id: vaultId, key, value: encrypted, updated_at: now })
    .onConflictDoUpdate({
      target: [schema.vaultEntries.vault_id, schema.vaultEntries.key],
      set: { value: encrypted, updated_at: now },
    })
    .run();

  // Update vault's updated_at timestamp
  db.update(schema.vaults)
    .set({ updated_at: now })
    .where(eq(schema.vaults.id, vaultId))
    .run();
}

export function getEntry(
  vaultId: string,
  key: string,
): VaultEntry | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.vaultEntries)
    .where(
      and(
        eq(schema.vaultEntries.vault_id, vaultId),
        eq(schema.vaultEntries.key, key),
      ),
    )
    .get();
  return row ? { key: row.key, value: decryptValue(row.value) } : null;
}

export function listEntries(vaultId: string): VaultEntry[] {
  const db = getDrizzle();
  const rows = db
    .select()
    .from(schema.vaultEntries)
    .where(eq(schema.vaultEntries.vault_id, vaultId))
    .orderBy(asc(schema.vaultEntries.key))
    .all();
  return rows.map((r) => ({ key: r.key, value: decryptValue(r.value) }));
}

export function deleteEntry(vaultId: string, key: string): boolean {
  const db = getDrizzle();
  const res = db
    .delete(schema.vaultEntries)
    .where(
      and(
        eq(schema.vaultEntries.vault_id, vaultId),
        eq(schema.vaultEntries.key, key),
      ),
    )
    .run();
  return res.changes > 0;
}
