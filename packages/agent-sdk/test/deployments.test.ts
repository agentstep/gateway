/**
 * Scheduled deployments: cron matcher units + end-to-end create / manual
 * run / scheduler sweep / pause / archive semantics through the client.
 * CONCURRENCY=0 keeps fired turns queued (the driver never runs), so
 * tests are deterministic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseCron, cronMatches, zonedParts, zonedMinuteKey, nextRuns } from "../src/util/cron";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "depl-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  process.env.CONCURRENCY = "0";
  const g = globalThis as Record<string, unknown>;
  for (const k of [
    "__caDb", "__caDrizzle", "__caInitialized", "__caInitPromise", "__caBusEmitters",
    "__caConfigCache", "__caRuntime", "__caActors",
  ]) delete g[k];
  if (g.__caSweeperHandle) { clearInterval(g.__caSweeperHandle as NodeJS.Timeout); delete g.__caSweeperHandle; }
  if (g.__caDeploymentsHandle) { clearInterval(g.__caDeploymentsHandle as NodeJS.Timeout); delete g.__caDeploymentsHandle; }
}

const TEST_API_KEY = "depl-test-api-key-12345";

async function boot() {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  createApiKey({ name: "test", permissions: ["*"], rawKey: TEST_API_KEY });
  const { createClient } = await import("../src/client/index");
  const gw = createClient({ apiKey: TEST_API_KEY });
  const agent = await gw.agents.create({ name: `DeplAgent-${Math.random()}`, model: "claude-sonnet-4-6" });
  const { newId } = await import("../src/util/ids");
  const { nowMs } = await import("../src/util/clock");
  const envId = newId("env");
  getDb().prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
  ).run(envId, `env-${Math.random()}`, JSON.stringify({ type: "self_hosted", provider: "sprites" }), nowMs());
  return { gw, agent, envId };
}

// ── Cron matcher ──────────────────────────────────────────────────────────

describe("cron matcher", () => {
  it("parses fields: wildcards, lists, ranges, steps", () => {
    expect(parseCron("* * * * *")).not.toBeNull();
    expect(parseCron("0 20 * * 5")).not.toBeNull();
    expect(parseCron("*/15 9-17 1,15 * 1-5")).not.toBeNull();
    expect(parseCron("60 * * * *")).toBeNull(); // out of range
    expect(parseCron("* * * *")).toBeNull(); // 4 fields
    expect(parseCron("a * * * *")).toBeNull();
  });

  it("matches wall-clock parts", () => {
    const cron = parseCron("0 20 * * 5")!; // 8pm Fridays
    expect(cronMatches(cron, { minute: 0, hour: 20, dayOfMonth: 13, month: 6, dayOfWeek: 5 })).toBe(true);
    expect(cronMatches(cron, { minute: 1, hour: 20, dayOfMonth: 13, month: 6, dayOfWeek: 5 })).toBe(false);
    expect(cronMatches(cron, { minute: 0, hour: 20, dayOfMonth: 13, month: 6, dayOfWeek: 4 })).toBe(false);

    const steps = parseCron("*/15 * * * *")!;
    for (const m of [0, 15, 30, 45]) {
      expect(cronMatches(steps, { minute: m, hour: 3, dayOfMonth: 1, month: 1, dayOfWeek: 0 })).toBe(true);
    }
    expect(cronMatches(steps, { minute: 7, hour: 3, dayOfMonth: 1, month: 1, dayOfWeek: 0 })).toBe(false);
  });

  it("dow 7 aliases Sunday; restricted dom/dow OR together", () => {
    const sun7 = parseCron("0 0 * * 7")!;
    expect(cronMatches(sun7, { minute: 0, hour: 0, dayOfMonth: 2, month: 3, dayOfWeek: 0 })).toBe(true);

    const both = parseCron("0 0 13 * 5")!; // 13th OR Friday (standard cron)
    expect(cronMatches(both, { minute: 0, hour: 0, dayOfMonth: 13, month: 6, dayOfWeek: 2 })).toBe(true);
    expect(cronMatches(both, { minute: 0, hour: 0, dayOfMonth: 20, month: 6, dayOfWeek: 5 })).toBe(true);
    expect(cronMatches(both, { minute: 0, hour: 0, dayOfMonth: 20, month: 6, dayOfWeek: 2 })).toBe(false);
  });

  it("zonedParts respects timezones; minute keys are wall-clock", () => {
    // 2026-06-12T20:00 UTC = 16:00 in New York (EDT)
    const t = Date.UTC(2026, 5, 12, 20, 0);
    expect(zonedParts(t, "UTC")).toMatchObject({ hour: 20, minute: 0, dayOfWeek: 5 });
    expect(zonedParts(t, "America/New_York")).toMatchObject({ hour: 16, minute: 0 });
    expect(zonedMinuteKey(t, "UTC")).toBe("2026-06-12T20:00");
    expect(zonedMinuteKey(t, "America/New_York")).toBe("2026-06-12T16:00");
  });

  it("nextRuns finds upcoming fire times", () => {
    const cron = parseCron("30 12 * * *")!;
    const from = Date.UTC(2026, 5, 12, 11, 0);
    const runs = nextRuns(cron, "UTC", from, 2);
    expect(runs).toEqual([Date.UTC(2026, 5, 12, 12, 30), Date.UTC(2026, 5, 13, 12, 30)]);
  });
});

