/**
 * Event schema registry — the single source of truth for the gateway's
 * event vocabulary.
 *
 * Every event the engine emits (translators, driver, threads, grader,
 * handlers) has a payload schema here. Everything downstream derives from
 * this file: the typed `GatewayEvent` union, the client's guards, webhook
 * payload types, and the OpenAPI event schemas.
 *
 * Wire shape: events are stored as `{type, payload}` and flattened by
 * `rowToManagedEvent` — the payload's fields appear at the top level of
 * the delivered event next to `id`/`seq`/`session_id`/`type`/
 * `processed_at` (see `db/events.ts`). The schemas below describe the
 * payload (= the flattened fields).
 *
 * Compatibility rule: payload changes must be additive. New event types
 * may be added freely; removing or retyping a field is a wire break and
 * must clear the compat suites.
 *
 * All schemas use `.passthrough()` — backends may attach extra fields,
 * and consumers must tolerate them.
 */
import { z } from "zod";

// ── Shared fragments ──────────────────────────────────────────────────────

/** Text/thinking content blocks as emitted by translators and user input. */
const contentBlock = z
  .object({ type: z.string() })
  .passthrough();

const contentArray = z.array(contentBlock);

/** stop_reason on session.status_idle: `{type}` plus event_ids for requires_action. */
const stopReason = z
  .object({
    type: z.string(),
    event_ids: z.array(z.string()).optional(),
  })
  .passthrough();

const errorShape = z
  .object({ type: z.string(), message: z.string() })
  .passthrough();

const modelUsage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .passthrough()
  .nullable();

const toolClass = z.enum(["builtin", "mcp", "custom"]);

// ── Payload schemas, by namespace ─────────────────────────────────────────

export const EVENT_PAYLOADS = {
  // agent.* — model output and tool activity
  "agent.message": z.object({ content: contentArray }).passthrough(),
  "agent.thinking": z.object({ content: contentArray }).passthrough(),
  "agent.tool_use": z
    .object({
      tool_use_id: z.string(),
      name: z.string(),
      input: z.record(z.unknown()),
    })
    .passthrough(),
  "agent.tool_result": z
    .object({
      tool_use_id: z.string(),
      content: z.unknown().optional(),
      is_error: z.boolean().optional(),
    })
    .passthrough(),
  "agent.mcp_tool_use": z
    .object({
      tool_use_id: z.string(),
      server_name: z.string(),
      tool_name: z.string(),
      input: z.record(z.unknown()),
    })
    .passthrough(),
  "agent.mcp_tool_result": z
    .object({
      tool_use_id: z.string(),
      content: z.unknown().optional(),
      is_error: z.boolean().optional(),
    })
    .passthrough(),
  "agent.custom_tool_use": z
    .object({
      tool_use_id: z.string(),
      name: z.string(),
      input: z.record(z.unknown()),
    })
    .passthrough(),
  "agent.tool_confirmation_request": z
    .object({ tool_use_id: z.string().optional() })
    .passthrough(),
  "agent.thread_message_sent": z
    .object({
      to_session_thread_id: z.string(),
      content: contentArray.optional(),
    })
    .passthrough(),
  "agent.thread_message_received": z
    .object({
      from_session_thread_id: z.string(),
      content: contentArray.optional(),
    })
    .passthrough(),

  // user.* — client-sent events (echoed back on the stream)
  "user.message": z.object({ content: contentArray }).passthrough(),
  "user.interrupt": z.object({}).passthrough(),
  "user.tool_confirmation": z
    .object({
      tool_use_id: z.string().optional(),
      result: z.enum(["allow", "deny"]).optional(),
      deny_message: z.string().optional(),
    })
    .passthrough(),
  "user.custom_tool_result": z
    .object({
      custom_tool_use_id: z.string(),
      content: z.array(z.unknown()).optional(),
      is_error: z.boolean().optional(),
    })
    .passthrough(),
  "user.define_outcome": z
    .object({
      description: z.string(),
      rubric: z
        .union([
          z.string(),
          z.object({ type: z.literal("text"), content: z.string() }),
          z.object({ type: z.literal("file"), file_id: z.string() }),
        ])
        .optional(),
      max_iterations: z.number().optional(),
      outcome_id: z.string().optional(),
    })
    .passthrough(),

  // session.* — lifecycle
  "session.status_running": z.object({}).passthrough(),
  "session.status_idle": z.object({ stop_reason: stopReason }).passthrough(),
  "session.status_rescheduled": z.object({}).passthrough(),
  "session.status_terminated": z.object({}).passthrough(),
  "session.error": z.object({ error: errorShape }).passthrough(),
  "session.script_executed": z.object({}).passthrough(),
  "session.file_synced": z.object({}).passthrough(),

  // session.thread_* — multiagent threads (emitted on the parent session)
  "session.thread_created": z
    .object({
      session_thread_id: z.string(),
      agent_name: z.string().optional(),
      agent_id: z.string().optional(),
    })
    .passthrough(),
  "session.thread_status_running": z
    .object({ session_thread_id: z.string(), agent_name: z.string().optional() })
    .passthrough(),
  "session.thread_status_idle": z
    .object({
      session_thread_id: z.string(),
      agent_name: z.string().optional(),
      stop_reason: stopReason.optional(),
    })
    .passthrough(),
  "session.thread_status_terminated": z
    .object({ session_thread_id: z.string(), agent_name: z.string().optional() })
    .passthrough(),

  // span.* — observability boundaries
  "span.model_request_start": z.object({ model: z.string() }).passthrough(),
  "span.model_request_end": z
    .object({
      model: z.string(),
      model_usage: modelUsage.optional(),
      status: z.string().optional(),
    })
    .passthrough(),
  "span.tool_call_start": z
    .object({
      tool_use_id: z.string(),
      name: z.string(),
      tool_class: toolClass,
    })
    .passthrough(),
  "span.tool_call_end": z
    .object({
      tool_use_id: z.string(),
      name: z.string().nullable(),
      tool_class: toolClass,
      status: z.string(),
      duration_ms: z.number().nullable(),
    })
    .passthrough(),
  "span.outcome_evaluation_start": z
    .object({ outcome_id: z.string().nullable(), iteration: z.number() })
    .passthrough(),
  "span.outcome_evaluation_ongoing": z
    .object({ outcome_id: z.string().nullable(), iteration: z.number() })
    .passthrough(),
  "span.outcome_evaluation_end": z
    .object({
      outcome_id: z.string().nullable(),
      result: z.string(),
      explanation: z.string().optional(),
      iteration: z.number(),
      usage: z
        .object({ input_tokens: z.number(), output_tokens: z.number() })
        .passthrough()
        .optional(),
    })
    .passthrough(),
} as const;

