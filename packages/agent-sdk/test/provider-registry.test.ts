/**
 * Tests for the container provider registry.
 */
import { describe, it, expect } from "vitest";
import { resolveContainerProvider } from "../src/providers/registry";

describe("provider registry", () => {
  it("resolves each registry key to a provider that reports its own name", async () => {
    for (const key of [
      "sprites",
      "docker",
      "apple-container",
      "apple-firecracker",
      "podman",
      "e2b",
      "vercel",
      "daytona",
      "fly",
      "modal",
      "mvm",
      "anthropic",
      "cloudflare",
    ] as const) {
      const provider = await resolveContainerProvider(key);
      expect(provider.name).toBe(key);
    }
  });

  it("mvm is no longer mislabelled as apple-firecracker", async () => {
    const mvm = await resolveContainerProvider("mvm");
    const af = await resolveContainerProvider("apple-firecracker");
    // Same underlying `mvm` binary, distinct reported identities.
    expect(mvm.name).toBe("mvm");
    expect(af.name).toBe("apple-firecracker");
  });

  it("throws a helpful error for an unknown provider", async () => {
    await expect(resolveContainerProvider("nope")).rejects.toThrow(/Unknown provider/);
  });
});
