/**
 * Event schema registry tests.
 *
 * 1. Sample payloads for every registered type parse cleanly.
 * 2. Drift guard: real translator output (claude backend) validates
 *    against the registry — a translator emitting a shape the registry
 *    doesn't describe fails here, not in production.
 * 3. The GatewayEvent union narrows on `switch (ev.type)`.
 */
import { describe, it, expect } from "vitest";
import {
  EVENT_PAYLOADS,
  KNOWN_EVENT_TYPES,
  isKnownEventType,
  validateEventPayload,
  type GatewayEvent,
} from "../src/events/registry";
import { createClaudeTranslator } from "../src/backends/claude/translator";

/** A representative valid payload per event type. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  "agent.message": { content: [{ type: "text", text: "hi" }] },
  "agent.thinking": { content: [{ type: "thinking", thinking: "hmm" }] },
  "agent.tool_use": { tool_use_id: "toolu_1", name: "Bash", input: { command: "ls" } },
  "agent.tool_result": { tool_use_id: "toolu_1", content: "ok", is_error: false },
  "agent.mcp_tool_use": { tool_use_id: "toolu_2", server_name: "linear", tool_name: "search", input: {} },
  "agent.mcp_tool_result": { tool_use_id: "toolu_2", content: null, is_error: false },
  "agent.custom_tool_use": { tool_use_id: "toolu_3", name: "get_weather", input: { city: "SF" } },
  "agent.tool_confirmation_request": { tool_use_id: "toolu_4" },
  "agent.thread_message_sent": { to_session_thread_id: "thr_1", content: [{ type: "text", text: "go" }] },
  "agent.thread_message_received": { from_session_thread_id: "thr_1" },
  "user.message": { content: [{ type: "text", text: "hello" }] },
  "user.interrupt": {},
  "user.tool_confirmation": { tool_use_id: "sevt_1", result: "allow" },
  "user.custom_tool_result": { custom_tool_use_id: "sevt_2", content: [{ type: "text", text: "42" }] },
  "user.define_outcome": { description: "build it", rubric: { type: "text", content: "- works" }, max_iterations: 5 },
  "session.status_running": {},
  "session.status_idle": { stop_reason: { type: "end_turn" } },
  "session.status_rescheduled": {},
  "session.status_terminated": {},
  "session.error": { error: { type: "server_error", message: "boom" } },
  "session.script_executed": {},
  "session.file_synced": {},
  "session.thread_created": { session_thread_id: "thr_1", agent_name: "reviewer", agent_id: "agt_1" },
  "session.thread_status_running": { session_thread_id: "thr_1" },
  "session.thread_status_idle": { session_thread_id: "thr_1", stop_reason: { type: "end_turn" } },
  "session.thread_status_terminated": { session_thread_id: "thr_1" },
  "span.model_request_start": { model: "claude-sonnet-4-6" },
  "span.model_request_end": { model: "claude-sonnet-4-6", model_usage: { input_tokens: 10, output_tokens: 5 } },
  "span.tool_call_start": { tool_use_id: "toolu_1", name: "Bash", tool_class: "builtin" },
  "span.tool_call_end": { tool_use_id: "toolu_1", name: "Bash", tool_class: "builtin", status: "ok", duration_ms: 12 },
  "span.outcome_evaluation_start": { outcome_id: "outc_1", iteration: 0 },
  "span.outcome_evaluation_ongoing": { outcome_id: "outc_1", iteration: 0 },
  "span.outcome_evaluation_end": {
    outcome_id: "outc_1",
    result: "satisfied",
    explanation: "all criteria met",
    iteration: 0,
    usage: { input_tokens: 100, output_tokens: 20 },
  },
};

describe("event registry", () => {
  it("has a sample for every registered type, and every sample parses", () => {
    for (const type of KNOWN_EVENT_TYPES) {
      expect(SAMPLES[type], `missing sample for ${type}`).toBeDefined();
      const issues = validateEventPayload(type, SAMPLES[type]);
      expect(issues, `${type}: ${JSON.stringify(issues)}`).toBeNull();
    }
    // No orphan samples either.
    for (const type of Object.keys(SAMPLES)) {
      expect(isKnownEventType(type), `orphan sample ${type}`).toBe(true);
    }
  });

  it("rejects malformed payloads for known types", () => {
    expect(validateEventPayload("agent.tool_use", { name: "Bash" })).not.toBeNull();
    expect(validateEventPayload("session.error", { error: "boom" })).not.toBeNull();
    expect(validateEventPayload("session.status_idle", {})).not.toBeNull();
  });

  it("treats unknown types as valid (forward compatibility)", () => {
    expect(validateEventPayload("session.something_new", { whatever: 1 })).toBeNull();
  });

  it("drift guard: claude translator output validates against the registry", () => {
    const t = createClaudeTranslator({
      customToolNames: new Set(["get_weather"]),
      isFirstTurn: true,
      turnSpanId: "span_root",
    } as never);

    const ndjson: Array<Record<string, unknown>> = [
      { type: "system", subtype: "init", session_id: "sid-1", model: "claude-sonnet-4-6" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check." },
            { type: "thinking", thinking: "planning..." },
            { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "toolu_b", name: "get_weather", input: { city: "SF" } },
            { type: "tool_use", id: "toolu_c", name: "mcp__linear__search", input: { q: "bug" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "file.txt", is_error: false },
            { type: "tool_result", tool_use_id: "toolu_c", content: "issue-1", is_error: false },
          ],
        },
      },
    ];

    let validated = 0;
    for (const raw of ndjson) {
      for (const evt of t.translate(raw)) {
        const issues = validateEventPayload(evt.type, evt.payload);
        expect(issues, `${evt.type}: ${JSON.stringify(issues)} — payload ${JSON.stringify(evt.payload)}`).toBeNull();
        validated++;
      }
    }
    expect(validated).toBeGreaterThanOrEqual(8); // message, thinking, tool spans/uses/results
  });

  it("GatewayEvent narrows on switch (ev.type)", () => {
    const base = { id: "e1", seq: 1, session_id: "s1", processed_at: null };
    const events: GatewayEvent[] = [
      { ...base, type: "agent.message", content: [{ type: "text", text: "hi" }] },
      { ...base, type: "agent.tool_use", tool_use_id: "t1", name: "Bash", input: {} },
      { ...base, type: "session.status_idle", stop_reason: { type: "end_turn" } },
      // Future/unknown types still flow at runtime — they arrive typed as
      // GatewayEvent and land in the default branch.
      { ...base, type: "session.weird_future_event", anything: true } as unknown as GatewayEvent,
    ];

    const seen: string[] = [];
    for (const ev of events) {
      switch (ev.type) {
        case "agent.message":
          seen.push(ev.content.length.toString()); // typed: ContentBlock[]
          break;
        case "agent.tool_use":
          seen.push(ev.name); // typed: string
          break;
        case "session.status_idle":
          seen.push(ev.stop_reason.type); // typed: stop reason object
          break;
        default:
          seen.push(ev.type);
      }
    }
    expect(seen).toEqual(["1", "Bash", "end_turn", "session.weird_future_event"]);
  });
});
