import crypto from "node:crypto";
import { eq, and, desc, isNull } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs } from "../util/clock";

export interface ApiKeyRow {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  permissions_json: string;
  created_at: number;
  revoked_at: number | null;
}

function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Create a new API key. Returns the full raw key string ONCE —
 * it is not stored in plain text and cannot be retrieved later.
 */
export function createApiKey(input: {
  name: string;
  permissions?: string[];
  rawKey?: string;
}): { key: string; id: string } {
  const db = getDrizzle();
  const id = newId("key");
  const raw = input.rawKey || `ck_${crypto.randomBytes(24).toString("base64url")}`;
  const hash = hashKey(raw);
  const prefix = raw.slice(0, 8);

  db.insert(schema.apiKeys)
    .values({
      id,
      name: input.name,
      hash,
      prefix,
      permissions_json: JSON.stringify(input.permissions ?? ["*"]),
      created_at: nowMs(),
    })
    .run();

  return { key: raw, id };
}

export function findByRawKey(raw: string): ApiKeyRow | null {
  const db = getDrizzle();
  const hash = hashKey(raw);
  const row = db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.hash, hash), isNull(schema.apiKeys.revoked_at)))
    .get();
  return (row as ApiKeyRow | undefined) ?? null;
}

export function revokeApiKey(id: string): boolean {
  const db = getDrizzle();
  const res = db
    .update(schema.apiKeys)
    .set({ revoked_at: nowMs() })
    .where(and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revoked_at)))
    .run();
  return res.changes > 0;
}

export function listApiKeys(): Array<Omit<ApiKeyRow, "hash">> {
  const db = getDrizzle();
  const rows = db
    .select()
    .from(schema.apiKeys)
    .where(isNull(schema.apiKeys.revoked_at))
    .orderBy(desc(schema.apiKeys.created_at))
    .all() as ApiKeyRow[];
  return rows.map(({ hash: _hash, ...rest }) => rest);
}
