/**
 * Sprite wrapper script for factory (droid).
 *
 * Factory's `droid exec` takes the prompt as a positional argument (like
 * opencode), NOT from stdin. The wrapper:
 *
 *   1. Reads env vars from stdin until a blank line
 *   2. Captures the remaining stdin into $PROMPT
 *   3. Execs `droid exec "$@" "$PROMPT"` — the prompt becomes the last
 *      positional arg after any flags from argv
 *
 * This mirrors the opencode wrapper pattern exactly.
 */
import type { ContainerProvider } from "../../providers/types";

export const FACTORY_WRAPPER_PATH = "/tmp/.factory-wrapper";

const SANDBOX_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  "set -e",
  // Record our PID so the gateway can stop this turn's process group on
  // interrupt (sprites HTTP exec has no kill API). Best-effort.
  'echo $$ > /tmp/.agent-turn.pid 2>/dev/null || true',
  // Read env vars from stdin until blank line. Values are base64-encoded by
  // the driver so secrets with newlines (PEM/SSH keys) survive the framing.
  'while IFS= read -r line; do [ -z "$line" ] && break; __k=${line%%=*}; __v=$(printf "%s" "${line#*=}" | base64 -d); export "$__k=$__v"; done',
  "PROMPT=$(cat)",
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
  'droid "$@" "$PROMPT"',
].join("\n");

export async function installFactoryWrapper(sandboxName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SANDBOX_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(sandboxName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${FACTORY_WRAPPER_PATH} && chmod +x ${FACTORY_WRAPPER_PATH}`,
  ]);
}
