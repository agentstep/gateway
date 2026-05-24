/**
 * Multi-agent thread orchestrator.
 *
 * When a parent session's agent calls `spawn_agent`, the driver delegates
 * to this module. It creates a session_threads row for tracking, then
 * creates a child session, runs it to completion, and returns the child's
 * final agent.message text as the tool result.
 *
 * Depth is capped at MAX_THREAD_DEPTH (1) to prevent recursive delegation.
 * The child session currently gets its own container (future: share the
 * coordinator's container).
 */
import { createSession, getSessionRow, bumpSessionStats } from "../db/sessions";
import { getAgent } from "../db/agents";
import { getSession } from "../db/sessions";
import { listEvents } from "../db/events";
import { appendEvent } from "./bus";
import { getActor } from "./actor";
import { runTurn } from "./driver";
import {
  createThread,
  updateThreadStatus,
  updateThreadUsage,
} from "../db/threads";
import type { TraceContext } from "./trace";
import { nowMs } from "../util/clock";
import { ApiError } from "../errors";

/** Max delegation depth. Coordinator = 0, delegate = 1. No deeper. */
const MAX_THREAD_DEPTH = 1;

/**
 * Spawn a child agent session, run it to completion, and return the
 * child's final agent.message text.
 *
 * Creates a session_threads row for tracking and emits thread lifecycle
 * events on the parent session's event bus.
 *
 * `parentTrace` (when provided) propagates the parent turn's trace id and
 * current span id into the child's `runTurn`, so events emitted by the
 * child session share the same trace and render as nested spans in the
 * cross-session waterfall.
 */
