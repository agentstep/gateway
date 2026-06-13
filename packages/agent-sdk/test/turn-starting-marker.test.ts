/**
 * Ownership semantics for the `startingTurns` marker.
 *
 * The marker covers the window between "a turn was scheduled" and "the turn
 * registered its abort controller in inFlightRuns". runTurn's wrapper clears
 * it in a `finally` — but the inner happy/interrupt paths call scheduleDrain
 * first, which marks the session again for the NEXT turn. An unconditional
 * clear in the wrapper would clobber that successor's marker, re-opening the
 * concurrent-turn race during the successor's pre-registration window
 * (observable whenever the driver awaits before registering, e.g. the
 * api-key budget check's dynamic import).
 *
 * Like inFlightRuns' `deregister`, clears must therefore be ownership-checked:
 * markTurnStarting returns an epoch, and clearTurnStarting only removes the
 * marker when the epoch still matches.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-marker-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
  const g = globalThis as Record<string, unknown>;
  for (const k of ["__caDb", "__caDrizzle", "__caInitialized", "__caBusEmitters", "__caConfigCache", "__caRuntime"]) {
    delete g[k];
  }
}

describe("startingTurns marker epochs", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("a stale clear does not clobber a newer mark", async () => {
    const { markTurnStarting, clearTurnStarting, isTurnActive } = await import("../src/state");
    const oldEpoch = markTurnStarting("s1");
    // A successor turn marks before the old turn's finally runs its clear.
    const newEpoch = markTurnStarting("s1");
    clearTurnStarting("s1", oldEpoch); // the old turn's cleanup
    expect(isTurnActive("s1")).toBe(true); // successor's marker survives
    clearTurnStarting("s1", newEpoch);
    expect(isTurnActive("s1")).toBe(false);
  });

  it("a clear with the current epoch removes the marker", async () => {
    const { markTurnStarting, clearTurnStarting, isTurnActive } = await import("../src/state");
    const epoch = markTurnStarting("s2");
    expect(isTurnActive("s2")).toBe(true);
    clearTurnStarting("s2", epoch);
    expect(isTurnActive("s2")).toBe(false);
  });

  it("a clear with no epoch (no marker existed at turn entry) is a no-op", async () => {
    const { markTurnStarting, clearTurnStarting, isTurnActive } = await import("../src/state");
    markTurnStarting("s3");
    // A turn that started without a marker must not clear someone else's.
    clearTurnStarting("s3", undefined);
    expect(isTurnActive("s3")).toBe(true);
  });
});

describe("runTurn wrapper does not clobber a drained successor's marker", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
    newGate();
  });

  async function seed(): Promise<string> {
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    db.prepare(`INSERT INTO agents (id, current_version, name, created_at, updated_at) VALUES ('a', 1, 't', 0, 0)`).run();
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, system, tools_json, mcp_servers_json, backend, created_at)
       VALUES ('a', 1, 'anthropic/claude-sonnet-4-6', NULL, '[]', '{}', 'opencode', 0)`,
    ).run();
    db.prepare(`INSERT INTO environments (id, name, config_json, state, created_at) VALUES ('e', 't', '{}', 'ready', 0)`).run();
    // api_key_id is set so the driver's key-budget check runs its dynamic
    // import — the await before controller registration that opens the
    // pre-registration window this test guards.
    db.prepare(`INSERT INTO api_keys (id, name, hash, prefix, created_at) VALUES ('k', 't', 'h', 'p', 0)`).run();
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, title, metadata_json, created_at, updated_at, sandbox_name, api_key_id)
       VALUES ('s', 'a', 1, 'e', 'idle', NULL, '{}', 0, 0, NULL, 'k')`,
    ).run();
    return "s";
  }

  it("keeps the successor marked active after the previous turn settles", async () => {
    const sessionId = await seed();
    const { runTurn } = await import("../src/sessions/driver");
    const { interruptSession } = await import("../src/sessions/interrupt");
    const { pushPendingUserInput, getRuntime } = await import("../src/state");

    // Turn A blocks on the acquire gate.
    const turnA = runTurn(sessionId, [{ kind: "text", eventId: "e1", text: "hi" }]);
    await new Promise((r) => setTimeout(r, 20));

    // Queue input for the next turn, then interrupt A mid-acquire. A's
    // interrupt path drains the queue, which marks + launches turn B.
    pushPendingUserInput({ sessionId, input: { kind: "text", eventId: "e2", text: "again" } });
    expect(interruptSession(sessionId)).toBe(true);

    // Re-gate so turn B parks in its own acquire, then release A.
    const gateA = acquireGate;
    newGate();
    gateA.resolve("ca-sess-a");
    await turnA;

    // A has fully settled (its wrapper finally has run). B is somewhere in
    // its pre-exec window — its scheduled-turn marker must still be present,
    // otherwise a racing POST could start a concurrent turn.
    expect(getRuntime().startingTurns.has(sessionId)).toBe(true);

    // Cleanup: interrupt B and release its gate so the turn settles.
    await new Promise((r) => setTimeout(r, 20));
    interruptSession(sessionId);
    acquireGate.resolve("ca-sess-b");
    await new Promise((r) => setTimeout(r, 50));
    expect(getRuntime().inFlightRuns.has(sessionId)).toBe(false);
  });
});
