/**
 * Codex backend: drives OpenAI's `codex exec` on sprites.dev containers.
 *
 * The wrapper script + install flow mirror the opencode adapter's
 * sandbox-side patterns (see `wrapper-script.ts`).
 *
 * Custom tool re-entry is not wired up yet: we drive codex through its
 * one-shot `codex exec` mode, which cannot accept input mid-turn. Codex's
 * bidirectional `codex app-server` JSON-RPC protocol could support it
 * (future work). buildTurn rejects toolResults.length > 0 with an
 * invalid_request_error.
 */
import { ApiError } from "../../errors";
import type { Backend, BuildTurnInput, BuildTurnResult } from "../types";
import type { TranslatorOptions } from "../shared/translator-types";
import { wrapPromptWithSystem } from "../shared/wrap-prompt";
import { buildCodexArgs } from "./args";
import { buildCodexAuthEnv, validateCodexRuntime } from "./auth";
import { createCodexTranslator } from "./translator";
import { CODEX_WRAPPER_PATH } from "./wrapper-script";
import { prepareCodexOnSandbox } from "./setup";

function buildTurn(input: BuildTurnInput): BuildTurnResult {
  const { agent, promptText, toolResults } = input;
  if (toolResults.length > 0) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "codex backend does not support user.custom_tool_result re-entry in v1",
    );
  }
  const argv = buildCodexArgs({ agent });
  const env = buildCodexAuthEnv();
  const wrappedPrompt = wrapPromptWithSystem(promptText, agent.system, agent.skills);
  return { argv, env, stdin: wrappedPrompt };
}

const FIRECRACKER_PROVIDERS = new Set(["sprites", "fly", "apple-firecracker"]);

export const codexBackend: Backend = {
  name: "codex",
  wrapperPath: CODEX_WRAPPER_PATH,
  buildTurn,
  createTranslator: (opts: TranslatorOptions) => createCodexTranslator(opts),
  prepareOnSandbox: (name, provider) => prepareCodexOnSandbox(name, provider),

  validateRuntime: validateCodexRuntime,

  // Codex's bwrap inner sandbox conflicts with firecracker VMs that
  // don't expose user namespaces — the outer VM already isolates.
  // Replace --full-auto with --dangerously-bypass-approvals-and-sandbox
  // (--yolo) which skips bwrap entirely. (openai/codex#15282)
  applyProviderQuirks(turnBuild, providerName) {
    if (!FIRECRACKER_PROVIDERS.has(providerName)) return;
    const faIdx = turnBuild.argv.indexOf("--full-auto");
    if (faIdx >= 0) turnBuild.argv.splice(faIdx, 1);
    const lastIdx = turnBuild.argv.lastIndexOf("-");
    if (lastIdx >= 0) {
      turnBuild.argv.splice(lastIdx, 0, "--dangerously-bypass-approvals-and-sandbox");
    } else {
      turnBuild.argv.push("--dangerously-bypass-approvals-and-sandbox");
    }
  },
};

export {
  buildCodexArgs,
  buildCodexAuthEnv,
  createCodexTranslator,
  prepareCodexOnSandbox,
  CODEX_WRAPPER_PATH,
};
