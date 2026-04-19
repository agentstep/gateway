/**
 * File metadata CRUD.
 *
 * Files are stored on disk (see files/storage.ts), metadata in SQLite.
 */
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";

export interface FileRow {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  storage_path: string;
  scope_type: string | null;
  scope_id: string | null;
  container_path: string | null;
  content_hash: string | null;
  created_at: number;
}

export interface FileScope {
  type: "session";
  id: string;
}

export interface FileRecord {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  scope: FileScope | null;
  created_at: string;
}

function hydrate(row: FileRow): FileRecord {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    content_type: row.content_type,
    scope: row.scope_type && row.scope_id ? { type: row.scope_type as "session", id: row.scope_id } : null,
    created_at: toIso(row.created_at),
  };
}

export function createFile(input: {
  filename: string;
  size: number;
  content_type: string;
  storage_path: string;
  scope?: FileScope;
  container_path?: string;
  content_hash?: string;
}): FileRecord {
  const db = getDrizzle();
  const id = newId("file");
  const now = nowMs();
  db.insert(schema.files)
    .values({
      id,
      filename: input.filename,
      size: input.size,
      content_type: input.content_type,
      storage_path: input.storage_path,
      scope_type: input.scope?.type ?? null,
      scope_id: input.scope?.id ?? null,
      container_path: input.container_path ?? null,
      content_hash: input.content_hash ?? null,
      created_at: now,
    })
    .run();
  return {
    id, filename: input.filename, size: input.size, content_type: input.content_type,
    scope: input.scope ?? null, created_at: toIso(now),
  };
}

export function findFileByContainerPath(scopeId: string, containerPath: string, contentHash: string): FileRow | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.files)
    .where(
      and(
        eq(schema.files.scope_id, scopeId),
        eq(schema.files.container_path, containerPath),
        eq(schema.files.content_hash, contentHash),
      ),
    )
    .get();
  return (row as FileRow | undefined) ?? null;
}

export function getFile(id: string): FileRow | null {
  const db = getDrizzle();
  const row = db.select().from(schema.files).where(eq(schema.files.id, id)).get();
  return (row as FileRow | undefined) ?? null;
}

export function getFileRecord(id: string): FileRecord | null {
  const row = getFile(id);
  return row ? hydrate(row) : null;
}

export function listFiles(opts?: { limit?: number; scope_id?: string }): FileRecord[] {
  const db = getDrizzle();
  const limit = opts?.limit ?? 100;
  // Deduplicate container-synced files: for files with the same container_path
  // in the same scope, only return the latest version (highest created_at).
  // Files without container_path (uploaded files) are always included.
  if (opts?.scope_id) {
    // Use raw SQL for the self-join dedup query — Drizzle's query builder
    // doesn't support LEFT JOIN with the IS NULL anti-join pattern cleanly.
    const rawDb = db as unknown as { all: (sql: string, ...params: unknown[]) => unknown[] };
    // Fall back to the Drizzle prepare() method which is available on the underlying DB.
    const rows = db.all(
      sql`SELECT f.* FROM files f
        LEFT JOIN files f2
          ON f.scope_id = f2.scope_id
          AND f.container_path = f2.container_path
          AND f.container_path IS NOT NULL
          AND f2.created_at > f.created_at
        WHERE f.scope_id = ${opts.scope_id} AND f2.id IS NULL
        ORDER BY f.created_at DESC LIMIT ${limit}`,
    ) as FileRow[];
    return rows.map(hydrate);
  }
  const rows = db.select().from(schema.files).orderBy(desc(schema.files.created_at)).limit(limit).all();
  return (rows as FileRow[]).map(hydrate);
}

export function updateFileStoragePath(id: string, storagePath: string): void {
  const db = getDrizzle();
  db.update(schema.files)
    .set({ storage_path: storagePath })
    .where(eq(schema.files.id, id))
    .run();
}

export function deleteFileRecord(id: string): { id: string; type: string } | null {
  const db = getDrizzle();
  const row = getFile(id);
  if (!row) return null;
  db.delete(schema.files).where(eq(schema.files.id, id)).run();
  return { id, type: "file_deleted" };
}
