import { createHash } from "node:crypto";
import { eq, and, asc, desc, like, or, sql, lt } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { MemoryStore, MemoryStoreRow, Memory, MemoryRow, MemoryVersion, MemoryVersionRow } from "../types";

function hydrateStore(row: MemoryStoreRow): MemoryStore {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    agent_id: row.agent_id,
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function hydrateVersion(row: MemoryVersionRow): MemoryVersion {
  const v: MemoryVersion = {
    type: "memory_version",
    id: row.id,
    memory_store_id: row.store_id,
    memory_id: row.memory_id,
    path: row.path,
    operation: row.operation as "create" | "update" | "delete",
    created_at: toIso(row.created_at),
  };
  if (row.content != null) v.content = row.content;
  if (row.content_sha256 != null) v.content_sha256 = row.content_sha256;
  if (row.session_id != null) v.session_id = row.session_id;
  if (row.redacted_at != null) v.redacted_at = toIso(row.redacted_at);
  return v;
}

function hydrateMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    store_id: row.store_id,
    path: row.path,
    content: row.content,
    content_sha256: row.content_sha256,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Memory Stores ────────────────────────────────────────────────────────

export function createMemoryStore(input: {
  name: string;
  description?: string | null;
  agent_id?: string | null;
}): MemoryStore {
  const db = getDrizzle();
  const id = newId("memstore");
  const now = nowMs();
  db.insert(schema.memoryStores)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      agent_id: input.agent_id ?? null,
      created_at: now,
      updated_at: now,
    })
    .run();
  return getMemoryStore(id)!;
}

export function getMemoryStore(id: string): MemoryStore | null {
  const db = getDrizzle();
  const row = db.select().from(schema.memoryStores).where(eq(schema.memoryStores.id, id)).get();
  return row ? hydrateStore(row as MemoryStoreRow) : null;
}

export function listMemoryStores(opts: {
  agent_id?: string;
  /** v0.5 tenancy: filter by agent's tenant. Requires a JOIN. */
  tenantFilter?: string | null;
} = {}): MemoryStore[] {
  const db = getDrizzle();

  // When tenantFilter is set, we need a JOIN through agents to check tenant.
  // Stores without an agent (legacy null agent_id) are excluded from
  // tenant-filtered queries.
  if (opts.tenantFilter != null) {
    if (opts.agent_id) {
      const rows = db.all(
        sql`SELECT ms.* FROM memory_stores ms LEFT JOIN agents a ON a.id = ms.agent_id WHERE ms.agent_id = ${opts.agent_id} AND a.tenant_id = ${opts.tenantFilter} ORDER BY ms.created_at DESC`,
      ) as MemoryStoreRow[];
      return rows.map(hydrateStore);
    }
    const rows = db.all(
      sql`SELECT ms.* FROM memory_stores ms LEFT JOIN agents a ON a.id = ms.agent_id WHERE a.tenant_id = ${opts.tenantFilter} ORDER BY ms.created_at DESC`,
    ) as MemoryStoreRow[];
    return rows.map(hydrateStore);
  }

  // Simple case: no tenant filter
  if (opts.agent_id) {
    const rows = db.select().from(schema.memoryStores)
      .where(eq(schema.memoryStores.agent_id, opts.agent_id))
      .orderBy(desc(schema.memoryStores.created_at))
      .all();
    return (rows as MemoryStoreRow[]).map(hydrateStore);
  }

  const rows = db.select().from(schema.memoryStores).orderBy(desc(schema.memoryStores.created_at)).all();
  return (rows as MemoryStoreRow[]).map(hydrateStore);
}

export function deleteMemoryStore(id: string): boolean {
  const db = getDrizzle();
  const res = db.delete(schema.memoryStores).where(eq(schema.memoryStores.id, id)).run();
  return res.changes > 0;
}

// ── Memories ─────────────────────────────────────────────────────────────

export function createOrUpsertMemory(storeId: string, path: string, content: string, sessionId?: string): Memory {
  const db = getDrizzle();
  const hash = sha256(content);
  const now = nowMs();
  const id = newId("mem");

  // Check if this is an update (existing memory at this path)
  const existing = getMemoryByPath(storeId, path);
  const isUpdate = !!existing;

  db.insert(schema.memories)
    .values({
      id,
      store_id: storeId,
      path,
      content,
      content_sha256: hash,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [schema.memories.store_id, schema.memories.path],
      set: {
        content,
        content_sha256: hash,
        updated_at: now,
      },
    })
    .run();

  const memory = getMemoryByPath(storeId, path)!;

  // Track version
  createMemoryVersion({
    storeId,
    memoryId: memory.id,
    operation: isUpdate ? "update" : "create",
    path,
    content,
    contentSha256: hash,
    sessionId,
  });

  return memory;
}

export function getMemory(id: string): Memory | null {
  const db = getDrizzle();
  const row = db.select().from(schema.memories).where(eq(schema.memories.id, id)).get();
  return row ? hydrateMemory(row as MemoryRow) : null;
}

export function getMemoryByPath(storeId: string, path: string): Memory | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.memories)
    .where(and(eq(schema.memories.store_id, storeId), eq(schema.memories.path, path)))
    .get();
  return row ? hydrateMemory(row as MemoryRow) : null;
}

export function listMemories(storeId: string): Memory[] {
  const db = getDrizzle();
  const rows = db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.store_id, storeId))
    .orderBy(asc(schema.memories.path))
    .all();
  return (rows as MemoryRow[]).map(hydrateMemory);
}

