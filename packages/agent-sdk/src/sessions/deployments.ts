/**
 * Deployment firing + scheduler sweep.
 *
 * `fireDeployment` creates a session from a deployment and kicks off its
 * initial events through the same turn-start path the events handler
 * uses (work queue for self-hosted environments without an inline
 * executor, enqueueTurn otherwise). Every attempt — scheduled or manual —
 * writes a deployment_run record with the session id or a typed error.
 *
 * `runDeploymentSweep(now)` is the scheduler tick: for every active
 * deployment, match the cron expression against the current wall-clock
 * minute in the deployment's timezone and fire at most once per minute
 * (deduped via last_fired_minute). Pure function of `now` — tests drive
 * it with synthetic clocks; init.ts installs it on an interval.
 */
import {
  createDeploymentRun,
  listActiveDeployments,
  setDeploymentFiredMinute,
  type DeploymentRow,
  type DeploymentRunRow,
} from "../db/deployments";
import { getAgent } from "../db/agents";
import { getEnvironment } from "../db/environments";
import { createSession } from "../db/sessions";
import { appendEvent } from "./bus";
import { getActor } from "./actor";
import { startTurn } from "./kickoff";
import type { TurnInput } from "../state";
import { nowMs } from "../util/clock";
import { cronMatches, parseCron, zonedMinuteKey, zonedParts } from "../util/cron";

interface FireResult {
  run: DeploymentRunRow;
}

export async function fireDeployment(
  deployment: DeploymentRow,
  trigger: { type: "schedule" | "manual"; scheduledAt?: number },
): Promise<FireResult> {
  const fail = (errorType: string, message: string): FireResult => ({
    run: createDeploymentRun({
      deployment_id: deployment.id,
      trigger_type: trigger.type,
      scheduled_at: trigger.scheduledAt ?? null,
      error_type: errorType,
      error_message: message,
      agent_id: deployment.agent_id,
      agent_version: deployment.agent_version,
      tenant_id: deployment.tenant_id,
    }),
  });

  // Resolve agent (pinned version or latest) and environment.
  const agent = getAgent(deployment.agent_id, deployment.agent_version ?? undefined);
  if (!agent) return fail("agent_not_found", `agent not found: ${deployment.agent_id}`);
  if (agent.archived_at) return fail("agent_archived", `agent ${agent.id} is archived`);

  const env = getEnvironment(deployment.environment_id);
  if (!env) return fail("environment_not_found", `environment not found: ${deployment.environment_id}`);
  if (env.archived_at) return fail("environment_archived", `environment ${env.id} is archived`);

  try {
    const sessionConfig = deployment.session_config_json
      ? (JSON.parse(deployment.session_config_json) as Record<string, unknown>)
      : {};

    const session = createSession({
      agent_id: agent.id,
      agent_version: agent.version,
      environment_id: deployment.environment_id,
      title: (sessionConfig.title as string) ?? `${deployment.name} — ${new Date(nowMs()).toISOString()}`,
      metadata: { deployment_id: deployment.id, ...(sessionConfig.metadata as Record<string, unknown> ?? {}) },
      vault_ids: (sessionConfig.vault_ids as string[]) ?? null,
      tenant_id: deployment.tenant_id,
    });

    // Append initial events and collect the turn inputs (fresh session —
    // always idle, no concurrent-turn races to consider).
    const initialEvents = JSON.parse(deployment.initial_events_json) as Array<{
      type: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
    const actor = getActor(session.id);
    const inputs: TurnInput[] = await actor.enqueue(async () => {
      const collected: TurnInput[] = [];
      for (const event of initialEvents) {
        if (event.type !== "user.message" || !event.content) continue;
        const text = event.content.map((b) => b.text ?? "").join("");
        const row = appendEvent(session.id, {
          type: "user.message",
          payload: { content: event.content },
          origin: "user",
          processedAt: null,
        });
        collected.push({ kind: "text", eventId: row.id, text });
      }
      return collected;
    });

    await startTurn(session.id, deployment.environment_id, inputs);

    return {
      run: createDeploymentRun({
        deployment_id: deployment.id,
        trigger_type: trigger.type,
        scheduled_at: trigger.scheduledAt ?? null,
        session_id: session.id,
        agent_id: agent.id,
        agent_version: agent.version,
        tenant_id: deployment.tenant_id,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail("service_unavailable", msg);
  }
}

/**
 * One scheduler tick. Fires every active deployment whose cron matches
 * the current wall-clock minute in its timezone, at most once per minute.
 * Returns the number of deployments fired (for tests/observability).
 */
export async function runDeploymentSweep(now: number = nowMs()): Promise<number> {
  let fired = 0;
  for (const deployment of listActiveDeployments()) {
    const cron = parseCron(deployment.schedule_expression);
    if (!cron) continue; // invalid expressions are rejected at create; belt and braces

    const minuteKey = zonedMinuteKey(now, deployment.schedule_timezone);
    if (deployment.last_fired_minute === minuteKey) continue;
    if (!cronMatches(cron, zonedParts(now, deployment.schedule_timezone))) continue;

    // Claim the minute before firing so a crash mid-fire can't double-fire.
    setDeploymentFiredMinute(deployment.id, minuteKey);
    fired++;
    await fireDeployment(deployment, { type: "schedule", scheduledAt: now }).catch((err: unknown) => {
      console.error(`[deployments] scheduled fire failed for ${deployment.id}:`, err);
      return undefined as never;
    });
  }
  return fired;
}
