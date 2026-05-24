/**
 * Build the `opencode run` argv for one turn.
 *
 * Opencode-specific constraints:
 * - No --max-turns (opencode has no equivalent; silently ignored)
 * - No --allowed-tools / --disallowed-tools (tools are configured via
 *   ~/.opencode.json permissions, not per-agent CLI flags — agents with
 *   a non-empty `tools` field are rejected at create time)
 * - No --permission-mode (opencode `run` is non-interactive by design)
 * - No --system-prompt flag — system prompt is wrapped into the user
 *   prompt text via `wrapOpencodePrompt`
 * - No --mcp-config flag — MCP config is delivered via the
 *   OPENCODE_CONFIG_CONTENT env var (see mcp.ts)
 */
import type { Agent } from "../../types";

export interface BuildOpencodeArgsInput {
  agent: Agent;
  /** Prior turn's opencode sessionID, if any, for --session resume */
  backendSessionId: string | null;
}

/**
 * Normalize model ID for the opencode CLI. Opencode expects provider-prefixed
 * IDs (e.g., "anthropic/claude-sonnet-4-6"). Bare IDs are prefixed based on
 * well-known patterns. Unknown models get "ollama/" (local provider).
 */
function normalizeOpencodeModel(model: string): string {
  if (model.includes("/")) return model; // Already prefixed
  if (model.startsWith("claude-")) return `anthropic/${model}`;
  if (model.startsWith("gemini-")) return `google/${model}`;
  if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-") || model.startsWith("o4-") || model.startsWith("chatgpt-")) return `openai/${model}`;
  return `ollama/${model}`; // Unknown → assume local Ollama model
}

export function buildOpencodeArgs(input: BuildOpencodeArgsInput): string[] {
  const args = ["run", "--format", "json", "--dangerously-skip-permissions"];
  if (input.backendSessionId) {
    args.push("--session", input.backendSessionId);
  }
  if (input.agent.model) {
    args.push("--model", normalizeOpencodeModel(input.agent.model.id));
  }
  return args;
}

/**
 * Wrap the user prompt with an optional system prompt prefix.
 *
 * Opencode's `run` subcommand has no `--system-prompt` flag, so
 *  prepends the system prompt to the user message with a
 * separator, exactly as ported here.
 *
 * Verbatim from
 * 
 */
export function wrapOpencodePrompt(
  prompt: string,
  systemPrompt: string | null | undefined,
): string {
  if (!systemPrompt) return prompt;
  return `Instructions: ${systemPrompt}\n\n---\n\n${prompt}`;
}