export function searchMemories(storeId: string, query: string): Memory[] {
  const db = getDrizzle();
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const pattern = `%${escaped}%`;
  const rows = db
    .select()
    .from(schema.memories)
    .where(
      and(
        eq(schema.memories.store_id, storeId),
        or(
          like(schema.memories.path, pattern),
          like(schema.memories.content, pattern),
        ),
      ),
    )
    .orderBy(asc(schema.memories.path))
    .all();
  return (rows as MemoryRow[]).map(hydrateMemory);
}

export function updateMemory(
  id: string,
  content: string,
  preconditionSha256?: string,
  sessionId?: string,
): { memory: Memory | null; conflict: boolean } {
  const db = getDrizzle();
  const existing = getMemory(id);
  if (!existing) return { memory: null, conflict: false };

  if (preconditionSha256 && existing.content_sha256 !== preconditionSha256) {
    return { memory: null, conflict: true };
  }

  const hash = sha256(content);
  const now = nowMs();
  db.update(schema.memories)
    .set({ content, content_sha256: hash, updated_at: now })
    .where(eq(schema.memories.id, id))
    .run();

  const memory = getMemory(id)!;

  // Track version
  createMemoryVersion({
    storeId: existing.store_id,
    memoryId: id,
    operation: "update",
    path: existing.path,
    content,
    contentSha256: hash,
    sessionId,
  });

  return { memory, conflict: false };
}

export function deleteMemory(id: string, sessionId?: string): boolean {
  const db = getDrizzle();
  // Capture memory info before deletion for version tracking
  const existing = getMemory(id);

  const res = db.delete(schema.memories).where(eq(schema.memories.id, id)).run();

  if (res.changes > 0 && existing) {
    createMemoryVersion({
      storeId: existing.store_id,
      memoryId: id,
      operation: "delete",
      path: existing.path,
      sessionId,
    });
  }

  return res.changes > 0;
}

// ── Memory Versions ─────────────────────────────────────────────────

export function createMemoryVersion(opts: {
  storeId: string;
  memoryId: string;
  operation: "create" | "update" | "delete";
  path: string;
  content?: string;
  contentSha256?: string;
  sessionId?: string;
}): string {
  const db = getDrizzle();
  const id = newId("memver");
  const now = nowMs();

  db.insert(schema.memoryVersions)
    .values({
      id,
      store_id: opts.storeId,
      memory_id: opts.memoryId,
      operation: opts.operation,
      path: opts.path,
      content: opts.content ?? null,
      content_sha256: opts.contentSha256 ?? null,
      session_id: opts.sessionId ?? null,
      created_at: now,
    })
    .run();

  return id;
}

export function listMemoryVersions(storeId: string, opts?: {
  memoryId?: string;
  limit?: number;
  cursor?: string;
}): MemoryVersion[] {
  const db = getDrizzle();
  const limit = opts?.limit ?? 100;

  const conditions = [eq(schema.memoryVersions.store_id, storeId)];
  if (opts?.memoryId) {
    conditions.push(eq(schema.memoryVersions.memory_id, opts.memoryId));
  }
  if (opts?.cursor) {
    conditions.push(lt(schema.memoryVersions.id, opts.cursor));
  }

  const rows = db
    .select()
    .from(schema.memoryVersions)
    .where(and(...conditions))
    .orderBy(desc(schema.memoryVersions.created_at), desc(schema.memoryVersions.id))
    .limit(limit)
    .all();

  return (rows as MemoryVersionRow[]).map(hydrateVersion);
}

export function getMemoryVersion(storeId: string, versionId: string): MemoryVersion | undefined {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.memoryVersions)
    .where(
      and(
        eq(schema.memoryVersions.store_id, storeId),
        eq(schema.memoryVersions.id, versionId),
      ),
    )
    .get();

  return row ? hydrateVersion(row as MemoryVersionRow) : undefined;
}

export function updateMemoryStore(id: string, fields: { name?: string; description?: string; metadata?: Record<string, string> }): MemoryStore | undefined {
  const db = getDrizzle();
  const now = nowMs();
  const parts: Record<string, unknown> = { updated_at: now };
  if (fields.name !== undefined) parts.name = fields.name;
  if (fields.description !== undefined) parts.description = fields.description;
  if (fields.metadata !== undefined) parts.metadata_json = JSON.stringify(fields.metadata);
  const res = db.update(schema.memoryStores)
    .set(parts)
    .where(eq(schema.memoryStores.id, id))
    .run();
  if (res.changes === 0) return undefined;
  return getMemoryStore(id) ?? undefined;
}

export function redactMemoryVersion(storeId: string, versionId: string): boolean {
  const db = getDrizzle();
  // Check version exists and belongs to store
  const version = db
    .select()
    .from(schema.memoryVersions)
    .where(
      and(
        eq(schema.memoryVersions.store_id, storeId),
        eq(schema.memoryVersions.id, versionId),
      ),
    )
    .get() as MemoryVersionRow | undefined;
  if (!version) return false;

  // Check it's not the current head of a live memory
  if (version.memory_id && version.content_sha256) {
    const memory = getMemory(version.memory_id);
    if (memory && memory.content_sha256 === version.content_sha256) {
      return false; // Cannot redact the current head version
    }
  }

  const now = nowMs();
  db.run(
    sql`UPDATE memory_versions SET content = NULL, content_sha256 = NULL, redacted_at = ${now} WHERE id = ${versionId} AND store_id = ${storeId}`,
  );
  return true;
}

export function archiveMemoryStore(id: string): boolean {
  const db = getDrizzle();
  const now = nowMs();
  const res = db.update(schema.memoryStores)
    .set({ archived_at: now, updated_at: now })
    .where(eq(schema.memoryStores.id, id))
    .run();
  return res.changes > 0;
}
