/**
 * SessionHandle — turn-oriented ergonomics over one session.
 *
 *   const session = await gateway.sessions.start({ agent: id, environment_id });
 *   for await (const event of session.send("Refactor the auth module")) {
 *     if (event.type === "agent.message") render(event);
 *   }
 *
 * `send()` posts a `user.message`, then yields every event the turn
 * produces and returns when the session goes idle (or is terminated).
 * `stream()` is the unbounded live tail for callers that manage their own
 * lifecycle (UIs, monitors).
 */
import type { Session } from "../types";
import type { GatewayEvent } from "../events/registry";
import type { Page, StreamCall, Transport } from "./types";
import {
  eventText,
  isAgentMessage,
  isOutcomeEvaluationEnd,
  isSessionError,
  isSessionIdle,
} from "./events";
import { buildQuery } from "./wire";

/** Content block for user messages — `{ type: "text", text }` plus passthrough. */
export type UserContentBlock = { type: string; [key: string]: unknown };

export interface SendOptions {
  /** Stop yielding (and close the stream) when aborted. */
  signal?: AbortSignal;
}

/** Event types that end a `send()` iteration. */
const TURN_END_TYPES = new Set(["session.status_idle", "session.status_terminated"]);

export interface DefineOutcomeInput {
  /** The task — the agent works toward this; no separate user.message needed. */
  description: string;
  /** Markdown rubric with independently gradeable criteria. */
  rubric: string | { type: "text"; content: string } | { type: "file"; file_id: string };
  /** Grader iterations before giving up (engine default applies when omitted). */
  max_iterations?: number;
}

/** Settled result of an outcome's iterate → grade → revise loop. */
export interface OutcomeResult {
  /** Terminal grader verdict: satisfied | failed | max_iterations_reached | interrupted | error. */
  result: string;
  /** Grader's explanation for the terminal verdict, if provided. */
  explanation: string | null;
  /** Number of grader evaluations that ran (terminal one included). */
  iterations: number;
  /** Every event the outcome produced, in order. */
  events: GatewayEvent[];
  /** The session.error payload if the loop errored, else null. */
  error: { type: string; message: string } | null;
}

/** Grader verdicts that settle an outcome (needs_revision continues the loop). */
const OUTCOME_TERMINAL = new Set(["satisfied", "failed", "max_iterations_reached", "interrupted"]);

/** Settled result of one turn — the awaitable counterpart to `send()`. */
export interface TurnResult {
  /** Concatenated text of the turn's agent.message events. */
  text: string;
  /** Every event the turn produced, in order. */
  events: GatewayEvent[];
  /** stop_reason type from the terminal status event (e.g. "end_turn"), or null. */
  stopReason: string | null;
  /** The session.error payload if the turn errored, else null. */
  error: { type: string; message: string } | null;
}

export class SessionHandle {
  constructor(
    private readonly transport: Transport,
    readonly id: string,
  ) {}

  /** Fetch the current session resource. */
  get(): Promise<Session> {
    return this.transport.call<Session>({
      handler: "handleGetSession",
      method: "GET",
      path: `/v1/sessions/${this.id}`,
      ids: [this.id],
    });
  }

  /** Append raw events to the session (advanced — `send()` covers the common case). */
  post(events: Array<Record<string, unknown>>): Promise<{ data: GatewayEvent[] }> {
    return this.transport.call<{ data: GatewayEvent[] }>({
      handler: "handlePostEvents",
      method: "POST",
      path: `/v1/sessions/${this.id}/events`,
      ids: [this.id],
      body: { events },
    });
  }

  /** List persisted events. */
  events(opts?: { limit?: number; order?: string; after_seq?: number }): Promise<Page<GatewayEvent>> {
    return this.transport.call<Page<GatewayEvent>>({
      handler: "handleListEvents",
      method: "GET",
      path: `/v1/sessions/${this.id}/events${buildQuery({
        limit: opts?.limit,
        order: opts?.order,
        after_seq: opts?.after_seq,
      })}`,
      ids: [this.id],
    });
  }

