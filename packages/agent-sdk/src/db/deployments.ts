/**
 * Scheduled deployments: run an agent's sessions on a cron schedule.
 *
 * A deployment pins the session configuration (agent, environment,
 * initial events, vaults) plus a cron schedule. Each trigger attempt —
 * scheduled or manual — writes a deployment_runs row carrying either the
 * created session_id or an error describing why session creation was
 * rejected. `next_run_at` is precomputed on every state change so the
 * scheduler tick is a single indexed range scan.
 */
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";

export type DeploymentStatus = "active" | "paused" | "archived";

export interface DeploymentPausedReason {
  type: "manual" | "agent_archived";
}

export interface DeploymentRow {
  id: string;
  name: string;
  agent_id: string;
  environment_id: string;
  initial_events_json: string;
  cron_expression: string;
  timezone: string;
  status: DeploymentStatus;
  paused_reason_json: string | null;
  vault_ids_json: string | null;
  metadata_json: string;
  last_run_at: number | null;
  next_run_at: number | null;
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface DeploymentRunRow {
  id: string;
  deployment_id: string;
  trigger_type: "schedule" | "manual";
  scheduled_at: number | null;
  session_id: string | null;
  error_type: string | null;
  error_message: string | null;
  agent_id: string;
  agent_version: number;
  tenant_id: string | null;
  created_at: number;
}

/** Public API shape (Anthropic Managed Agents compatible). */
export interface Deployment {
  type: "deployment";
  id: string;
  name: string;
  agent: { type: "agent"; id: string };
  environment_id: string;
  initial_events: unknown[];
  vault_ids: string[];
  metadata: Record<string, unknown>;
  status: DeploymentStatus;
  paused_reason: DeploymentPausedReason | null;
  schedule: {
    type: "cron";
    expression: string;
    timezone: string;
    last_run_at: string | null;
    upcoming_runs_at: string[];
  };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface DeploymentRun {
  type: "deployment_run";
  id: string;
  deployment_id: string;
  trigger_context:
    | { type: "schedule"; scheduled_at: string | null }
    | { type: "manual" };
  session_id: string | null;
  error: { type: string; message: string } | null;
  agent: { type: "agent"; id: string; version: number };
  created_at: string;
}

export function hydrateDeployment(row: DeploymentRow, upcomingRunsAt: number[] = []): Deployment {
  return {
    type: "deployment",
    id: row.id,
    name: row.name,
    agent: { type: "agent", id: row.agent_id },
    environment_id: row.environment_id,
    initial_events: JSON.parse(row.initial_events_json) as unknown[],
    vault_ids: row.vault_ids_json ? (JSON.parse(row.vault_ids_json) as string[]) : [],
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    status: row.status,
    paused_reason: row.paused_reason_json
      ? (JSON.parse(row.paused_reason_json) as DeploymentPausedReason)
      : null,
    schedule: {
      type: "cron",
      expression: row.cron_expression,
      timezone: row.timezone,
      last_run_at: row.last_run_at ? toIso(row.last_run_at) : null,
      upcoming_runs_at: upcomingRunsAt.map(toIso),
    },
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
  };
}

export function hydrateDeploymentRun(row: DeploymentRunRow): DeploymentRun {
  return {
    type: "deployment_run",
    id: row.id,
    deployment_id: row.deployment_id,
    trigger_context:
      row.trigger_type === "manual"
        ? { type: "manual" }
        : { type: "schedule", scheduled_at: row.scheduled_at ? toIso(row.scheduled_at) : null },
    session_id: row.session_id,
    error: row.error_type
      ? { type: row.error_type, message: row.error_message ?? "" }
      : null,
    agent: { type: "agent", id: row.agent_id, version: row.agent_version },
    created_at: toIso(row.created_at),
  };
}

export function createDeployment(input: {
  name: string;
  agent_id: string;
  environment_id: string;
  initial_events: unknown[];
  cron_expression: string;
  timezone: string;
  vault_ids?: string[] | null;
  metadata?: Record<string, unknown>;
  next_run_at: number | null;
  tenant_id?: string | null;
}): DeploymentRow {
  const db = getDb();
  const id = newId("depl");
  const now = nowMs();
  db.prepare(
    `INSERT INTO deployments (id, name, agent_id, environment_id, initial_events_json, cron_expression, timezone, status, vault_ids_json, metadata_json, next_run_at, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.agent_id,
    input.environment_id,
    JSON.stringify(input.initial_events),
    input.cron_expression,
    input.timezone,
    input.vault_ids ? JSON.stringify(input.vault_ids) : null,
    JSON.stringify(input.metadata ?? {}),
    input.next_run_at,
    input.tenant_id ?? null,
    now,
    now,
  );
  return getDeploymentRow(id)!;
}

export function getDeploymentRow(id: string): DeploymentRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(id) as DeploymentRow | undefined;
  return row ?? null;
}

export function getDeploymentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM deployments WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

export function listDeploymentRows(opts: {
  tenantFilter?: string | null;
  includeArchived?: boolean;
} = {}): DeploymentRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (!opts.includeArchived) conditions.push("archived_at IS NULL");
  if (opts.tenantFilter !== undefined && opts.tenantFilter !== null) {
    conditions.push("tenant_id = ?");
    args.push(opts.tenantFilter);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM deployments ${where} ORDER BY created_at DESC`)
    .all(...args) as DeploymentRow[];
}

/** Active deployments whose next fire time has passed. */
export function listDueDeployments(now: number): DeploymentRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM deployments WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?`,
    )
    .all(now) as DeploymentRow[];
}

export function setDeploymentStatus(
  id: string,
  status: DeploymentStatus,
  pausedReason: DeploymentPausedReason | null,
): void {
  const db = getDb();
  const now = nowMs();
  db.prepare(
    `UPDATE deployments SET status = ?, paused_reason_json = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END, updated_at = ? WHERE id = ?`,
  ).run(status, pausedReason ? JSON.stringify(pausedReason) : null, status, now, now, id);
}

export function setDeploymentNextRun(id: string, nextRunAt: number | null, lastRunAt?: number): void {
  const db = getDb();
  const now = nowMs();
  if (lastRunAt !== undefined) {
    db.prepare(`UPDATE deployments SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?`)
      .run(nextRunAt, lastRunAt, now, id);
  } else {
    db.prepare(`UPDATE deployments SET next_run_at = ?, updated_at = ? WHERE id = ?`)
      .run(nextRunAt, now, id);
  }
}

export function createDeploymentRun(input: {
  deployment_id: string;
  trigger_type: "schedule" | "manual";
  scheduled_at?: number | null;
  session_id?: string | null;
  error_type?: string | null;
  error_message?: string | null;
  agent_id: string;
  agent_version: number;
  tenant_id?: string | null;
}): DeploymentRunRow {
  const db = getDb();
  const id = newId("drun");
  const now = nowMs();
  db.prepare(
    `INSERT INTO deployment_runs (id, deployment_id, trigger_type, scheduled_at, session_id, error_type, error_message, agent_id, agent_version, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.deployment_id,
    input.trigger_type,
    input.scheduled_at ?? null,
    input.session_id ?? null,
    input.error_type ?? null,
    input.error_message ?? null,
    input.agent_id,
    input.agent_version,
    input.tenant_id ?? null,
    now,
  );
  return db.prepare(`SELECT * FROM deployment_runs WHERE id = ?`).get(id) as DeploymentRunRow;
}

export function listDeploymentRunRows(opts: {
  deploymentId?: string;
  hasError?: boolean;
  tenantFilter?: string | null;
}): DeploymentRunRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (opts.deploymentId) {
    conditions.push("deployment_id = ?");
    args.push(opts.deploymentId);
  }
  if (opts.hasError === true) conditions.push("error_type IS NOT NULL");
  if (opts.hasError === false) conditions.push("error_type IS NULL");
  if (opts.tenantFilter !== undefined && opts.tenantFilter !== null) {
    conditions.push("tenant_id = ?");
    args.push(opts.tenantFilter);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM deployment_runs ${where} ORDER BY created_at DESC`)
    .all(...args) as DeploymentRunRow[];
}
