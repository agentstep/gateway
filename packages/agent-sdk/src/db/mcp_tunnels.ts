/**
 * MCP tunnel registration storage.
 *
 * Each row is a long-lived credential a tunnel client uses to connect.
 * The raw token is returned once at creation; we persist only its sha256.
 * See src/mcp/tunnels.ts for the runtime registry and wire protocol.
 */
import crypto from "node:crypto";
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs } from "../util/clock";

export interface McpTunnelRow {
  id: string;
  name: string;
  token_hash: string;
  tenant_id: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Create a tunnel registration. The raw token is returned once and never
 * retrievable again.
 */
export function createMcpTunnel(input: {
  name: string;
  tenantId?: string | null;
}): { id: string; token: string } {
  const db = getDb();
  const id = newId("mtun");
  const token = `mtk_${crypto.randomBytes(24).toString("base64url")}`;
  db.prepare(
    `INSERT INTO mcp_tunnels (id, name, token_hash, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.name, hashToken(token), input.tenantId ?? null, nowMs());
  return { id, token };
}

export function listMcpTunnels(tenantId?: string | null): McpTunnelRow[] {
  const db = getDb();
  if (tenantId === undefined) {
    return db
      .prepare(`SELECT * FROM mcp_tunnels WHERE revoked_at IS NULL ORDER BY created_at DESC`)
      .all() as McpTunnelRow[];
  }
  return db
    .prepare(`SELECT * FROM mcp_tunnels WHERE revoked_at IS NULL AND tenant_id IS ? ORDER BY created_at DESC`)
    .all(tenantId) as McpTunnelRow[];
}

export function getMcpTunnel(id: string): McpTunnelRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM mcp_tunnels WHERE id = ?`).get(id) as McpTunnelRow | undefined;
  return row ?? null;
}

/**
 * Authenticate an incoming tunnel-connect request. Returns the row on
 * match (and bumps last_seen_at). Returns null on miss, revoked, or
 * token mismatch — callers must not leak which.
 */
export function authenticateTunnel(id: string, token: string): McpTunnelRow | null {
  const row = getMcpTunnel(id);
  if (!row || row.revoked_at) return null;
  const presented = hashToken(token);
  const stored = row.token_hash;
  if (presented.length !== stored.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(stored))) return null;
  touchTunnel(id);
  return { ...row, last_seen_at: nowMs() };
}

export function touchTunnel(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE mcp_tunnels SET last_seen_at = ? WHERE id = ?`).run(nowMs(), id);
}

export function revokeMcpTunnel(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE mcp_tunnels SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(nowMs(), id);
  return (res.changes ?? 0) > 0;
}