  /**
   * Send a user message and iterate the resulting turn. Yields every event
   * after the posted message (agent output, tool calls, status changes) and
   * completes when the session returns to idle or is terminated.
   */
  async *send(
    input: string | UserContentBlock[],
    opts?: SendOptions,
  ): AsyncGenerator<GatewayEvent, void, unknown> {
    const content = typeof input === "string" ? [{ type: "text", text: input }] : input;
    const posted = await this.post([{ type: "user.message", content }]);

    let afterSeq = posted.data.at(-1)?.seq;
    if (afterSeq == null) {
      // Defensive: a server that doesn't echo seq — resume from the log tail.
      const tail = await this.events({ limit: 1, order: "desc" });
      afterSeq = tail.data[0]?.seq ?? 0;
    }

    for await (const evt of this.stream(afterSeq, opts)) {
      yield evt;
      if (TURN_END_TYPES.has(evt.type)) return;
    }
  }

  /**
   * Send a user message and wait for the turn to settle. Collects what
   * `send()` streams into a `TurnResult` — use this when you want the
   * outcome, `send()` when you want to render progress.
   */
  async run(input: string | UserContentBlock[], opts?: SendOptions): Promise<TurnResult> {
    const result: TurnResult = { text: "", events: [], stopReason: null, error: null };
    for await (const evt of this.send(input, opts)) {
      result.events.push(evt);
      if (isAgentMessage(evt)) result.text += eventText(evt);
      else if (isSessionError(evt)) result.error = evt.error;
      else if (isSessionIdle(evt)) result.stopReason = evt.stop_reason?.type ?? null;
    }
    return result;
  }

  /**
   * Live-tail the session's event stream from `afterSeq` (backfills from
   * the DB, then follows). Runs until the consumer stops iterating.
   */
  async *stream(afterSeq?: number, opts?: SendOptions): AsyncGenerator<GatewayEvent, void, unknown> {
    const call: StreamCall = {
      handler: "handleSessionStream",
      method: "GET",
      path: `/v1/sessions/${this.id}/events/stream${buildQuery({ after_seq: afterSeq })}`,
      ids: [this.id],
      lastEventId: afterSeq != null ? String(afterSeq) : undefined,
    };
    for await (const evt of this.transport.stream(call)) {
      if (opts?.signal?.aborted) return;
      yield evt;
    }
  }

  /**
   * Define an outcome and wait for the rubric-graded iterate → grade →
   * revise loop to settle. Resolves on a terminal grader verdict
   * (`satisfied`, `failed`, `max_iterations_reached`, `interrupted`),
   * session termination, or an error turn — `needs_revision` verdicts
   * continue the loop and do not resolve.
   */
  async defineOutcome(input: DefineOutcomeInput, opts?: SendOptions): Promise<OutcomeResult> {
    const posted = await this.post([{ type: "user.define_outcome", ...input }]);

    let afterSeq = posted.data.at(-1)?.seq;
    if (afterSeq == null) {
      const tail = await this.events({ limit: 1, order: "desc" });
      afterSeq = tail.data[0]?.seq ?? 0;
    }

    const out: OutcomeResult = { result: "error", explanation: null, iterations: 0, events: [], error: null };

    for await (const evt of this.stream(afterSeq, opts)) {
      out.events.push(evt);
      if (isSessionError(evt)) {
        out.error = evt.error;
      } else if (isOutcomeEvaluationEnd(evt)) {
        out.iterations = evt.iteration + 1;
        if (OUTCOME_TERMINAL.has(evt.result)) {
          out.result = evt.result;
          out.explanation = evt.explanation ?? null;
          return out;
        }
      } else if (evt.type === "session.status_terminated") {
        out.result = "interrupted";
        return out;
      } else if (isSessionIdle(evt) && evt.stop_reason?.type === "error") {
        // The turn errored before the grader could settle the outcome.
        return out;
      }
    }
    return out;
  }

  /** Interrupt the running turn. */
  async interrupt(): Promise<void> {
    await this.post([{ type: "user.interrupt" }]);
  }

  /** Answer a pending tool confirmation (confirmation_mode agents). */
  async confirmTool(toolUseId: string, result: "allow" | "deny"): Promise<void> {
    await this.post([{ type: "user.tool_confirmation", tool_use_id: toolUseId, result }]);
  }
}
