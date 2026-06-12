/**
 * Turn decoration pipeline — the named, composable stages that prepare a
 * turn's {argv, env, stdin} before execution.
 *
 * Each decorator is one concern that used to be an inline block in
 * `driver.ts`. The driver runs `applyTurnDecorators(ctx)`: built-ins
 * first (order matters — vault injection must precede the key remaps),
 * then any middleware registered via `registerTurnMiddleware`.
 *
 * Registered middleware is the SDK's programmable turn hook: it can
 * inspect and mutate `ctx.turnBuild` (argv/env/stdin), or `throw` to
 * abort the turn before anything reaches the container — the driver
 * surfaces the throw as a `session.error` + idle, same as a buildTurn
 * failure. Policy examples: deny prod credentials to non-admin agents,
 * stamp audit env vars, rewrite model flags per tenant.
 */
import type { Agent } from "../types";
import type { BuildTurnResult } from "../backends/types";
import { BLOCKED_ENV_KEYS } from "../providers/resolve-secrets";
import { isAnthropicOAuthToken } from "../auth/passthrough";
import { getConfig } from "../config";

export interface TurnContext {
  sessionId: string;
  agent: Agent;
  /** Resolved container provider name (docker, sprites, ...). */
  providerName: string;
  /** The turn primitives — middleware mutates this in place. */
  turnBuild: BuildTurnResult;
  /** Decrypted vault entries for this session (read-only). */
  vaultEntries: ReadonlyArray<{ key: string; value: string }>;
  /** True when the session has attached resources (files/repos). */
  hasResources: boolean;
  /** Backend's default MCP connect timeout, if it uses MCP. */
  mcpTimeoutMs?: number;
}

export type TurnMiddleware = (ctx: TurnContext) => void | Promise<void>;

// ── Built-in decorators (extracted verbatim from driver.ts) ──────────────

/** Inject RESOURCES_DIR when the session has mounted resources. */
export const injectResourcesDir: TurnMiddleware = (ctx) => {
  if (ctx.hasResources) {
    ctx.turnBuild.env.RESOURCES_DIR = "/tmp/resources";
  }
};

/**
 * Backend default for MCP server connect timeout. Claude needs 30s on
 * Firecracker VMs where Node cold-start takes ~1.2s; other engines may
 * not use MCP at all (mcpTimeoutMs omitted).
 */
export const applyMcpTimeout: TurnMiddleware = (ctx) => {
  if (ctx.mcpTimeoutMs && !ctx.turnBuild.env.MCP_TIMEOUT) {
    ctx.turnBuild.env.MCP_TIMEOUT = String(ctx.mcpTimeoutMs);
  }
};

/**
 * Inject vault entries as env vars (override server defaults). Skips
 * MCP_AUTH_* / MCP_HEADER_* keys — those were already consumed as MCP
 * server headers gateway-side and must not leak into the container env.
 */
const MCP_KEY_RE = /^MCP_(AUTH|HEADER)_/i;
export const injectVaultEnv: TurnMiddleware = (ctx) => {
  for (const entry of ctx.vaultEntries) {
    if (!BLOCKED_ENV_KEYS.has(entry.key) && !MCP_KEY_RE.test(entry.key)) {
      ctx.turnBuild.env[entry.key] = entry.value;
    }
  }
};

/**
 * If vault provides OPENAI_API_KEY, also set CODEX_API_KEY so the codex
 * backend picks it up (codex checks CODEX_API_KEY before OPENAI_API_KEY).
 */
export const remapCodexKey: TurnMiddleware = (ctx) => {
  const env = ctx.turnBuild.env;
  if (env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
    env.CODEX_API_KEY = env.OPENAI_API_KEY;
  }
};

/**
 * Auto-remap: if ANTHROPIC_API_KEY is an OAuth token (sk-ant-oat*), move
 * it to CLAUDE_CODE_OAUTH_TOKEN — the claude CLI doesn't recognize OAuth
 * tokens in ANTHROPIC_API_KEY. And when both are present, drop
 * ANTHROPIC_API_KEY so the OAuth token wins.
 */
export const remapAnthropicOAuth: TurnMiddleware = (ctx) => {
  const env = ctx.turnBuild.env;
  if (isAnthropicOAuthToken(env.ANTHROPIC_API_KEY)) {
    env.CLAUDE_CODE_OAUTH_TOKEN = env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY;
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN && env.ANTHROPIC_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
  }
};

