/**
 * Deployment trigger + scheduler tick.
 *
 * `triggerDeployment` creates a session from a deployment's pinned config,
 * appends the initial user.message events, and enqueues the first turn —
 * the same internal path the events handler uses for an ordinary POST.
 * Every attempt writes a deployment_runs row (success carries session_id,
 * failure carries an error type/message).
 *
 * `runDeploymentSchedulerTick` is installed as a periodic timer in init.ts
 * (alongside the sweeper). next_run_at is advanced BEFORE the trigger so a
 * crash mid-trigger can't double-fire; missed occurrences while the server
 * was down collapse into a single fire (no backfill).
 */
import {
  createDeploymentRun,
  listDueDeployments,
  setDeploymentNextRun,
  setDeploymentStatus,
  type DeploymentRow,
  type DeploymentRunRow,
} from "../db/deployments";
import { parseCronExpression, nextFireTimes } from "../util/cron";
import { getAgent } from "../db/agents";
import { getEnvironment } from "../db/environments";
import { createSession } from "../db/sessions";
import { appendEvent } from "./bus";
import { getActor } from "./actor";
import { runTurn } from "./driver";
import { enqueueTurn } from "../queue";
import { nowMs } from "../util/clock";
import type { TurnInput } from "../state";

interface InitialMessageEvent {
  type: string;
  content?: Array<{ type: string; text?: string }>;
}

export type DeploymentTrigger =
  | { type: "schedule"; scheduledAt: number }
  | { type: "manual" };

/** Compute the next fire time (epoch ms) strictly after `afterMs`, or null. */
export function computeNextRunAt(row: Pick<DeploymentRow, "cron_expression" | "timezone">, afterMs: number): number | null {
  const schedule = parseCronExpression(row.cron_expression);
  return nextFireTimes(schedule, row.timezone, afterMs, 1)[0] ?? null;
}

/**
 * Attempt one deployment run. Always returns the run record except when the
 * agent is gone/archived, in which case the deployment is auto-archived and
 * no run is recorded (matching upstream semantics) — callers get null.
 */
export async function triggerDeployment(
  dep: DeploymentRow,
  trigger: DeploymentTrigger,
): Promise<DeploymentRunRow | null> {
  const scheduledAt = trigger.type === "schedule" ? trigger.scheduledAt : null;

  // Agent archived or deleted → auto-archive the deployment, record nothing.
  const agent = getAgent(dep.agent_id);
  if (!agent || agent.archived_at) {
    setDeploymentStatus(dep.id, "archived", null);
    console.warn(`[deployments] ${dep.id}: agent ${dep.agent_id} is gone/archived — deployment auto-archived`);
    return null;
  }

  const failRun = (errorType: string, message: string): DeploymentRunRow => {
    console.warn(`[deployments] ${dep.id}: run failed: ${errorType}: ${message}`);
    return createDeploymentRun({
      deployment_id: dep.id,
      trigger_type: trigger.type,
      scheduled_at: scheduledAt,
      error_type: errorType,
      error_message: message,
      agent_id: agent.id,
      agent_version: agent.version,
      tenant_id: dep.tenant_id,
    });
  };

  const env = getEnvironment(dep.environment_id);
  if (!env || env.archived_at) {
    return failRun("environment_archived_error", `environment \`${dep.environment_id}\` is ${env ? "archived" : "not found"}`);
  }

  let session;
  try {
    session = createSession({
      agent_id: agent.id,
      agent_version: agent.version,
      environment_id: dep.environment_id,
      title: dep.name,
      metadata: { deployment_id: dep.id },
      vault_ids: dep.vault_ids_json ? (JSON.parse(dep.vault_ids_json) as string[]) : null,
      tenant_id: dep.tenant_id,
    });
  } catch (err) {
    return failRun("session_creation_error", err instanceof Error ? err.message : String(err));
  }

  // Append the pinned initial events and collect the turn inputs.
  const inputs: TurnInput[] = [];
  const initialEvents = JSON.parse(dep.initial_events_json) as InitialMessageEvent[];
  for (const evt of initialEvents) {
    if (evt.type !== "user.message") continue;
    const content = evt.content ?? [];
    const text = content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("");
    const row = appendEvent(session.id, {
      type: "user.message",
      payload: { content },
      origin: "user",
      processedAt: null,
    });
    inputs.push({ kind: "text", eventId: row.id, text });
  }

  // Spawn the session actor and queue the first turn under the same
  // per-environment concurrency limits as user-initiated turns.
  getActor(session.id);
  enqueueTurn(dep.environment_id, () => runTurn(session.id, inputs)).catch((err) => {
    console.error(`[deployments] ${dep.id}: turn for session ${session.id} failed:`, err);
  });

  return createDeploymentRun({
    deployment_id: dep.id,
    trigger_type: trigger.type,
    scheduled_at: scheduledAt,
    session_id: session.id,
    agent_id: agent.id,
    agent_version: agent.version,
    tenant_id: dep.tenant_id,
  });
}

/**
 * One scheduler pass: fire every active deployment whose next_run_at has
 * passed, then advance its next_run_at. Installed on a timer in init.ts.
 */
export async function runDeploymentSchedulerTick(): Promise<void> {
  let due: DeploymentRow[];
  try {
    due = listDueDeployments(nowMs());
  } catch {
    return; // DB not ready yet
  }

  for (const dep of due) {
    const scheduledAt = dep.next_run_at!;
    // Advance the schedule first so a crash mid-trigger can't double-fire.
    let next: number | null = null;
    try {
      next = computeNextRunAt(dep, nowMs());
    } catch (err) {
      console.error(`[deployments] ${dep.id}: cron recompute failed:`, err);
    }
    setDeploymentNextRun(dep.id, next, scheduledAt);

    try {
      await triggerDeployment(dep, { type: "schedule", scheduledAt });
    } catch (err) {
      console.error(`[deployments] ${dep.id}: trigger failed:`, err);
    }
  }
}
