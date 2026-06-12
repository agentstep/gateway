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
import type { ManagedEvent, Session } from "../types";
import type { Page, StreamCall, Transport } from "./types";
import { buildQuery } from "./wire";

/** Content block for user messages — `{ type: "text", text }` plus passthrough. */
export type UserContentBlock = { type: string; [key: string]: unknown };

export interface SendOptions {
  /** Stop yielding (and close the stream) when aborted. */
  signal?: AbortSignal;
}

/** Event types that end a `send()` iteration. */
const TURN_END_TYPES = new Set(["session.status_idle", "session.status_terminated"]);

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
  post(events: Array<Record<string, unknown>>): Promise<{ data: ManagedEvent[] }> {
    return this.transport.call<{ data: ManagedEvent[] }>({
      handler: "handlePostEvents",
      method: "POST",
      path: `/v1/sessions/${this.id}/events`,
      ids: [this.id],
      body: { events },
    });
  }

  /** List persisted events. */
  events(opts?: { limit?: number; order?: string; after_seq?: number }): Promise<Page<ManagedEvent>> {
    return this.transport.call<Page<ManagedEvent>>({
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
  ): AsyncGenerator<ManagedEvent, void, unknown> {
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
   * Live-tail the session's event stream from `afterSeq` (backfills from
   * the DB, then follows). Runs until the consumer stops iterating.
   */
  async *stream(afterSeq?: number, opts?: SendOptions): AsyncGenerator<ManagedEvent, void, unknown> {
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

  /** Interrupt the running turn. */
  async interrupt(): Promise<void> {
    await this.post([{ type: "user.interrupt" }]);
  }

  /** Answer a pending tool confirmation (confirmation_mode agents). */
  async confirmTool(toolUseId: string, result: "allow" | "deny"): Promise<void> {
    await this.post([{ type: "user.tool_confirmation", tool_use_id: toolUseId, result }]);
  }
}