/**
 * Local-model wiring: inject env vars so backend CLIs can reach the
 * host's Ollama server from inside the container.
 * - OLLAMA_HOST: used by the ollama CLI itself (host:port, no scheme)
 * - CODEX_OSS_BASE_URL: used by Codex --local-provider ollama
 * - OPENCODE_CONFIG_CONTENT: patched with the correct baseURL
 */
const OLLAMA_CLOUD_PREFIXES = ["claude-", "gpt-", "o1-", "o3-", "o4-", "codex-", "chatgpt-", "gemini-"];
export const wireLocalModels: TurnMiddleware = (ctx) => {
  const env = ctx.turnBuild.env;
  const modelId = ctx.agent.model.id;
  const isOllamaModel = !modelId.includes("/") && !OLLAMA_CLOUD_PREFIXES.some((p) => modelId.startsWith(p));
  if (!isOllamaModel) return;

  let ollamaHostPort: string | undefined;
  if (!env.OLLAMA_HOST) {
    if (ctx.providerName === "docker" || ctx.providerName === "podman") {
      ollamaHostPort = "host.docker.internal:11434";
    } else if (ctx.providerName === "apple-container" || ctx.providerName === "apple-firecracker") {
      // Apple Containers run in VMs — localhost inside the VM doesn't reach
      // the host. Ollama must listen on 0.0.0.0; the container reaches the
      // host via its gateway IP (192.168.64.1 by default).
      const customUrl = getConfig().ollamaUrl;
      ollamaHostPort = customUrl !== "http://localhost:11434"
        ? customUrl.replace(/^https?:\/\//, "")
        : "192.168.64.1:11434";
    }
    if (ollamaHostPort) {
      env.OLLAMA_HOST = ollamaHostPort;
    }
  } else {
    ollamaHostPort = env.OLLAMA_HOST;
  }
  // Codex reads CODEX_OSS_BASE_URL (not OLLAMA_HOST) for --local-provider ollama
  if (ollamaHostPort && !env.CODEX_OSS_BASE_URL) {
    const host = ollamaHostPort.replace(/^https?:\/\//, "");
    env.CODEX_OSS_BASE_URL = `http://${host}/v1`;
  }
  // Patch OpenCode's OPENCODE_CONFIG_CONTENT with the correct Ollama baseURL
  if (ollamaHostPort && env.OPENCODE_CONFIG_CONTENT) {
    try {
      const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      const host = ollamaHostPort.replace(/^https?:\/\//, "");
      if (cfg.provider?.ollama?.options) {
        cfg.provider.ollama.options.baseURL = `http://${host}/v1`;
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfg);
      }
    } catch { /* leave config as-is if parse fails */ }
  }
  // Codex needs dummy keys to not error on startup
  if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = "ollama";
  if (!env.CODEX_API_KEY) env.CODEX_API_KEY = "ollama";
};

/** The built-in pipeline, in execution order. Order matters. */
export const BUILT_IN_DECORATORS: readonly TurnMiddleware[] = [
  injectResourcesDir,
  applyMcpTimeout,
  injectVaultEnv,
  remapCodexKey,
  remapAnthropicOAuth,
  wireLocalModels,
];

// ── User-registered middleware ────────────────────────────────────────────

type GlobalHooks = typeof globalThis & {
  __caTurnMiddleware?: TurnMiddleware[];
};

function registered(): TurnMiddleware[] {
  const g = globalThis as GlobalHooks;
  if (!g.__caTurnMiddleware) g.__caTurnMiddleware = [];
  return g.__caTurnMiddleware;
}

/**
 * Register a turn middleware that runs after the built-in decorators on
 * every turn. Returns an unregister function. Middleware may mutate
 * `ctx.turnBuild` or throw to abort the turn (surfaced as a
 * `session.error` before anything reaches the container).
 */
export function registerTurnMiddleware(fn: TurnMiddleware): () => void {
  registered().push(fn);
  return () => {
    const list = registered();
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Run built-ins then registered middleware against the turn context. */
export async function applyTurnDecorators(ctx: TurnContext): Promise<void> {
  for (const fn of BUILT_IN_DECORATORS) await fn(ctx);
  for (const fn of [...registered()]) await fn(ctx);
}
