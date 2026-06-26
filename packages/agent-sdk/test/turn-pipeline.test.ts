/**
 * Turn decoration pipeline tests — the named stages extracted from the
 * driver, plus the user-registered turn middleware hook.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  applyTurnDecorators,
  injectVaultEnv,
  registerTurnMiddleware,
  remapAnthropicOAuth,
  remapCodexKey,
  wireLocalModels,
  wireClaudeBaseUrl,
  type TurnContext,
} from "../src/sessions/turn-pipeline";
import type { Agent } from "../src/types";

function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    sessionId: "sesn_test",
    agent: { model: { id: "claude-sonnet-4-6" }, engine: "claude" } as Agent,
    providerName: "docker",
    turnBuild: { argv: ["-p"], env: {}, stdin: "hello" },
    vaultEntries: [],
    hasResources: false,
    ...overrides,
  };
}

const unregisters: Array<() => void> = [];
afterEach(() => {
  while (unregisters.length) unregisters.pop()!();
});

describe("built-in decorators", () => {
  it("injectVaultEnv skips blocked and MCP_* keys", () => {
    const c = ctx({
      vaultEntries: [
        { key: "MY_TOKEN", value: "t1" },
        { key: "PATH", value: "evil" },            // blocked
        { key: "MCP_AUTH_LINEAR", value: "secret" }, // consumed gateway-side
        { key: "MCP_HEADER_X", value: "h" },
      ],
    });
    injectVaultEnv(c);
    expect(c.turnBuild.env).toEqual({ MY_TOKEN: "t1" });
  });

  it("remapAnthropicOAuth moves sk-ant-oat tokens and prefers the OAuth token", () => {
    const c = ctx();
    c.turnBuild.env.ANTHROPIC_API_KEY = "sk-ant-oat01-abc";
    remapAnthropicOAuth(c);
    expect(c.turnBuild.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-abc");
    expect(c.turnBuild.env.ANTHROPIC_API_KEY).toBeUndefined();

    const c2 = ctx();
    c2.turnBuild.env.ANTHROPIC_API_KEY = "sk-ant-api03-real";
    c2.turnBuild.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-x";
    remapAnthropicOAuth(c2);
    expect(c2.turnBuild.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("remapCodexKey mirrors OPENAI_API_KEY into CODEX_API_KEY", () => {
    const c = ctx();
    c.turnBuild.env.OPENAI_API_KEY = "sk-x";
    remapCodexKey(c);
    expect(c.turnBuild.env.CODEX_API_KEY).toBe("sk-x");
  });

  it("wireLocalModels wires docker host for local model ids, skips cloud prefixes", () => {
    const c = ctx({ agent: { model: { id: "llama3.2" }, engine: "claude" } as Agent });
    wireLocalModels(c);
    expect(c.turnBuild.env.OLLAMA_HOST).toBe("host.docker.internal:11434");
    expect(c.turnBuild.env.CODEX_OSS_BASE_URL).toBe("http://host.docker.internal:11434/v1");
    expect(c.turnBuild.env.OPENAI_API_KEY).toBe("ollama");

    const cloud = ctx(); // claude-sonnet-4-6
    wireLocalModels(cloud);
    expect(cloud.turnBuild.env.OLLAMA_HOST).toBeUndefined();
  });
});

describe("wireClaudeBaseUrl", () => {
  function claudeAgent(baseUrl?: string, modelId = "gemma4"): Agent {
    return {
      model: { id: modelId },
      engine: "claude",
      model_config: baseUrl ? { anthropic_base_url: baseUrl } : {},
    } as Agent;
  }

  it("injects ANTHROPIC_BASE_URL + a placeholder key when none is present", () => {
    const c = ctx({ agent: claudeAgent("https://litellm.internal:4000") });
    wireClaudeBaseUrl(c);
    expect(c.turnBuild.env.ANTHROPIC_BASE_URL).toBe("https://litellm.internal:4000");
    expect(c.turnBuild.env.ANTHROPIC_API_KEY).toBe("gateway-base-url-placeholder");
  });

  it("keeps a real key already in env (vault wins — runs after injectVaultEnv)", () => {
    const c = ctx({ agent: claudeAgent("https://litellm.internal:4000") });
    c.turnBuild.env.ANTHROPIC_API_KEY = "sk-ant-real";
    wireClaudeBaseUrl(c);
    expect(c.turnBuild.env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    // also respects an OAuth token instead of a key
    const c2 = ctx({ agent: claudeAgent("https://x") });
    c2.turnBuild.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-x";
    wireClaudeBaseUrl(c2);
    expect(c2.turnBuild.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rewrites a localhost URL to a container-reachable host (docker)", () => {
    const c = ctx({ agent: claudeAgent("http://localhost:11434"), providerName: "docker" });
    wireClaudeBaseUrl(c);
    expect(c.turnBuild.env.ANTHROPIC_BASE_URL).toBe("http://host.docker.internal:11434");
  });

  it("rewrites localhost to the VM gateway IP for apple containers", () => {
    const c = ctx({ agent: claudeAgent("http://127.0.0.1:11434"), providerName: "apple-container" });
    wireClaudeBaseUrl(c);
    expect(c.turnBuild.env.ANTHROPIC_BASE_URL).toBe("http://192.168.64.1:11434");
  });

  it("passes a non-loopback host through unchanged", () => {
    const c = ctx({ agent: claudeAgent("https://api.example.com"), providerName: "docker" });
    wireClaudeBaseUrl(c);
    expect(c.turnBuild.env.ANTHROPIC_BASE_URL).toBe("https://api.example.com");
  });

  it("is a no-op for non-claude engines and when unset", () => {
    const codex = ctx({ agent: { model: { id: "gpt-5.4" }, engine: "codex", model_config: { anthropic_base_url: "http://x" } } as Agent });
    wireClaudeBaseUrl(codex);
    expect(codex.turnBuild.env.ANTHROPIC_BASE_URL).toBeUndefined();

    const noUrl = ctx({ agent: claudeAgent(undefined, "claude-sonnet-4-6") });
    wireClaudeBaseUrl(noUrl);
    expect(noUrl.turnBuild.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(noUrl.turnBuild.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("applyTurnDecorators", () => {
  it("runs built-ins (resources dir, mcp timeout) and registered middleware in order", async () => {
    const order: string[] = [];
    unregisters.push(registerTurnMiddleware((c) => {
      order.push("mw1");
      c.turnBuild.env.AUDIT_STAMP = "tenant-a";
    }));
    unregisters.push(registerTurnMiddleware(() => { order.push("mw2"); }));

    const c = ctx({ hasResources: true, mcpTimeoutMs: 30000 });
    await applyTurnDecorators(c);

    expect(c.turnBuild.env.RESOURCES_DIR).toBe("/tmp/resources");
    expect(c.turnBuild.env.MCP_TIMEOUT).toBe("30000");
    expect(c.turnBuild.env.AUDIT_STAMP).toBe("tenant-a");
    expect(order).toEqual(["mw1", "mw2"]);
  });

  it("middleware can veto a turn by throwing", async () => {
    unregisters.push(registerTurnMiddleware((c) => {
      if (c.turnBuild.env.DATABASE_URL) {
        throw new Error("agents may not receive prod credentials");
      }
    }));
    const c = ctx({ vaultEntries: [{ key: "DATABASE_URL", value: "postgres://prod" }] });
    await expect(applyTurnDecorators(c)).rejects.toThrow(/prod credentials/);
  });

  it("unregister removes the middleware", async () => {
    let calls = 0;
    const off = registerTurnMiddleware(() => { calls++; });
    await applyTurnDecorators(ctx());
    off();
    await applyTurnDecorators(ctx());
    expect(calls).toBe(1);
  });
});
