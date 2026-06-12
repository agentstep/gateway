/**
 * Typed views over the gateway's event vocabulary — derived from the
 * engine's event schema registry (`src/events/registry.ts`). This module
 * adds consumer ergonomics (guards + text extraction); the shapes
 * themselves are defined once, in the registry.
 *
 *   for await (const ev of session.send("...")) {
 *     if (isAgentMessage(ev)) process(eventText(ev));
 *     else if (isAgentToolUse(ev)) audit(ev.name, ev.input);
 *   }
 */
import type { EventOf, GatewayEvent } from "../events/registry";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | { type: string; [key: string]: unknown };

export type AgentMessageEvent = EventOf<"agent.message">;
export type AgentThinkingEvent = EventOf<"agent.thinking">;
export type AgentToolUseEvent = EventOf<"agent.tool_use">;
export type AgentToolResultEvent = EventOf<"agent.tool_result">;
export type AgentCustomToolUseEvent = EventOf<"agent.custom_tool_use">;
export type SessionStatusRunningEvent = EventOf<"session.status_running">;
export type SessionStatusIdleEvent = EventOf<"session.status_idle">;
export type SessionErrorEvent = EventOf<"session.error">;
export type OutcomeEvaluationEndEvent = EventOf<"span.outcome_evaluation_end">;

export function isAgentMessage(ev: GatewayEvent): ev is AgentMessageEvent {
  return ev.type === "agent.message";
}

export function isAgentThinking(ev: GatewayEvent): ev is AgentThinkingEvent {
  return ev.type === "agent.thinking";
}

export function isAgentToolUse(ev: GatewayEvent): ev is AgentToolUseEvent {
  return ev.type === "agent.tool_use";
}

export function isAgentToolResult(ev: GatewayEvent): ev is AgentToolResultEvent {
  return ev.type === "agent.tool_result";
}

export function isAgentCustomToolUse(ev: GatewayEvent): ev is AgentCustomToolUseEvent {
  return ev.type === "agent.custom_tool_use";
}

export function isSessionRunning(ev: GatewayEvent): ev is SessionStatusRunningEvent {
  return ev.type === "session.status_running";
}

export function isSessionIdle(ev: GatewayEvent): ev is SessionStatusIdleEvent {
  return ev.type === "session.status_idle";
}

export function isSessionError(ev: GatewayEvent): ev is SessionErrorEvent {
  return ev.type === "session.error";
}

export function isOutcomeEvaluationEnd(ev: GatewayEvent): ev is OutcomeEvaluationEndEvent {
  return ev.type === "span.outcome_evaluation_end";
}

/** Concatenated text of an event's `text` content blocks ("" when none). */
export function eventText(ev: GatewayEvent): string {
  const content = (ev as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is TextBlock => !!b && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("");
}
