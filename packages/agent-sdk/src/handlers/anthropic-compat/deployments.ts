/**
 * HTTP handlers for scheduled deployments (Anthropic Managed Agents
 * compatible): create / list / get, pause / unpause / archive lifecycle,
 * manual run, and the deployment_runs listing.
 *
 * Schedule semantics: POSIX cron expression + IANA timezone, minute
 * granularity, literal wall-clock DST matching. The scheduler tick lives
 * in sessions/deployments.ts; these handlers only manage rows and
 * delegate manual runs to the same trigger path.
 */
import { z } from "zod";
import { routeWrap, jsonOk, paginatedOk, parseLimit } from "../../http";
import { badRequest, notFound, conflict } from "../../errors";
import type { AuthContext } from "../../types";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../../auth/scope";
import { getDb } from "../../db/client";
import { getAgent } from "../../db/agents";
import { getEnvironment } from "../../db/environments";
import {
  createDeployment,
  getDeploymentRow,
  getDeploymentTenantId,
  listDeploymentRows,
  listDeploymentRunRows,
  setDeploymentStatus,
  setDeploymentNextRun,
  hydrateDeployment,
  hydrateDeploymentRun,
  type DeploymentRow,
} from "../../db/deployments";
import { parseCronExpression, nextFireTimes, assertValidTimezone } from "../../util/cron";
import { computeNextRunAt, triggerDeployment } from "../../sessions/deployments";
import { nowMs } from "../../util/clock";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
});

const InitialEventSchema = z.object({
  type: z.literal("user.message"),
  content: z.array(TextBlockSchema).min(1),
});

const ScheduleSchema = z.object({
  type: z.literal("cron"),
  expression: z.string().min(1),
  timezone: z.string().min(1),
});

const CreateDeploymentSchema = z.object({
  name: z.string().min(1).max(200),
  agent: z.string().min(1),
  environment_id: z.string().min(1),
  initial_events: z.array(InitialEventSchema).min(1),
  schedule: ScheduleSchema,
  vault_ids: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  tenant_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function loadDeploymentForCaller(auth: AuthContext, id: string): DeploymentRow {
  const tenantId = getDeploymentTenantId(id);
  if (tenantId === undefined) throw notFound(`deployment not found: ${id}`);
  assertResourceTenant(auth, tenantId, `deployment not found: ${id}`);
  return getDeploymentRow(id)!;
}

function getAgentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM agents WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

function getEnvironmentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM environments WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

/** Serialize a row with its next three fire times. */
function serialize(row: DeploymentRow): ReturnType<typeof hydrateDeployment> {
  let upcoming: number[] = [];
  if (row.status === "active") {
    try {
      const schedule = parseCronExpression(row.cron_expression);
      upcoming = nextFireTimes(schedule, row.timezone, nowMs(), 3);
    } catch { /* unparseable legacy row — surface without upcoming runs */ }
  }
  return hydrateDeployment(row, upcoming);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleCreateDeployment(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json();
    const parsed = CreateDeploymentSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const data = parsed.data;

    // Validate the schedule up front so a bad expression 400s at create.
    try {
      parseCronExpression(data.schedule.expression);
      assertValidTimezone(data.schedule.timezone);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }

    // Tenant-scoped agent + environment validation (404 cross-tenant).
    const agentTenant = getAgentTenantId(data.agent);
    if (agentTenant === undefined) throw notFound(`agent ${data.agent} not found`);
    assertResourceTenant(auth, agentTenant, `agent ${data.agent} not found`);
    const agent = getAgent(data.agent);
    if (!agent) throw notFound(`agent ${data.agent} not found`);
    if (agent.archived_at) throw badRequest(`agent ${data.agent} is archived`);

    const envTenant = getEnvironmentTenantId(data.environment_id);
    if (envTenant === undefined) throw notFound(`environment ${data.environment_id} not found`);
    assertResourceTenant(auth, envTenant, `environment ${data.environment_id} not found`);
    const env = getEnvironment(data.environment_id);
    if (!env) throw notFound(`environment ${data.environment_id} not found`);
    if (env.archived_at) throw badRequest(`environment ${data.environment_id} is archived`);

    const nextRunAt = computeNextRunAt(
      { cron_expression: data.schedule.expression, timezone: data.schedule.timezone },
      nowMs(),
    );
    if (nextRunAt === null) {
      throw badRequest(`schedule "${data.schedule.expression}" has no upcoming occurrence`);
    }

    const row = createDeployment({
      name: data.name,
      agent_id: data.agent,
      environment_id: data.environment_id,
      initial_events: data.initial_events,
      cron_expression: data.schedule.expression,
      timezone: data.schedule.timezone,
      vault_ids: data.vault_ids ?? null,
      metadata: (data.metadata ?? {}) as Record<string, unknown>,
      next_run_at: nextRunAt,
      tenant_id: resolveCreateTenant(auth, data.tenant_id),
    });
    return jsonOk(serialize(row), 201);
  });
}

export function handleListDeployments(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const requestedLimit = parseLimit(url.searchParams.get("limit"), 100);
    const rows = listDeploymentRows({ tenantFilter: tenantFilter(auth), includeArchived });
    return paginatedOk(rows.map(serialize), requestedLimit);
  });
}

export function handleGetDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    return jsonOk(serialize(loadDeploymentForCaller(auth, id)));
  });
}

export function handlePauseDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const row = loadDeploymentForCaller(auth, id);
    if (row.status === "archived") throw conflict(`deployment ${id} is archived`);
    setDeploymentStatus(id, "paused", { type: "manual" });
    return jsonOk(serialize(getDeploymentRow(id)!));
  });
}

export function handleUnpauseDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const row = loadDeploymentForCaller(auth, id);
    if (row.status === "archived") throw conflict(`deployment ${id} is archived`);
    // Resume from the next occurrence — missed triggers are not backfilled.
    setDeploymentStatus(id, "active", null);
    setDeploymentNextRun(id, computeNextRunAt(row, nowMs()));
    return jsonOk(serialize(getDeploymentRow(id)!));
  });
}

export function handleArchiveDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadDeploymentForCaller(auth, id);
    setDeploymentStatus(id, "archived", null);
    setDeploymentNextRun(id, null);
    return jsonOk(serialize(getDeploymentRow(id)!));
  });
}

/** Manual trigger — allowed while paused, rejected once archived. */
export function handleRunDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const row = loadDeploymentForCaller(auth, id);
    if (row.status === "archived") throw conflict(`deployment ${id} is archived`);
    const run = await triggerDeployment(row, { type: "manual" });
    if (!run) {
      // Agent gone/archived: the trigger auto-archived the deployment.
      throw conflict(`agent ${row.agent_id} is archived; deployment has been archived`);
    }
    return jsonOk(hydrateDeploymentRun(run), 201);
  });
}

export function handleListDeploymentRuns(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const deploymentId = url.searchParams.get("deployment_id") ?? undefined;
    if (deploymentId) loadDeploymentForCaller(auth, deploymentId); // tenant guard
    const hasErrorParam = url.searchParams.get("has_error");
    const requestedLimit = parseLimit(url.searchParams.get("limit"), 100);
    const rows = listDeploymentRunRows({
      deploymentId,
      hasError: hasErrorParam === null ? undefined : hasErrorParam === "true",
      tenantFilter: deploymentId ? null : tenantFilter(auth),
    });
    return paginatedOk(rows.map(hydrateDeploymentRun), requestedLimit);
  });
}
