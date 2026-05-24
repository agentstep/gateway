/**
 * Tests for OpenCode backend argument construction and model normalization.
 * OpenCode CLI expects provider-prefixed model IDs.
 */

import { describe, it, expect } from "vitest";
import { buildOpencodeArgs } from "../src/backends/opencode/args";
import type { Agent } from "../src/types";

function makeAgent(modelId: string): Agent {
  return {
    id: "agent_test",
    name: "test",
    version: 1,
    engine: "opencode",
    model: { id: modelId },
    system: null,
    tools: [],
    mcp_servers: [],
    skills: [],
    metadata: {},
  } as unknown as Agent;
}

describe("buildOpencodeArgs model normalization", () => {
  it("prefixes claude-* with anthropic/", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("claude-sonnet-4-6"), backendSessionId: null });
    expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  it("prefixes gemini-* with google/", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("gemini-2.5-flash"), backendSessionId: null });
    expect(args[args.indexOf("--model") + 1]).toBe("google/gemini-2.5-flash");
  });

  it("prefixes gpt-* with openai/", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("gpt-5.4"), backendSessionId: null });
    expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-5.4");
  });

  it("prefixes o1-* with openai/", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("o1-preview"), backendSessionId: null });
    expect(args[args.indexOf("--model") + 1]).toBe("openai/o1-preview");
  });

  it("passes through already-prefixed models unchanged", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("anthropic/claude-sonnet-4-6"), backendSessionId: null });
    expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  it("prefixes unknown models with ollama/ (local provider)", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("llama-3.1-70b"), backendSessionId: null });
    expect(args[args.indexOf("--model") + 1]).toBe("ollama/llama-3.1-70b");
  });

  it("includes run, --format json, --dangerously-skip-permissions", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("claude-sonnet-4-6"), backendSessionId: null });
    expect(args[0]).toBe("run");
    expect(args).toContain("--format");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("adds --session when backendSessionId provided", () => {
    const args = buildOpencodeArgs({ agent: makeAgent("claude-sonnet-4-6"), backendSessionId: "sess-abc" });
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("sess-abc");
  });
});
