/**
 * Custom Anthropic-compatible endpoints for the claude engine.
 *
 * Claude Code honours ANTHROPIC_BASE_URL, so the claude harness can drive
 * any backend that implements /v1/messages + /v1/messages/count_tokens —
 * Ollama's compat endpoint for local models, provider-native compat
 * endpoints (GLM/Kimi/DeepSeek), or a LiteLLM hop. The gateway exposes this
 * as `model_config.anthropic_base_url` on claude-engine agents:
 *
 *   - buildTurn injects ANTHROPIC_BASE_URL into the engine env
 *   - with no gateway-level Anthropic key, a placeholder ANTHROPIC_API_KEY
 *     is injected so the CLI doesn't refuse to start against endpoints that
 *     ignore auth (Ollama); vault entries are merged AFTER buildTurn and
 *     override it, so a real key still wins
 *   - model/engine validation accepts non-claude model IDs on the claude
 *     engine when (and only when) a base-url override is configured
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Agent } from "../src/types";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-baseurl-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  for (const k of ["__caDb", "__caDrizzle", "__caInitialized", "__caConfigCache"]) {
    delete g[k];
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_test",
    version: 1,
    name: "test",
    type: "agent" as const,
    model: { id: "claude-sonnet-4-6" },
    description: "",
    metadata: {},
    engine: "claude" as const,
    system: null,
    tools: [],
    mcp_servers: [],
    skills: [],
    webhook_url: null,
    webhook_events: [],
    webhook_signing_enabled: false,
    threads_enabled: false,
    confirmation_mode: false,
    callable_agents: [],
    model_config: {},
    fallback_json: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Agent;
}

function buildInput(agent: Agent) {
  return {
    agent,
    backendSessionId: null,
    promptText: "hello",
    toolResults: [],
  };
}

describe("claude engine base-url override", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("injects ANTHROPIC_BASE_URL into the engine env", async () => {
    const { resolveBackend } = await import("../src/backends/registry");
    const agent = makeAgent({
      model: { id: "gemma4" },
      model_config: { anthropic_base_url: "http://host.docker.internal:11434" },
    });
    const turn = resolveBackend("claude").buildTurn(buildInput(agent));
    expect(turn.env.ANTHROPIC_BASE_URL).toBe("http://host.docker.internal:11434");
  });

  it("injects a placeholder API key when the gateway has none configured", async () => {
    const { resolveBackend } = await import("../src/backends/registry");
    const agent = makeAgent({
      model: { id: "gemma4" },
      model_config: { anthropic_base_url: "http://host.docker.internal:11434" },
    });
    const turn = resolveBackend("claude").buildTurn(buildInput(agent));
    // Claude Code refuses to start with no credential at all; endpoints like
    // Ollama ignore the value. Vault entries merge after buildTurn and
    // override this, so a real key still wins.
    expect(turn.env.ANTHROPIC_API_KEY).toBeTruthy();
  });

  it("keeps the real gateway key when one is configured", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-real-key";
    const g = globalThis as typeof globalThis & Record<string, unknown>;
    delete g.__caConfigCache;
    const { resolveBackend } = await import("../src/backends/registry");
    const agent = makeAgent({
      model_config: { anthropic_base_url: "https://litellm.internal:4000" },
    });
    const turn = resolveBackend("claude").buildTurn(buildInput(agent));
    expect(turn.env.ANTHROPIC_API_KEY).toBe("sk-ant-real-key");
    expect(turn.env.ANTHROPIC_BASE_URL).toBe("https://litellm.internal:4000");
  });

  it("does not set ANTHROPIC_BASE_URL without an override", async () => {
    const { resolveBackend } = await import("../src/backends/registry");
    const turn = resolveBackend("claude").buildTurn(buildInput(makeAgent()));
    expect(turn.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe("model validation with base-url override", () => {
  it("rejects a non-claude model on the claude engine without an override", async () => {
    const { isValidModelForEngine } = await import("../src/backends/models");
    expect(isValidModelForEngine("claude", "gemma4")).toBe(true); // local-style id already allowed
    expect(isValidModelForEngine("claude", "gpt-5.4")).toBe(false);
  });

  it("accepts any model on the claude engine with an override", async () => {
    const { isValidModelForEngine } = await import("../src/backends/models");
    expect(isValidModelForEngine("claude", "gpt-5.4", { baseUrlOverride: true })).toBe(true);
    expect(isValidModelForEngine("claude", "gemini-2.5-pro", { baseUrlOverride: true })).toBe(true);
  });

  it("an override does not bypass validation for other engines", async () => {
    const { isValidModelForEngine } = await import("../src/backends/models");
    expect(isValidModelForEngine("gemini", "gpt-5.4", { baseUrlOverride: true })).toBe(false);
  });
});
