/**
 * File metadata CRUD.
 *
 * Files are stored on disk (see files/storage.ts), metadata in SQLite.
 */
import { getDb } from "./client";
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
  const db = getDb();
  const id = newId("file");
  const now = nowMs();
  db.prepare(
    `INSERT INTO files (id, filename, size, content_type, storage_path, scope_type, scope_id, container_path, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.filename, input.size, input.content_type, input.storage_path, input.scope?.type ?? null, input.scope?.id ?? null, input.container_path ?? null, input.content_hash ?? null, now);
  return {
    id, filename: input.filename, size: input.size, content_type: input.content_type,
    scope: input.scope ?? null, created_at: toIso(now),
  };
}

export function findFileByContainerPath(scopeId: string, containerPath: string, contentHash: string): FileRow | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM files WHERE scope_id = ? AND container_path = ? AND content_hash = ?`,
  ).get(scopeId, containerPath, contentHash) as FileRow | undefined;
  return row ?? null;
}

export function getFile(id: string): FileRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined;
  return row ?? null;
}

export function getFileRecord(id: string): FileRecord | null {
  const row = getFile(id);
  return row ? hydrate(row) : null;
}

export function listFiles(opts?: { limit?: number; scope_id?: string }): FileRecord[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  // Deduplicate container-synced files: for files with the same container_path
  // in the same scope, only return the latest version (highest created_at).
  // Files without container_path (uploaded files) are always included.
  if (opts?.scope_id) {
    const rows = db.prepare(`
      SELECT f.* FROM files f
      LEFT JOIN files f2
        ON f.scope_id = f2.scope_id
        AND f.container_path = f2.container_path
        AND f.container_path IS NOT NULL
        AND f2.created_at > f.created_at
      WHERE f.scope_id = ? AND f2.id IS NULL
      ORDER BY f.created_at DESC LIMIT ?
    `).all(opts.scope_id, limit) as FileRow[];
    return rows.map(hydrate);
  }
  const rows = db.prepare(`SELECT * FROM files ORDER BY created_at DESC LIMIT ?`).all(limit) as FileRow[];
  return rows.map(hydrate);
}

export function deleteFileRecord(id: string): { id: string; type: string } | null {
  const db = getDb();
  const row = getFile(id);
  if (!row) return null;
  db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
  return { id, type: "file_deleted" };
}