export type KnownEventType = keyof typeof EVENT_PAYLOADS;

export const KNOWN_EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as KnownEventType[];

export function isKnownEventType(type: string): type is KnownEventType {
  return type in EVENT_PAYLOADS;
}

/**
 * Validate a payload against its type's schema. Returns the issue list on
 * failure, null when valid or when the type is unknown (unknown types are
 * not an error — forward compatibility).
 */
export function validateEventPayload(
  type: string,
  payload: unknown,
): z.ZodIssue[] | null {
  if (!isKnownEventType(type)) return null;
  const res = EVENT_PAYLOADS[type].safeParse(payload);
  return res.success ? null : res.error.issues;
}

// ── Derived wire-event types ──────────────────────────────────────────────

/** Fields every delivered event carries (added by the bus/DB layer). */
export interface EventBase {
  id: string;
  seq: number;
  session_id: string;
  processed_at: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
}

/** One delivered event of a known type: base + type + flattened payload. */
export type EventOf<T extends KnownEventType> = EventBase & { type: T } & z.infer<
    (typeof EVENT_PAYLOADS)[T]
  >;

/**
 * An event of a type the registry doesn't know. Not part of the
 * `GatewayEvent` union (it would defeat discriminant narrowing) — at
 * runtime, events of future types still flow through streams typed as
 * `GatewayEvent`; handle them in a `default:` branch and cast to
 * `UnknownEvent` if you need their fields.
 */
export interface UnknownEvent extends EventBase {
  type: string;
  [key: string]: unknown;
}

/**
 * The gateway's event union. `switch (ev.type)` narrows to the typed
 * payload for every known type.
 */
export type GatewayEvent = { [T in KnownEventType]: EventOf<T> }[KnownEventType];