export async function handleSpawnAgent(
  parentSessionId: string,
  agentId: string,
  prompt: string,
  parentDepth: number,
  parentTrace?: TraceContext,
): Promise<string> {
  if (parentDepth >= MAX_THREAD_DEPTH) {
    throw new ApiError(
      400,
      "invalid_request_error",
      `thread depth limit reached (max ${MAX_THREAD_DEPTH})`,
    );
  }

  const parentSession = getSession(parentSessionId);
  if (!parentSession) {
    throw new ApiError(404, "not_found_error", `parent session not found: ${parentSessionId}`);
  }

  // Validate that the target agent_id is in the parent agent's callable_agents list.
  const parentAgent = getAgent(parentSession.agent.id, parentSession.agent.version);
  if (parentAgent && parentAgent.callable_agents.length > 0) {
    const allowed = parentAgent.callable_agents.some((ca) => ca.id === agentId);
    if (!allowed) {
      return `Error: agent ${agentId} is not in callable_agents list`;
    }
  }

  const agent = getAgent(agentId);
  if (!agent) {
    throw new ApiError(404, "not_found_error", `agent not found: ${agentId}`);
  }

  // Create a session_threads row for tracking
  const thread = createThread({
    sessionId: parentSessionId,
    agentId: agent.id,
    agentVersion: agent.version,
  });

  // Emit thread_created on parent session
  appendEvent(parentSessionId, {
    type: "session.thread_created",
    payload: {
      session_thread_id: thread.id,
      agent_name: agent.name,
      agent_id: agentId,
    },
    origin: "server",
    processedAt: nowMs(),
    traceId: parentTrace?.trace_id ?? null,
    spanId: parentTrace?.span_id ?? null,
    parentSpanId: parentTrace?.parent_span_id ?? null,
  });

  // Create child session with parent reference and incremented depth
  const childSession = createSession({
    agent_id: agent.id,
    agent_version: agent.version,
    environment_id: parentSession.environment_id,
    title: `Thread from ${parentSessionId}`,
    metadata: { parent_session_id: parentSessionId, session_thread_id: thread.id },
    parent_session_id: parentSessionId,
    thread_depth: parentDepth + 1,
    vault_ids: parentSession.vault_ids,
  });

  // Mark thread as running
  updateThreadStatus(thread.id, "running");

  // Emit thread_status_running on parent
  appendEvent(parentSessionId, {
    type: "session.thread_status_running",
    payload: {
      session_thread_id: thread.id,
      agent_name: agent.name,
      child_session_id: childSession.id,
    },
    origin: "server",
    processedAt: nowMs(),
    traceId: parentTrace?.trace_id ?? null,
    spanId: parentTrace?.span_id ?? null,
    parentSpanId: parentTrace?.parent_span_id ?? null,
  });

  // Emit agent.thread_message_sent on parent
  appendEvent(parentSessionId, {
    type: "agent.thread_message_sent",
    payload: {
      to_session_thread_id: thread.id,
      to_agent_name: agent.name,
      content: prompt,
    },
    origin: "server",
    processedAt: nowMs(),
    traceId: parentTrace?.trace_id ?? null,
    spanId: parentTrace?.span_id ?? null,
    parentSpanId: parentTrace?.parent_span_id ?? null,
  });

  // Spawn the child actor
  getActor(childSession.id);

  // Run the child turn
  const eventId = `thread_${childSession.id}_${nowMs()}`;
  await runTurn(childSession.id, [
    { kind: "text", eventId, text: prompt },
  ], 0, parentTrace);

  // Wait for completion: poll until session is idle
  const maxWaitMs = 300_000; // 5 minutes
  const pollIntervalMs = 500;
  const startMs = nowMs();
  let childRow = getSessionRow(childSession.id);
  while (childRow && childRow.status === "running" && nowMs() - startMs < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    childRow = getSessionRow(childSession.id);
  }

  // If timed out, interrupt and clean up the child
  if (childRow && childRow.status === "running") {
    const { interruptSession } = await import("./interrupt");
    interruptSession(childSession.id);
  }

  // Extract the last agent.message text from the child's events
  let resultText = "";
  const events = listEvents(childSession.id, { limit: 100, order: "desc" });
  for (const evt of events) {
    if (evt.type === "agent.message") {
      const payload = JSON.parse(evt.payload_json) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (payload.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("");
      if (text) {
        resultText = text;
        break;
      }
    }
  }

  // Sub-agent cost rollup
  const finalChildRow = getSessionRow(childSession.id);
  if (finalChildRow) {
    bumpSessionStats(
      parentSessionId,
      { tool_calls_count: finalChildRow.tool_calls_count },
      {
        input_tokens: finalChildRow.usage_input_tokens,
        output_tokens: finalChildRow.usage_output_tokens,
        cache_read_input_tokens: finalChildRow.usage_cache_read_input_tokens,
        cache_creation_input_tokens: finalChildRow.usage_cache_creation_input_tokens,
        cost_usd: finalChildRow.usage_cost_usd,
      },
    );

    // Update thread usage
    updateThreadUsage(thread.id, {
      input_tokens: finalChildRow.usage_input_tokens,
      output_tokens: finalChildRow.usage_output_tokens,
      cache_read_input_tokens: finalChildRow.usage_cache_read_input_tokens,
      cache_creation_input_tokens: finalChildRow.usage_cache_creation_input_tokens,
    });
  }

  // Determine stop reason
  const stopReason = childRow?.stop_reason ?? "end_turn";
  const threadStatus = stopReason === "error" ? "terminated" as const : "idle" as const;
  updateThreadStatus(thread.id, threadStatus, stopReason);

  // Emit agent.thread_message_received on parent
  appendEvent(parentSessionId, {
    type: "agent.thread_message_received",
    payload: {
      from_session_thread_id: thread.id,
      from_agent_name: agent.name,
      content: resultText || "(no response from sub-agent)",
    },
    origin: "server",
    processedAt: nowMs(),
    traceId: parentTrace?.trace_id ?? null,
    spanId: parentTrace?.span_id ?? null,
    parentSpanId: parentTrace?.parent_span_id ?? null,
  });

  // Emit thread status event on parent
  const statusEventType = threadStatus === "idle"
    ? "session.thread_status_idle"
    : "session.thread_status_terminated";
  appendEvent(parentSessionId, {
    type: statusEventType,
    payload: {
      session_thread_id: thread.id,
      agent_name: agent.name,
      stop_reason: stopReason,
      child_session_id: childSession.id,
      child_usage: finalChildRow
        ? {
            input_tokens: finalChildRow.usage_input_tokens,
            output_tokens: finalChildRow.usage_output_tokens,
            cache_read_input_tokens: finalChildRow.usage_cache_read_input_tokens,
            cache_creation_input_tokens: finalChildRow.usage_cache_creation_input_tokens,
            cost_usd: finalChildRow.usage_cost_usd,
            tool_calls_count: finalChildRow.tool_calls_count,
          }
        : null,
    },
    origin: "server",
    processedAt: nowMs(),
    traceId: parentTrace?.trace_id ?? null,
    spanId: parentTrace?.span_id ?? null,
    parentSpanId: parentTrace?.parent_span_id ?? null,
  });

  return resultText || "(no response from sub-agent)";
}
