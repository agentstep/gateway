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

export const SANDBOX_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  // Record our PID so the gateway can stop this turn's process group on
  // interrupt (sprites HTTP exec has no kill API). Best-effort.
  'echo $$ > /tmp/.agent-turn.pid 2>/dev/null || true',
  // Read env vars from stdin until blank line. Values are base64-encoded by
  // the driver so secrets with newlines (PEM/SSH keys) survive the framing;
  // the printf-x sentinel keeps trailing newlines that $() would strip.
  'while IFS= read -r line; do [ -z "$line" ] && break; __k=${line%%=*}; __v=$(printf "%s" "${line#*=}" | base64 -d; printf x); export "$__k=${__v%x}"; done',
  // Sprites keep-alive: prevent VM suspension during long agent turns.
  'SPRITE_SOCK="/.sprite/api.sock"',
  'HEARTBEAT_PID=""',
  'if [ -S "$SPRITE_SOCK" ]; then',
  '  curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" \\',
  '    -X POST http://sprite/v1/tasks \\',
  '    -H "Content-Type: application/json" \\',
  '    -d \'{"name":"agent-turn","expire":"5m"}\' >/dev/null 2>&1',
  '  (while sleep 60; do',
  '    curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" \\',
  '      -X PUT http://sprite/v1/tasks/agent-turn \\',
  '      -H "Content-Type: application/json" \\',
  '      -d \'{"expire":"5m"}\' >/dev/null 2>&1',
  '  done) &',
  '  HEARTBEAT_PID=$!',
  '  trap \'curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" -X DELETE http://sprite/v1/tasks/agent-turn >/dev/null 2>&1; [ -n "$HEARTBEAT_PID" ] && kill $HEARTBEAT_PID 2>/dev/null\' EXIT',
  'fi',
  'gemini "$@"',
].join("\n");

export async function installGeminiWrapper(sandboxName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SANDBOX_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(sandboxName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${GEMINI_WRAPPER_PATH} && chmod +x ${GEMINI_WRAPPER_PATH}`,
  ]);
}
