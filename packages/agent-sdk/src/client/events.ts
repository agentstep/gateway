/**
 * Typed views over the gateway's event vocabulary.
 *
 * Events arrive as `ManagedEvent` (open-ended — translators may add
 * fields), with the payload flattened onto the event object (see
 * `rowToManagedEvent`). These interfaces type the payloads of the core
 * events so consumers get real fields after a type-guard narrow:
 *
 *   for await (const ev of session.send("...")) {
 *     if (isAgentMessage(ev)) process(eventText(ev));
 *     else if (isAgentToolUse(ev)) audit(ev.name, ev.input);
 *   }
 */
import type { ManagedEvent } from "../types";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | { type: string; [key: string]: unknown };

export interface AgentMessageEvent extends ManagedEvent {
  type: "agent.message";
  content: ContentBlock[];
}

export interface AgentThinkingEvent extends ManagedEvent {
  type: "agent.thinking";
  content: ContentBlock[];
}

export interface AgentToolUseEvent extends ManagedEvent {
  type: "agent.tool_use";
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultEvent extends ManagedEvent {
  type: "agent.tool_result";
  tool_use_id: string;
}

export interface SessionStatusRunningEvent extends ManagedEvent {
  type: "session.status_running";
}

export interface SessionStatusIdleEvent extends ManagedEvent {
  type: "session.status_idle";
  stop_reason: { type: string; event_ids?: string[] };
}

export interface SessionErrorEvent extends ManagedEvent {
  type: "session.error";
  error: { type: string; message: string };
}

export function isAgentMessage(ev: ManagedEvent): ev is AgentMessageEvent {
  return ev.type === "agent.message";
}

export function isAgentThinking(ev: ManagedEvent): ev is AgentThinkingEvent {
  return ev.type === "agent.thinking";
}

export function isAgentToolUse(ev: ManagedEvent): ev is AgentToolUseEvent {
  return ev.type === "agent.tool_use";
}

export function isAgentToolResult(ev: ManagedEvent): ev is AgentToolResultEvent {
  return ev.type === "agent.tool_result";
}

export function isSessionRunning(ev: ManagedEvent): ev is SessionStatusRunningEvent {
  return ev.type === "session.status_running";
}

export function isSessionIdle(ev: ManagedEvent): ev is SessionStatusIdleEvent {
  return ev.type === "session.status_idle";
}

export function isSessionError(ev: ManagedEvent): ev is SessionErrorEvent {
  return ev.type === "session.error";
}

/** Concatenated text of an event's `text` content blocks ("" when none). */
export function eventText(ev: ManagedEvent): string {
  const content = (ev as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is TextBlock => !!b && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("");
}
