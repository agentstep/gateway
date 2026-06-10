/**
 * The current Anthropic flagship models must be available through every
 * static model surface — the bundled curated catalog (served raw from
 * GitHub as a registry source) and the FALLBACK_MODELS safety net used
 * when the dynamic registry has no data. A stale whitelist here means
 * "drop-in replacement" users cannot select the models Anthropic ships.
 */
import { describe, it, expect } from "vitest";
import catalog from "../src/lib/model-catalog.json";
import { FALLBACK_MODELS, isValidModelForEngine } from "../src/backends/models";

const FLAGSHIPS = ["claude-fable-5", "claude-opus-4-8"];

describe("flagship model availability", () => {
  it.each(FLAGSHIPS)("%s is in the bundled curated catalog", (id) => {
    const entry = (catalog as Record<string, { litellm_provider?: string }>)[id];
    expect(entry).toBeDefined();
    expect(entry.litellm_provider).toBe("anthropic");
  });

  it.each(FLAGSHIPS)("%s is in the claude-engine fallback list", (id) => {
    expect(FALLBACK_MODELS.claude).toContain(id);
  });

  it.each(FLAGSHIPS)("%s validates for the claude engine", (id) => {
    expect(isValidModelForEngine("claude", id)).toBe(true);
  });
});
