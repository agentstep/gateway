/**
 * Auth env + create-time validation for the gemini backend.
 *
 * Gemini CLI reads GEMINI_API_KEY from the environment. We forward it
 * from config.geminiApiKey (which cascades from process.env.GEMINI_API_KEY
 * or the settings table).
 */
import { getConfig } from "../../config";

export function buildGeminiAuthEnv(): Record<string, string> {
  const cfg = getConfig();
  const env: Record<string, string> = {};
  if (cfg.geminiApiKey) {
    env.GEMINI_API_KEY = cfg.geminiApiKey;
  }
  return env;
}

/**
 * Returns null if gemini can run, or an error message if it can't. Used at
 * agent create time (validateAgentCreation) and first-turn time
 * (validateRuntime).
 */
export function validateGeminiRuntime(): string | null {
  // Vault entries are injected by the driver AFTER buildTurn(), so
  // getConfig() won't see vault-provided keys at this point. Return
  // null and let the CLI surface the auth error in its NDJSON stream.
  return null;
}
