/**
 * The wrapper scripts read `KEY=base64(value)` lines from stdin until a blank
 * line and export each decoded pair. Values are base64-encoded by the driver
 * so secrets containing newlines (PEM/SSH keys) survive the line-based
 * framing — which only holds if the wrapper-side decode preserves the bytes
 * exactly. `$(... | base64 -d)` alone strips trailing newlines (command
 * substitution semantics), silently corrupting keys whose format requires a
 * final newline.
 *
 * This test extracts the env-read loop from each backend's real wrapper
 * script and runs it under bash, asserting an exact round-trip.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const WRAPPERS: Array<{ name: string; load: () => Promise<{ SANDBOX_WRAPPER_SCRIPT: string }> }> = [
  { name: "claude", load: () => import("../src/backends/claude/wrapper-script") },
  { name: "codex", load: () => import("../src/backends/codex/wrapper-script") },
  { name: "gemini", load: () => import("../src/backends/gemini/wrapper-script") },
  { name: "factory", load: () => import("../src/backends/factory/wrapper-script") },
  { name: "opencode", load: () => import("../src/backends/opencode/wrapper-script") },
  { name: "pi", load: () => import("../src/backends/pi/wrapper-script") },
];

/** The exact env-read loop line as it ships in the wrapper. */
function extractReadLoop(script: string): string {
  const m = script.match(/^.*while IFS= read -r line.*done.*$/m);
  if (!m) throw new Error("env-read loop not found in wrapper script");
  return m[0];
}

// A PEM-shaped secret: internal newlines AND a trailing newline, all of
// which must survive the framing byte-for-byte.
const SECRET = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n";

describe.each(WRAPPERS)("$name wrapper env framing", ({ load }) => {
  it("round-trips a multi-line secret with trailing newline exactly", async () => {
    const { SANDBOX_WRAPPER_SCRIPT } = await load();
    const loop = extractReadLoop(SANDBOX_WRAPPER_SCRIPT);
    const encoded = Buffer.from(SECRET).toString("base64");
    // Run the shipped loop, then print the decoded var byte-for-byte.
    const harness = `${loop}\nprintf '%s' "$MY_SECRET"`;
    const out = execFileSync("bash", ["-c", harness], {
      input: `MY_SECRET=${encoded}\n\nignored prompt body`,
    });
    expect(out.toString()).toBe(SECRET);
  });
});
