/**
 * Scheduled deployments — DB layer. A deployment fires sessions on a cron
 * cadence; every trigger attempt (scheduled or manual) writes a
 * deployment_run record carrying the created session_id or a typed error.
 */
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";

export interface DeploymentRow {
  id: string;
  name: string;
  agent_id: string;
  agent_version: number | null;
  environment_id: string;
  initial_events_json: string;
  schedule_expression: string;
  schedule_timezone: string;
  session_config_json: string | null;
  status: "active" | "paused" | "archived";
  paused_reason_json: string | null;
  last_fired_minute: string | null;
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface Deployment {
  type: "deployment";
  id: string;
  name: string;
  agent: { type: "agent"; id: string; version: number | null };
  environment_id: string;
  initial_events: unknown[];
  schedule: {
    type: "cron";
    expression: string;
    timezone: string;
    last_fired_minute: string | null;
    upcoming_runs_at?: string[];
  };
  status: string;
  paused_reason: unknown | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface DeploymentRunRow {
  id: string;
  deployment_id: string;
  trigger_type: "schedule" | "manual";
  scheduled_at: number | null;
  session_id: string | null;
  error_type: string | null;
  error_message: string | null;
  agent_id: string | null;
  agent_version: number | null;
  tenant_id: string | null;
  created_at: number;
}

export function rowToDeployment(row: DeploymentRow): Deployment {
  return {
    type: "deployment",
    id: row.id,
    name: row.name,
    agent: { type: "agent", id: row.agent_id, version: row.agent_version },
    environment_id: row.environment_id,
    initial_events: JSON.parse(row.initial_events_json) as unknown[],
    schedule: {
      type: "cron",
      expression: row.schedule_expression,
      timezone: row.schedule_timezone,
      last_fired_minute: row.last_fired_minute,
    },
    status: row.status,
    paused_reason: row.paused_reason_json ? JSON.parse(row.paused_reason_json) : null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: row.archived_at != null ? toIso(row.archived_at) : null,
  };
}

export function rowToDeploymentRun(row: DeploymentRunRow): Record<string, unknown> {
  return {
    type: "deployment_run",
    id: row.id,
    deployment_id: row.deployment_id,
    trigger_context:
      row.trigger_type === "schedule"
        ? { type: "schedule", scheduled_at: row.scheduled_at != null ? toIso(row.scheduled_at) : null }
        : { type: "manual" },
    session_id: row.session_id,
    error: row.error_type ? { type: row.error_type, message: row.error_message ?? "" } : null,
    agent: row.agent_id ? { type: "agent", id: row.agent_id, version: row.agent_version } : null,
    created_at: toIso(row.created_at),
  };
}

export function createDeployment(input: {
  name: string;
  agent_id: string;
  agent_version?: number | null;
  environment_id: string;
  initial_events: unknown[];
  schedule_expression: string;
  schedule_timezone?: string;
  session_config?: Record<string, unknown> | null;
  tenant_id?: string | null;
}): DeploymentRow {
  const now = nowMs();
  const row: DeploymentRow = {
    id: newId("depl"),
    name: input.name,
    agent_id: input.agent_id,
    agent_version: input.agent_version ?? null,
    environment_id: input.environment_id,
    initial_events_json: JSON.stringify(input.initial_events),
    schedule_expression: input.schedule_expression,
    schedule_timezone: input.schedule_timezone ?? "UTC",
    session_config_json: input.session_config ? JSON.stringify(input.session_config) : null,
    status: "active",
    paused_reason_json: null,
    last_fired_minute: null,
    tenant_id: input.tenant_id ?? null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO deployments (id, name, agent_id, agent_version, environment_id, initial_events_json,
        schedule_expression, schedule_timezone, session_config_json, status, paused_reason_json,
        last_fired_minute, tenant_id, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.name, row.agent_id, row.agent_version, row.environment_id, row.initial_events_json,
      row.schedule_expression, row.schedule_timezone, row.session_config_json, row.status,
      row.paused_reason_json, row.last_fired_minute, row.tenant_id, row.created_at, row.updated_at,
      row.archived_at,
    );
  return row;
}

export function getDeployment(id: string): DeploymentRow | undefined {
  return getDb().prepare(`SELECT * FROM deployments WHERE id = ?`).get(id) as DeploymentRow | undefined;
}

export function listDeployments(opts: { tenantId?: string | null; includeArchived?: boolean } = {}): DeploymentRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeArchived) clauses.push(`status != 'archived'`);
  if (opts.tenantId !== undefined && opts.tenantId !== null) {
    clauses.push(`(tenant_id = ? OR tenant_id IS NULL)`);
    params.push(opts.tenantId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT * FROM deployments ${where} ORDER BY created_at DESC`)
    .all(...params) as DeploymentRow[];
}

export function listActiveDeployments(): DeploymentRow[] {
  return getDb().prepare(`SELECT * FROM deployments WHERE status = 'active'`).all() as DeploymentRow[];
}

export function setDeploymentStatus(
  id: string,
  status: "active" | "paused" | "archived",
  pausedReason?: unknown,
): void {
  getDb()
    .prepare(
      `UPDATE deployments SET status = ?, paused_reason_json = ?, updated_at = ?,
        archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END WHERE id = ?`,
    )
    .run(status, pausedReason ? JSON.stringify(pausedReason) : null, nowMs(), status, nowMs(), id);
}

export function setDeploymentFiredMinute(id: string, minuteKey: string): void {
  getDb()
    .prepare(`UPDATE deployments SET last_fired_minute = ?, updated_at = ? WHERE id = ?`)
    .run(minuteKey, nowMs(), id);
}

export function createDeploymentRun(input: {
  deployment_id: string;
  trigger_type: "schedule" | "manual";
  scheduled_at?: number | null;
  session_id?: string | null;
  error_type?: string | null;
  error_message?: string | null;
  agent_id?: string | null;
  agent_version?: number | null;
  tenant_id?: string | null;
}): DeploymentRunRow {
  const row: DeploymentRunRow = {
    id: newId("drun"),
    deployment_id: input.deployment_id,
    trigger_type: input.trigger_type,
    scheduled_at: input.scheduled_at ?? null,
    session_id: input.session_id ?? null,
    error_type: input.error_type ?? null,
    error_message: input.error_message ?? null,
    agent_id: input.agent_id ?? null,
    agent_version: input.agent_version ?? null,
    tenant_id: input.tenant_id ?? null,
    created_at: nowMs(),
  };
  getDb()
    .prepare(
      `INSERT INTO deployment_runs (id, deployment_id, trigger_type, scheduled_at, session_id,
        error_type, error_message, agent_id, agent_version, tenant_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.deployment_id, row.trigger_type, row.scheduled_at, row.session_id,
      row.error_type, row.error_message, row.agent_id, row.agent_version, row.tenant_id, row.created_at,
    );
  return row;
}

export function listDeploymentRuns(
  deploymentId: string,
  opts: { hasError?: boolean; limit?: number } = {},
): DeploymentRunRow[] {
  const clauses = [`deployment_id = ?`];
  const params: unknown[] = [deploymentId];
  if (opts.hasError === true) clauses.push(`error_type IS NOT NULL`);
  if (opts.hasError === false) clauses.push(`error_type IS NULL`);
  return getDb()
    .prepare(
      `SELECT * FROM deployment_runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, opts.limit ?? 100) as DeploymentRunRow[];
}
