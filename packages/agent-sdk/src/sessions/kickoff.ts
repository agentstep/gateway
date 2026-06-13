/**
 * Shared turn kickoff — append user inputs and start (or queue) the turn,
 * with the same inline-vs-work-queue decision the events handler makes.
 * Used by deployments and the chat stream endpoint; the events handler
 * itself migrates here with the services extraction.
 */
import { getEnvironment, getEnvironmentRow } from "../db/environments";
import { getSessionRow, updateSessionStatus } from "../db/sessions";
import { appendEvent } from "./bus";
import { getConfig } from "../config";
import { enqueueTurn } from "../queue";
import { runTurn } from "./driver";
import { markTurnStarting, clearTurnStarting, type TurnInput } from "../state";
import { nowMs } from "../util/clock";

/**
 * Start a turn for `inputs` on an idle session. Mirrors the events
 * handler's tail: marks the session active synchronously, then either
 * queues a work item (self-hosted env without an inline executor) or
 * enqueues an inline runTurn.
 */
export async function startTurn(sessionId: string, environmentId: string, inputs: TurnInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const row = getSessionRow(sessionId);
  if (!row) return;

  const markerEpoch = markTurnStarting(sessionId);
  const env = getEnvironment(environmentId);
  const canExecuteInline = !!getConfig().defaultProvider || !!env?.config?.provider;

  if (env?.config?.type === "self_hosted" && !canExecuteInline) {
    const { createWorkItem } = await import("../db/work");
    const envRow = getEnvironmentRow(environmentId);
    createWorkItem(environmentId, sessionId, {
      inputsJson: JSON.stringify(inputs),
      tenantId: envRow?.tenant_id ?? undefined,
    });
    updateSessionStatus(sessionId, "running");
    appendEvent(sessionId, {
      type: "session.status_running",
      payload: {},
      origin: "server",
      processedAt: nowMs(),
    });
    clearTurnStarting(sessionId, markerEpoch);
  } else {
    void enqueueTurn(environmentId, () => runTurn(sessionId, inputs)).catch((err: unknown) => {
      clearTurnStarting(sessionId, markerEpoch);
      console.error(`[kickoff] enqueueTurn failed for ${sessionId}:`, err);
    });
  }
}
