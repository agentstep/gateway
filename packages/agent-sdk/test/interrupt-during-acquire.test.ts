/**
 * Interrupt during the sandbox-acquire window.
 *
 * Regression test for the driver registering its abort controller BEFORE
 * acquiring the sandbox. An interrupt that lands while the (slow) acquire is
 * in flight must be honoured — the turn must NOT proceed to execute the engine,
 * and the session must settle to idle{interrupted}. Previously the controller
 * was registered only after acquire, so `interruptSession` was a silent no-op
 * during that window.
 *
 * No real sprites/engine — acquire is gated on a promise the test controls.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// A gate the test resolves to release the mocked acquire.
let acquireGate: { promise: Promise<string>; resolve: (v: string) => void };
function newGate(): void {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  acquireGate = { promise, resolve };
}

vi.mock("../src/containers/exec", async () => {
  const fake = await import("./helpers/fake-exec");
  return { startExec: fake.startExec };
});

vi.mock("../src/containers/lifecycle", () => ({
  // Slow acquire — blocks until the test resolves the gate.
  acquireForFirstTurn: vi.fn(() => acquireGate.promise),
  releaseSession: vi.fn(async () => {}),
  reconcileOrphanSandboxes: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  reconcileDockerOrphanSandboxes: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  fillWarmPools: vi.fn(async () => {}),
  installSkills: vi.fn(async () => {}),
  provisionResources: vi.fn(async () => {}),
  wrapProviderWithSecrets: (p: unknown) => p,
}));

vi.mock("../src/providers/registry", async () => {
  const fake = await import("./helpers/fake-exec");
  const fakeProvider = {
    name: "sprites",
    stripControlChars: true,
    startExec: fake.startExec,
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0 })),
    create: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  };
  return {
    resolveContainerProvider: async () => fakeProvider,
    resolveProvider: async () => fakeProvider,
    tryResolveProvider: async () => fakeProvider,
    resolveProviderName: () => "sprites",
  };
});

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-int-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
  const g = globalThis as Record<string, unknown>;
  for (const k of ["__caDb", "__caDrizzle", "__caInitialized", "__caBusEmitters", "__caConfigCache", "__caRuntime"]) {
    delete g[k];
  }
}

async function seed(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  db.prepare(`INSERT INTO agents (id, current_version, name, created_at, updated_at) VALUES ('a', 1, 't', 0, 0)`).run();
  db.prepare(
    `INSERT INTO agent_versions (agent_id, version, model, system, tools_json, mcp_servers_json, backend, created_at)
     VALUES ('a', 1, 'anthropic/claude-sonnet-4-6', NULL, '[]', '{}', 'opencode', 0)`,
  ).run();
  db.prepare(`INSERT INTO environments (id, name, config_json, state, created_at) VALUES ('e', 't', '{}', 'ready', 0)`).run();
  db.prepare(
    `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, title, metadata_json, created_at, updated_at, sandbox_name)
     VALUES ('s', 'a', 1, 'e', 'idle', NULL, '{}', 0, 0, NULL)`,
  ).run();
  return "s";
}

describe("interrupt during sandbox acquire", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
    newGate();
  });

  it("honours an interrupt while acquire is in flight and never runs the turn", async () => {
    const sessionId = await seed();
    const { runTurn } = await import("../src/sessions/driver");
    const { interruptSession } = await import("../src/sessions/interrupt");

    // Start the turn but don't await — it will block on the acquire gate.
    const turn = runTurn(sessionId, [{ kind: "text", eventId: "e1", text: "hi" }]);

    // Let runTurn reach (and await) the acquire. The controller must already
    // be registered, so the interrupt lands instead of being a no-op.
    await new Promise((r) => setTimeout(r, 20));
    const wasRegistered = interruptSession(sessionId);
    expect(wasRegistered).toBe(true);

    // Release the acquire; the driver should now detect the abort and bail.
    acquireGate.resolve("ca-sess-fake");
    await turn;

    const { getDb } = await import("../src/db/client");
    const events = getDb()
      .prepare(`SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as { type: string; payload_json: string }[];
    const types = events.map((e) => e.type);

    // Settled as interrupted...
    const idle = events.filter((e) => e.type === "session.status_idle").at(-1);
    expect(idle).toBeDefined();
    expect(JSON.parse(idle!.payload_json).stop_reason).toEqual({ type: "interrupted" });

    // ...and the turn never started executing (no run/span-start emitted).
    expect(types).not.toContain("session.status_running");
    expect(types).not.toContain("span.model_request_start");

    // Controller cleaned up.
    const { getRuntime } = await import("../src/state");
    expect(getRuntime().inFlightRuns.has(sessionId)).toBe(false);

    // Session row is idle/interrupted.
    const row = getDb().prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as { status: string };
    expect(row.status).toBe("idle");
  });
});
