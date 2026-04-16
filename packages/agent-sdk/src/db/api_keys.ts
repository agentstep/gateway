import crypto from "node:crypto";
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs } from "../util/clock";
import type { KeyPermissions, KeyScope } from "../types";

export interface ApiKeyRow {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  permissions_json: string;
  tenant_id: string | null;
  /** Null = unlimited. Checked in the driver pre-turn (see PR3). */
  budget_usd: number | null;
  /** Null = unlimited. Fixed 60s window enforced in routeWrap. */
  rate_limit_rpm: number | null;
  /** Running total. Transactionally updated with session usage. */
  spent_usd: number;
  created_at: number;
  revoked_at: number | null;
}

function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Parse a `permissions_json` column value into a `KeyPermissions` object.
 *
 * Legacy backcompat: pre-0.4 rows stored a string array like `["*"]`. Those
 * keys were unconditional admins. Map that shape to `{admin: true, scope: null}`
 * on read. Keys stored without an admin field also default to non-admin so
 * freshly-created scoped keys don't accidentally gain admin rights.
 */
export function hydratePermissions(json: string): KeyPermissions {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      // Legacy shape: `["*"]` = admin + unrestricted. Any other shape is a
      // pre-0.4 key we treat conservatively as admin (only global admins
      // existed pre-0.4, so this is the right call).
      return { admin: true, scope: null };
    }
    if (parsed && typeof parsed === "object") {
      const admin = parsed.admin === true;
      const scope = parsed.scope && typeof parsed.scope === "object"
        ? normalizeScope(parsed.scope)
        : null;
      return { admin, scope };
    }
  } catch {
    // Corrupt JSON — fall through to safe default.
  }
  return { admin: false, scope: null };
}

function normalizeScope(raw: Record<string, unknown>): KeyScope {
  const list = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
  };
  return {
    agents: list(raw.agents),
    environments: list(raw.environments),
    vaults: list(raw.vaults),
  };
}

/**
 * Create a new API key. Returns the full raw key string ONCE —
 * it is not stored in plain text and cannot be retrieved later.
 */
export function createApiKey(input: {
  name: string;
  /** v0.4+: full permissions object. Legacy callers may still pass a string array. */
  permissions?: KeyPermissions | string[];
  /** Reserved for v0.5 tenant isolation. Accepted but not enforced in v0.4. */
  tenantId?: string | null;
  /** Null = unlimited. */
  budgetUsd?: number | null;
  /** Null = unlimited. */
  rateLimitRpm?: number | null;
  rawKey?: string;
}): { key: string; id: string } {
  const db = getDb();
  const id = newId("key");
  const raw = input.rawKey || `ck_${crypto.randomBytes(24).toString("base64url")}`;
  const hash = hashKey(raw);
  const prefix = raw.slice(0, 8);

  // Serialize permissions: prefer the new object shape; fall back to legacy
  // array for backward compat with any external caller still using the old
  // signature. Both forms hydrate to a `KeyPermissions` on read.
  const permissionsJson = input.permissions == null
    ? JSON.stringify({ admin: true, scope: null })   // default: admin key
    : Array.isArray(input.permissions)
      ? JSON.stringify(input.permissions)            // legacy string array
      : JSON.stringify(input.permissions);           // new object shape

  db.prepare(
    `INSERT INTO api_keys (id, name, hash, prefix, permissions_json, tenant_id, budget_usd, rate_limit_rpm, spent_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    input.name,
    hash,
    prefix,
    permissionsJson,
    input.tenantId ?? null,
    input.budgetUsd ?? null,
    input.rateLimitRpm ?? null,
    nowMs(),
  );

  return { key: raw, id };
}

/**
 * Increment the running spent_usd for a key. Intended to be called *inside*
 * an existing `db.transaction(...)` block alongside the session usage bump —
 * so a crash between the two writes can't cause under-reporting.
 *
 * No-op when keyId is null (unattributed sessions).
 */
export function bumpKeySpent(keyId: string | null | undefined, deltaUsd: number): void {
  if (!keyId || !Number.isFinite(deltaUsd) || deltaUsd === 0) return;
  const db = getDb();
  db.prepare(`UPDATE api_keys SET spent_usd = spent_usd + ? WHERE id = ?`).run(deltaUsd, keyId);
}

/** Admin: reset a key's running total to zero (e.g. monthly reset). */
export function resetKeySpent(keyId: string): boolean {
  const db = getDb();
  const res = db.prepare(`UPDATE api_keys SET spent_usd = 0 WHERE id = ?`).run(keyId);
  return res.changes > 0;
}

/** Admin: patch budget / rate limit on an existing key. Pass null to clear. */
export function updateApiKeyLimits(
  id: string,
  limits: { budgetUsd?: number | null; rateLimitRpm?: number | null },
): boolean {
  const db = getDb();
  const parts: string[] = [];
  const args: Array<number | null> = [];
  if ("budgetUsd" in limits) {
    parts.push("budget_usd = ?");
    args.push(limits.budgetUsd ?? null);
  }
  if ("rateLimitRpm" in limits) {
    parts.push("rate_limit_rpm = ?");
    args.push(limits.rateLimitRpm ?? null);
  }
  if (parts.length === 0) return false;
  const res = db
    .prepare(`UPDATE api_keys SET ${parts.join(", ")} WHERE id = ? AND revoked_at IS NULL`)
    .run(...args, id);
  return res.changes > 0;
}

export function findByRawKey(raw: string): ApiKeyRow | null {
  const db = getDb();
  const hash = hashKey(raw);
  return (
    (db
      .prepare(
        `SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL`,
      )
      .get(hash) as ApiKeyRow | undefined) ?? null
  );
}

export function getApiKeyById(id: string): ApiKeyRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM api_keys WHERE id = ?`)
      .get(id) as ApiKeyRow | undefined) ?? null
  );
}

export function revokeApiKey(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(nowMs(), id);
  return res.changes > 0;
}

export function updateApiKeyPermissions(id: string, permissions: KeyPermissions): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE api_keys SET permissions_json = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(JSON.stringify(permissions), id);
  return res.changes > 0;
}

/**
 * Safe-to-expose listing — strips the hash, hydrates permissions. The
 * `tenant_id` field passes through but is unused by v0.4 handlers.
 */
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  permissions: KeyPermissions;
  tenant_id: string | null;
  budget_usd: number | null;
  rate_limit_rpm: number | null;
  spent_usd: number;
  created_at: number;
}

function toView(r: ApiKeyRow): ApiKeyView {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    permissions: hydratePermissions(r.permissions_json),
    tenant_id: r.tenant_id,
    budget_usd: r.budget_usd,
    rate_limit_rpm: r.rate_limit_rpm,
    spent_usd: r.spent_usd ?? 0,
    created_at: r.created_at,
  };
}

export function listApiKeys(): ApiKeyView[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .all() as ApiKeyRow[];
  return rows.map(toView);
}

export { toView as apiKeyToView };
