/**
 * Outcome wire-compat behaviors added for launch:
 *
 *  1. `withHeartbeat` — the driver emits `span.outcome_evaluation_ongoing`
 *     on a fixed cadence while the grader call is in flight, matching the
 *     hosted API. The helper must beat while the task is pending, stop the
 *     moment it settles, and pass the result/rejection through untouched.
 *
 *  2. Interrupting a session while an outcome loop is `running` must emit a
 *     terminal `span.outcome_evaluation_end{result:"interrupted"}` and flip
 *     the stored criteria to `interrupted` — never leave the outcome
 *     dangling (mirrors the hosted API's `interrupted` outcome result).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

vi.mock("../src/containers/exec", async () => {
  const fake = await import("./helpers/fake-exec");
  return { startExec: fake.startExec };
});

vi.mock("../src/containers/lifecycle", () => ({
  acquireForFirstTurn: vi.fn(async () => "ca-sess-fake"),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-outcome-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
  const g = globalThis as Record<string, unknown>;
  for (const k of ["__caDb", "__caDrizzle", "__caInitialized", "__caBusEmitters", "__caConfigCache", "__caRuntime"]) {
    delete g[k];
  }
}

describe("withHeartbeat", () => {
  it("beats while the task is pending and stops once it resolves", async () => {
    const { withHeartbeat } = await import("../src/sessions/driver");
    let beats = 0;
    const result = await withHeartbeat(
      new Promise<string>((r) => setTimeout(() => r("done"), 55)),
      () => beats++,
      10,
    );
    expect(result).toBe("done");
    expect(beats).toBeGreaterThanOrEqual(3);
    const after = beats;
    await new Promise((r) => setTimeout(r, 40));
    expect(beats).toBe(after); // no beats after settle
  });

  it("stops beating and rethrows when the task rejects", async () => {
    const { withHeartbeat } = await import("../src/sessions/driver");
    let beats = 0;
    await expect(
      withHeartbeat(
        new Promise((_, rej) => setTimeout(() => rej(new Error("grader down")), 25)),
        () => beats++,
        10,
      ),
    ).rejects.toThrow("grader down");
    const after = beats;
    await new Promise((r) => setTimeout(r, 40));
    expect(beats).toBe(after);
  });
});

describe("interrupt during a running outcome loop", () => {
  beforeEach(async () => {
    freshDbEnv();
    vi.clearAllMocks();
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
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
    // sandbox_name preset: the turn skips acquire and goes straight to exec.
    // Outcome criteria mid-loop: the grader has run twice and is "running".
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, title, metadata_json, created_at, updated_at, sandbox_name, outcome_criteria_json)
       VALUES ('s', 'a', 1, 'e', 'idle', NULL, '{}', 0, 0, 'ca-sess-live', ?)`,
    ).run(JSON.stringify({ outcome_id: "oc_1", rubric: "the tests pass", status: "running", grader_iteration: 2 }));
    return "s";
  }

  it("emits a terminal interrupted evaluation and flips the stored criteria", async () => {
    const sessionId = await seed();
    const fake = await import("./helpers/fake-exec");
    const { runTurn } = await import("../src/sessions/driver");
    const { interruptSession } = await import("../src/sessions/interrupt");

    // The engine "runs" until the interrupt aborts the exec stream.
    fake.enqueueTurn({ ndjson: [], hangUntilAbort: true });

    const turn = runTurn(sessionId, [{ kind: "text", eventId: "e1", text: "hi" }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(interruptSession(sessionId)).toBe(true);
    await turn;

    const { getDb } = await import("../src/db/client");
    const events = getDb()
      .prepare(`SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as { type: string; payload_json: string }[];

    const evalEnd = events.filter((e) => e.type === "span.outcome_evaluation_end").at(-1);
    expect(evalEnd).toBeDefined();
    const payload = JSON.parse(evalEnd!.payload_json);
    expect(payload.result).toBe("interrupted");
    expect(payload.outcome_id).toBe("oc_1");
    expect(payload.iteration).toBe(2);

    const idle = events.filter((e) => e.type === "session.status_idle").at(-1);
    expect(JSON.parse(idle!.payload_json).stop_reason).toEqual({ type: "interrupted" });

    const { getOutcomeCriteria } = await import("../src/db/sessions");
    const criteria = getOutcomeCriteria(sessionId) as { status?: string; completed_at?: string };
    expect(criteria.status).toBe("interrupted");
    expect(criteria.completed_at).toBeTruthy();
  });

  it("does not emit an evaluation event when no outcome is running", async () => {
    const sessionId = await seed();
    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE sessions SET outcome_criteria_json = NULL WHERE id = ?`).run(sessionId);

    const fake = await import("./helpers/fake-exec");
    const { runTurn } = await import("../src/sessions/driver");
    const { interruptSession } = await import("../src/sessions/interrupt");

    fake.enqueueTurn({ ndjson: [], hangUntilAbort: true });
    const turn = runTurn(sessionId, [{ kind: "text", eventId: "e1", text: "hi" }]);
    await new Promise((r) => setTimeout(r, 30));
    interruptSession(sessionId);
    await turn;

    const events = getDb()
      .prepare(`SELECT type FROM events WHERE session_id = ?`)
      .all(sessionId) as { type: string }[];
    expect(events.map((e) => e.type)).not.toContain("span.outcome_evaluation_end");
  });
});
