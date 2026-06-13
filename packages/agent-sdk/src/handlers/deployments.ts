/**
 * Scheduled deployments — gateway-native /v1/deployments handlers.
 *
 * A deployment runs an agent on a cron cadence: each firing creates a
 * session seeded with the deployment's initial events. Lifecycle:
 * active ⇄ paused → archived (terminal). Manual runs work while paused.
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { badRequest, notFound } from "../errors";
import {
  createDeployment,
  getDeployment,
  listDeployments,
  listDeploymentRuns,
  rowToDeployment,
  rowToDeploymentRun,
  setDeploymentStatus,
} from "../db/deployments";
import { getAgent } from "../db/agents";
import { getEnvironment } from "../db/environments";
import { fireDeployment } from "../sessions/deployments";
import { nextRuns, parseCron } from "../util/cron";
import { toIso } from "../util/clock";

const InitialEvent = z
  .object({
    type: z.literal("user.message"),
    content: z.array(z.object({ type: z.literal("text"), text: z.string().min(1) })).min(1),
  })
  .passthrough();

const CreateSchema = z.object({
  name: z.string().min(1).max(256),
  agent: z.union([
    z.string().min(1),
    z.object({ type: z.literal("agent").optional(), id: z.string().min(1), version: z.number().int().optional() }),
  ]),
  environment_id: z.string().min(1),
  initial_events: z.array(InitialEvent).min(1),
  schedule: z.object({
    type: z.literal("cron"),
    expression: z.string().min(1),
    timezone: z.string().min(1).default("UTC"),
  }),
  vault_ids: z.array(z.string()).optional(),
  metadata: z.record(z.string()).optional(),
  title: z.string().optional(),
});

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function withUpcoming(row: ReturnType<typeof getDeployment> & object) {
  const pub = rowToDeployment(row);
  const cron = parseCron(row.schedule_expression);
  if (cron && row.status === "active") {
    pub.schedule.upcoming_runs_at = nextRuns(cron, row.schedule_timezone, Date.now(), 3).map((t) => toIso(t));
  }
  return pub;
}

export function handleCreateDeployment(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const agentRef = parsed.data.agent;
    const agentId = typeof agentRef === "string" ? agentRef : agentRef.id;
    const agentVersion = typeof agentRef === "string" ? null : agentRef.version ?? null;

    const agent = getAgent(agentId, agentVersion ?? undefined);
    if (!agent) throw notFound(`agent not found: ${agentId}`);
    const env = getEnvironment(parsed.data.environment_id);
    if (!env) throw notFound(`environment not found: ${parsed.data.environment_id}`);

    if (!parseCron(parsed.data.schedule.expression)) {
      throw badRequest(`invalid cron expression: "${parsed.data.schedule.expression}"`);
    }
    if (!isValidTimezone(parsed.data.schedule.timezone)) {
      throw badRequest(`invalid timezone: "${parsed.data.schedule.timezone}"`);
    }

    const sessionConfig: Record<string, unknown> = {};
    if (parsed.data.vault_ids) sessionConfig.vault_ids = parsed.data.vault_ids;
    if (parsed.data.metadata) sessionConfig.metadata = parsed.data.metadata;
    if (parsed.data.title) sessionConfig.title = parsed.data.title;

    const row = createDeployment({
      name: parsed.data.name,
      agent_id: agentId,
      agent_version: agentVersion,
      environment_id: parsed.data.environment_id,
      initial_events: parsed.data.initial_events,
      schedule_expression: parsed.data.schedule.expression,
      schedule_timezone: parsed.data.schedule.timezone,
      session_config: Object.keys(sessionConfig).length ? sessionConfig : null,
      tenant_id: auth.tenantId,
    });
    return jsonOk(withUpcoming(row), 201);
  });
}

export function handleListDeployments(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const url = new URL(request.url);
    const rows = listDeployments({
      tenantId: auth.tenantId,
      includeArchived: url.searchParams.get("include_archived") === "true",
    });
    return jsonOk({ data: rows.map((r) => withUpcoming(r)), next_page: null });
  });
}

export function handleGetDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const row = getDeployment(id);
    if (!row) throw notFound(`deployment not found: ${id}`);
    return jsonOk(withUpcoming(row));
  });
}

function transition(id: string, to: "active" | "paused" | "archived", pausedReason?: unknown) {
  const row = getDeployment(id);
  if (!row) throw notFound(`deployment not found: ${id}`);
  if (row.status === "archived") throw badRequest("deployment is archived (terminal)");
  setDeploymentStatus(id, to, pausedReason);
  return getDeployment(id)!;
}

export function handlePauseDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => jsonOk(withUpcoming(transition(id, "paused", { type: "manual" }))));
}

export function handleUnpauseDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => jsonOk(withUpcoming(transition(id, "active"))));
}

export function handleArchiveDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => jsonOk(withUpcoming(transition(id, "archived"))));
}

/** Manual run — fires immediately; permitted while paused (not archived). */
export function handleRunDeployment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const row = getDeployment(id);
    if (!row) throw notFound(`deployment not found: ${id}`);
    if (row.status === "archived") throw badRequest("deployment is archived (terminal)");
    const { run } = await fireDeployment(row, { type: "manual" });
    return jsonOk(rowToDeploymentRun(run), 201);
  });
}

export function handleListDeploymentRuns(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const url = new URL(request.url);
    const deploymentId = url.searchParams.get("deployment_id");
    if (!deploymentId) throw badRequest("deployment_id query parameter is required");
    const hasErrorParam = url.searchParams.get("has_error");
    const rows = listDeploymentRuns(deploymentId, {
      hasError: hasErrorParam === null ? undefined : hasErrorParam === "true",
      limit: Number(url.searchParams.get("limit") ?? 100),
    });
    return jsonOk({ data: rows.map(rowToDeploymentRun), next_page: null });
  });
}
