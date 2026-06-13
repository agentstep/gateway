/**
 * Explicit runtime — createRuntime()/close() as the public form of the
 * test suite's singleton-reset ritual, plus runtime-scoped turn
 * middleware and the one-runtime-per-process guard.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRuntime, resetEngineState } from "../src/runtime";

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-test-")), "test.db");
}

afterEach(() => {
  resetEngineState();
  delete (globalThis as Record<string, unknown>).__caRuntimeOpen;
});

describe("createRuntime", () => {
  it("boots against the configured db, isolates across close/create cycles", async () => {
    const rt1 = await createRuntime({ db: { path: tmpDbPath() }, concurrency: 0, defaultProvider: "docker" });
    const { createApiKey } = await import("../src/db/api_keys");
    createApiKey({ name: "t", permissions: ["*"], rawKey: "rt-key-1-12345" });
    const { createClient } = await import("../src/client/index");
    const gw1 = createClient({ apiKey: "rt-key-1-12345" });
    const agent = await gw1.agents.create({ name: "RtAgent", model: "claude-sonnet-4-6" });
    expect(agent.id).toBeTruthy();
    await rt1.close();

    // A second runtime against a fresh DB sees none of the first's state.
    const rt2 = await createRuntime({ db: { path: tmpDbPath() }, concurrency: 0 });
    createApiKey({ name: "t2", permissions: ["*"], rawKey: "rt-key-2-12345" });
    const gw2 = createClient({ apiKey: "rt-key-2-12345" });
    const page = await gw2.agents.list({ limit: 100 });
    expect(page.data.some((a) => a.id === agent.id)).toBe(false);
    await rt2.close();
  });

  it("rejects a second concurrent runtime; close() is idempotent", async () => {
    const rt = await createRuntime({ db: { path: tmpDbPath() }, concurrency: 0 });
    await expect(createRuntime({ db: { path: tmpDbPath() } })).rejects.toThrow(/already open/);
    await rt.close();
    await rt.close(); // no-op
    const rt2 = await createRuntime({ db: { path: tmpDbPath() }, concurrency: 0 });
    await rt2.close();
  });

  it("registers turn middleware for the runtime's lifetime", async () => {
    let calls = 0;
    const rt = await createRuntime({
      db: { path: tmpDbPath() },
      concurrency: 0,
      turnMiddleware: [() => { calls++; }],
    });

    const { applyTurnDecorators } = await import("../src/sessions/turn-pipeline");
    const ctx = {
      sessionId: "s",
      agent: { model: { id: "claude-sonnet-4-6" }, engine: "claude" } as never,
      providerName: "docker",
      turnBuild: { argv: [], env: {}, stdin: "" },
      vaultEntries: [],
      hasResources: false,
    };
    await applyTurnDecorators(ctx);
    expect(calls).toBe(1);

    await rt.close();
    await applyTurnDecorators(ctx);
    expect(calls).toBe(1); // unregistered on close
  });
});