// ── End-to-end via the client ─────────────────────────────────────────────

describe("deployments", () => {
  beforeEach(() => freshDbEnv());

  it("create validates cron + timezone + agent/env; returns upcoming runs", async () => {
    const { gw, agent, envId } = await boot();

    const depl = await gw.deployments.create({
      name: "weekly scan",
      agent: agent.id,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "run the scan" }] }],
      schedule: { type: "cron", expression: "0 20 * * 5", timezone: "America/New_York" },
    });
    expect(depl.id).toMatch(/^depl_/);
    expect(depl.status).toBe("active");
    expect(depl.schedule.upcoming_runs_at?.length).toBe(3);

    await expect(
      gw.deployments.create({
        name: "bad cron", agent: agent.id, environment_id: envId,
        initial_events: [{ type: "user.message", content: [{ type: "text", text: "x" }] }],
        schedule: { type: "cron", expression: "99 * * * *" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      gw.deployments.create({
        name: "bad tz", agent: agent.id, environment_id: envId,
        initial_events: [{ type: "user.message", content: [{ type: "text", text: "x" }] }],
        schedule: { type: "cron", expression: "* * * * *", timezone: "Mars/Olympus" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("manual run creates a session seeded with the initial message", async () => {
    const { gw, agent, envId } = await boot();
    const depl = await gw.deployments.create({
      name: "manual", agent: agent.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "kickoff" }] }],
      schedule: { type: "cron", expression: "0 0 1 1 *" },
    });

    const run = await gw.deployments.run(depl.id);
    expect(run.session_id).toBeTruthy();
    expect(run.error).toBeNull();
    expect(run.trigger_context.type).toBe("manual");

    const events = await gw.events.list(run.session_id!, { order: "asc" });
    expect(events.data.some((e) => e.type === "user.message")).toBe(true);

    const runs = await gw.deployments.runs(depl.id);
    expect(runs.data.length).toBe(1);
  });

  it("scheduler sweep fires on a matching minute, dedupes, and respects pause", async () => {
    const { gw, agent, envId } = await boot();
    const depl = await gw.deployments.create({
      name: "sweeper", agent: agent.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "tick" }] }],
      schedule: { type: "cron", expression: "30 12 * * *", timezone: "UTC" },
    });

    const { runDeploymentSweep } = await import("../src/sessions/deployments");
    const fireTime = Date.UTC(2026, 5, 12, 12, 30, 10);

    expect(await runDeploymentSweep(Date.UTC(2026, 5, 12, 12, 29))).toBe(0); // wrong minute
    expect(await runDeploymentSweep(fireTime)).toBe(1); // fires
    expect(await runDeploymentSweep(fireTime + 20_000)).toBe(0); // same minute → deduped
    expect(await runDeploymentSweep(Date.UTC(2026, 5, 13, 12, 30))).toBe(1); // next day fires again

    let runs = await gw.deployments.runs(depl.id);
    expect(runs.data.length).toBe(2);
    expect(runs.data.every((r) => r.session_id && !r.error)).toBe(true);

    // Paused: scheduled firing suppressed, manual run still permitted.
    await gw.deployments.pause(depl.id);
    expect(await runDeploymentSweep(Date.UTC(2026, 5, 14, 12, 30))).toBe(0);
    const manualWhilePaused = await gw.deployments.run(depl.id);
    expect(manualWhilePaused.session_id).toBeTruthy();

    // Unpause resumes; archive is terminal.
    await gw.deployments.unpause(depl.id);
    expect(await runDeploymentSweep(Date.UTC(2026, 5, 14, 12, 30, 5))).toBe(1);
    await gw.deployments.archive(depl.id);
    await expect(gw.deployments.run(depl.id)).rejects.toMatchObject({ status: 400 });
    await expect(gw.deployments.unpause(depl.id)).rejects.toMatchObject({ status: 400 });
  });

  it("a run against an archived agent records a typed error, not a session", async () => {
    const { gw, agent, envId } = await boot();
    const depl = await gw.deployments.create({
      name: "doomed", agent: agent.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "x" }] }],
      schedule: { type: "cron", expression: "0 0 1 1 *" },
    });
    await gw.agents.archive(agent.id);

    const run = await gw.deployments.run(depl.id);
    expect(run.session_id).toBeNull();
    expect(run.error?.type).toBe("agent_archived");

    const failed = await gw.deployments.runs(depl.id, { has_error: true });
    expect(failed.data.length).toBe(1);
  });
});
