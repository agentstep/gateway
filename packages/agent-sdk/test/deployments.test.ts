// @ts-nocheck — test file with loose typing on handler responses
/**
 * Scheduled deployments: API handlers + scheduler tick.
 *
 * Mirrors the Anthropic Managed Agents deployments surface:
 *   POST /anthropic/v1/deployments
 *   GET  /anthropic/v1/deployments(/:id)
 *   POST /anthropic/v1/deployments/:id/{pause,unpause,archive,run}
 *   GET  /anthropic/v1/deployment_runs
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-depl-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  delete g.__caActors;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  if (g.__caDeploymentSchedulerHandle) {
    clearInterval(g.__caDeploymentSchedulerHandle as NodeJS.Timeout);
    delete g.__caDeploymentSchedulerHandle;
  }
}

async function bootDb(): Promise<void> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
}

function req(url: string, opts: { method?: string; body?: unknown } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-api-key": "test-api-key-12345" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function createTestAgent(): Promise<Record<string, unknown>> {
  const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");
  const res = await handleCreateAgent(
    req("/anthropic/v1/agents", {
      body: { name: `Agent-${Date.now()}-${Math.random()}`, model: { id: "claude-sonnet-4-6" } },
    }),
  );
  return await res.json();
}

async function createTestEnv(): Promise<Record<string, unknown>> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at, updated_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?, ?)`,
  ).run(id, `env-${Date.now()}-${Math.random()}`, JSON.stringify({ type: "self_hosted", provider: "docker" }), now, now);
  return { id };
}

const INITIAL_EVENTS = [
  { type: "user.message", content: [{ type: "text", text: "Run the weekly compliance scan." }] },
];

async function createTestDeployment(
  agentId: string,
  envId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { handleCreateDeployment } = await import("../src/handlers/anthropic-compat/deployments");
  const res = await handleCreateDeployment(
    req("/anthropic/v1/deployments", {
      body: {
        name: "Weekly compliance scan",
        agent: agentId,
        environment_id: envId,
        initial_events: INITIAL_EVENTS,
        schedule: { type: "cron", expression: "0 20 * * 5", timezone: "America/New_York" },
        ...overrides,
      },
    }),
  );
  return await res.json();
}

beforeEach(async () => {
  freshDbEnv();
  await bootDb();
});

describe("POST /deployments", () => {
  it("creates a deployment with upcoming run times", async () => {
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);

    expect(dep.type).toBe("deployment");
    expect(dep.id).toMatch(/^depl_/);
    expect(dep.status).toBe("active");
    expect(dep.paused_reason).toBeNull();
    expect(dep.agent).toEqual({ type: "agent", id: agent.id });
    expect(dep.schedule.type).toBe("cron");
    expect(dep.schedule.expression).toBe("0 20 * * 5");
    expect(dep.schedule.timezone).toBe("America/New_York");
    expect(dep.schedule.last_run_at).toBeNull();
    expect(dep.schedule.upcoming_runs_at).toHaveLength(3);
    // All upcoming times are in the future and ascending
    const times = dep.schedule.upcoming_runs_at.map((t: string) => new Date(t).getTime());
    expect(times[0]).toBeGreaterThan(Date.now());
    expect(times[1]).toBeGreaterThan(times[0]);
    expect(times[2]).toBeGreaterThan(times[1]);
  });

  it("rejects malformed cron expressions and timezones", async () => {
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const bad1 = await createTestDeployment(agent.id, env.id, {
      schedule: { type: "cron", expression: "99 * * * *", timezone: "UTC" },
    });
    expect(bad1.type).toBe("error");
    const bad2 = await createTestDeployment(agent.id, env.id, {
      schedule: { type: "cron", expression: "0 20 * * 5", timezone: "Not/AZone" },
    });
    expect(bad2.type).toBe("error");
  });

  it("rejects unknown agent or environment", async () => {
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const noAgent = await createTestDeployment("agent_nope", env.id);
    expect(noAgent.error?.type ?? noAgent.type).toContain("error");
    const noEnv = await createTestDeployment(agent.id, "env_nope");
    expect(noEnv.error?.type ?? noEnv.type).toContain("error");
  });

  it("requires at least one initial user.message event", async () => {
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const bad = await createTestDeployment(agent.id, env.id, { initial_events: [] });
    expect(bad.type).toBe("error");
  });
});

describe("deployment lifecycle", () => {
  it("pause sets paused_reason manual; unpause clears it", async () => {
    const { handlePauseDeployment, handleUnpauseDeployment } = await import(
      "../src/handlers/anthropic-compat/deployments"
    );
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);

    const paused = await (await handlePauseDeployment(req(`/x/${dep.id}/pause`, { method: "POST" }), dep.id)).json();
    expect(paused.status).toBe("paused");
    expect(paused.paused_reason).toEqual({ type: "manual" });
    expect(paused.schedule.upcoming_runs_at).toEqual([]);

    const unpaused = await (await handleUnpauseDeployment(req(`/x/${dep.id}/unpause`, { method: "POST" }), dep.id)).json();
    expect(unpaused.status).toBe("active");
    expect(unpaused.paused_reason).toBeNull();
    expect(unpaused.schedule.upcoming_runs_at.length).toBeGreaterThan(0);
  });

  it("archive is terminal: no further pause/run", async () => {
    const { handleArchiveDeployment, handlePauseDeployment, handleRunDeployment } = await import(
      "../src/handlers/anthropic-compat/deployments"
    );
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);

    const archived = await (await handleArchiveDeployment(req(`/x`, { method: "POST" }), dep.id)).json();
    expect(archived.status).toBe("archived");
    expect(archived.archived_at).not.toBeNull();

    const pauseRes = await handlePauseDeployment(req(`/x`, { method: "POST" }), dep.id);
    expect(pauseRes.status).toBe(409);
    const runRes = await handleRunDeployment(req(`/x`, { method: "POST" }), dep.id);
    expect(runRes.status).toBe(409);
  });

  it("lists deployments, excluding archived by default", async () => {
    const { handleListDeployments, handleArchiveDeployment } = await import(
      "../src/handlers/anthropic-compat/deployments"
    );
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const d1 = await createTestDeployment(agent.id, env.id);
    const d2 = await createTestDeployment(agent.id, env.id, { name: "Other" });
    await handleArchiveDeployment(req(`/x`, { method: "POST" }), d1.id);

    const list = await (await handleListDeployments(req("/anthropic/v1/deployments"))).json();
    expect(list.data.map((d: { id: string }) => d.id)).toEqual([d2.id]);

    const all = await (await handleListDeployments(req("/anthropic/v1/deployments?include_archived=true"))).json();
    expect(all.data).toHaveLength(2);
  });
});

describe("POST /deployments/:id/run (manual)", () => {
  it("creates a session and a successful run record", async () => {
    const { handleRunDeployment, handleListDeploymentRuns } = await import(
      "../src/handlers/anthropic-compat/deployments"
    );
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);

    const run = await (await handleRunDeployment(req(`/x`, { method: "POST" }), dep.id)).json();
    expect(run.type).toBe("deployment_run");
    expect(run.id).toMatch(/^drun_/);
    expect(run.trigger_context).toEqual({ type: "manual" });
    expect(run.session_id).toMatch(/^sesn_/);
    expect(run.error).toBeNull();
    expect(run.agent).toEqual({ type: "agent", id: agent.id, version: agent.version });

    // The session exists and carries the deployment's config
    const { getSession } = await import("../src/db/sessions");
    const session = getSession(run.session_id);
    expect(session).not.toBeNull();
    expect(session.title).toBe("Weekly compliance scan");
    expect(session.metadata.deployment_id).toBe(dep.id);

    // The initial user.message was appended
    const { listEvents } = await import("../src/db/events");
    const events = listEvents(run.session_id, { limit: 10, order: "asc" });
    const userMsg = events.find((e) => e.type === "user.message");
    expect(userMsg).toBeDefined();

    // Run shows up in the listing
    const runs = await (await handleListDeploymentRuns(
      req(`/anthropic/v1/deployment_runs?deployment_id=${dep.id}`),
    )).json();
    expect(runs.data).toHaveLength(1);
    expect(runs.data[0].id).toBe(run.id);
  });

  it("manual run is allowed while paused", async () => {
    const { handlePauseDeployment, handleRunDeployment } = await import(
      "../src/handlers/anthropic-compat/deployments"
    );
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);
    await handlePauseDeployment(req(`/x`, { method: "POST" }), dep.id);

    const run = await (await handleRunDeployment(req(`/x`, { method: "POST" }), dep.id)).json();
    expect(run.session_id).toMatch(/^sesn_/);
  });

  it("records environment_archived_error when the environment is archived", async () => {
    const { handleRunDeployment, handleListDeploymentRuns } = await import(
      "../src/handlers/anthropic-compat/deployments"
    );
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);

    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE environments SET archived_at = ? WHERE id = ?`).run(Date.now(), env.id);

    const run = await (await handleRunDeployment(req(`/x`, { method: "POST" }), dep.id)).json();
    expect(run.session_id).toBeNull();
    expect(run.error.type).toBe("environment_archived_error");

    const failed = await (await handleListDeploymentRuns(
      req(`/anthropic/v1/deployment_runs?deployment_id=${dep.id}&has_error=true`),
    )).json();
    expect(failed.data).toHaveLength(1);

    const ok = await (await handleListDeploymentRuns(
      req(`/anthropic/v1/deployment_runs?deployment_id=${dep.id}&has_error=false`),
    )).json();
    expect(ok.data).toHaveLength(0);
  });

  it("auto-archives the deployment when the agent is archived", async () => {
    const { handleRunDeployment, handleGetDeployment } = await import(
      "../src/handlers/anthropic-compat/deployments"
    );
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);

    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE agents SET archived_at = ? WHERE id = ?`).run(Date.now(), agent.id);

    const res = await handleRunDeployment(req(`/x`, { method: "POST" }), dep.id);
    expect(res.status).toBe(409);

    const after = await (await handleGetDeployment(req(`/x`), dep.id)).json();
    expect(after.status).toBe("archived");
  });
});

describe("scheduler tick", () => {
  it("fires due deployments, records the run, and advances next_run_at", async () => {
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);

    // Force the deployment to be due
    const { getDb } = await import("../src/db/client");
    const past = Date.now() - 60_000;
    getDb().prepare(`UPDATE deployments SET next_run_at = ? WHERE id = ?`).run(past, dep.id);

    const { runDeploymentSchedulerTick } = await import("../src/sessions/deployments");
    await runDeploymentSchedulerTick();

    const { listDeploymentRunRows, getDeploymentRow } = await import("../src/db/deployments");
    const runs = listDeploymentRunRows({ deploymentId: dep.id });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger_type).toBe("schedule");
    expect(runs[0].scheduled_at).toBe(past);
    expect(runs[0].session_id).toMatch(/^sesn_/);

    const row = getDeploymentRow(dep.id);
    expect(row.last_run_at).toBe(past);
    expect(row.next_run_at).toBeGreaterThan(Date.now());

    // A second tick does nothing (next_run_at is in the future)
    await runDeploymentSchedulerTick();
    expect(listDeploymentRunRows({ deploymentId: dep.id })).toHaveLength(1);
  });

  it("ignores paused deployments", async () => {
    const { handlePauseDeployment } = await import("../src/handlers/anthropic-compat/deployments");
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const dep = await createTestDeployment(agent.id, env.id);
    await handlePauseDeployment(req(`/x`, { method: "POST" }), dep.id);

    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE deployments SET next_run_at = ? WHERE id = ?`).run(Date.now() - 60_000, dep.id);

    const { runDeploymentSchedulerTick } = await import("../src/sessions/deployments");
    await runDeploymentSchedulerTick();

    const { listDeploymentRunRows } = await import("../src/db/deployments");
    expect(listDeploymentRunRows({ deploymentId: dep.id })).toHaveLength(0);
  });
});
