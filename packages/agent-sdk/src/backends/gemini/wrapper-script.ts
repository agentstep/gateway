/**
 * Sprite wrapper script for gemini.
 *
 * Same structure as the claude/codex wrapper: gemini accepts the prompt on
 * stdin via `-p`, so the wrapper reads env vars from stdin until a blank
 * line, then execs gemini with the remaining stdin piped through as the
 * prompt.
 */
import type { ContainerProvider } from "../../providers/types";

export const GEMINI_WRAPPER_PATH = "/tmp/.gemini-wrapper";

const SANDBOX_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  'exec gemini "$@"',
].join("\n");

export async function installGeminiWrapper(sandboxName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SANDBOX_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(sandboxName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${GEMINI_WRAPPER_PATH} && chmod +x ${GEMINI_WRAPPER_PATH}`,
  ]);
}
