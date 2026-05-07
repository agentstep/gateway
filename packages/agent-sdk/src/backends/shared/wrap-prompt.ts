/**
 * Gateway preamble appended to every agent's system prompt. Addresses
 * common issues: tool discovery latency, premature end_turn after
 * announcing actions, and custom tool discoverability.
 */
export const GATEWAY_PREAMBLE =
  "You are running inside an AgentStep sandboxed container. " +
  "Execute tools directly — never announce what you will do before doing it. " +
  "All tools are already available; do not search for or discover tools. " +
  "If custom tools are defined, use them by name immediately.";

/**
 * A mounted memory store description for the system prompt.
 */
export interface MountedMemoryStore {
  name: string;
  access: "read_only" | "read_write";
  description?: string | null;
  instructions?: string;
}

/**
 * Append the gateway preamble to a user-provided system prompt.
 * Used by Claude (--system-prompt) and as a building block for
 * wrapPromptWithSystem (opencode, codex, etc.).
 *
 * When memory stores are mounted, adds instructions listing the mount paths.
 */
export function withGatewayPreamble(
  system: string | null | undefined,
  memoryStores?: MountedMemoryStore[],
): string {
  let preamble = system ? `${system}\n\n${GATEWAY_PREAMBLE}` : GATEWAY_PREAMBLE;

  if (memoryStores && memoryStores.length > 0) {
    const lines = memoryStores.map(s => {
      const parts: string[] = [];
      parts.push(`- /mnt/memory/${s.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}/ (${s.access})`);
      if (s.description) parts[0] += ` — ${s.description}`;
      if (s.instructions) parts[0] += `. ${s.instructions}`;
      return parts[0];
    });
    preamble += `\n\nMemory stores are mounted at /mnt/memory/:\n${lines.join("\n")}`;
  }

  return preamble;
}

/**
 * Shared prompt wrapper for backends that lack a `--system-prompt` CLI flag
 * (opencode, codex). If a system prompt is set on the agent, prepend it to
 * the user prompt with a separator. If no system prompt, return the prompt
 * unchanged.
 *
 * (opencode) and 253-256 (codex) — both use the identical wrapping format.
 */
export function wrapPromptWithSystem(
  prompt: string,
  systemPrompt: string | null | undefined,
  skills?: Array<{ name: string; content: string }>,
  memoryStores?: MountedMemoryStore[],
): string {
  let systemBlock = withGatewayPreamble(systemPrompt, memoryStores);

  if (skills && skills.length > 0) {
    const skillsText = skills.map(s =>
      `<skill name="${s.name}">\n${s.content}\n</skill>`
    ).join("\n\n");
    systemBlock = `${systemBlock}\n\n## Agent Skills\n\n${skillsText}`;
  }

  return `Instructions: ${systemBlock}\n\n---\n\n${prompt}`;
}
