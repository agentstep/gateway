/**
 * Programmatic client tests — createClient() with the in-process
 * LocalTransport. Verifies the typed resource surface goes through the
 * same handler functions as HTTP traffic, the error envelope is unwrapped
 * into ApiClientError, and the SessionHandle turn iteration semantics
 * (send() completes on session.status_idle; stream() live-tails the bus).
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors cli-local-backend.test.ts)
// ---------------------------------------------------------------------------

/** Wipe all globalThis singletons so next import gets a fresh DB. */
function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  // Keep the turn queue from ever dequeuing: posted user.messages enqueue a
  // turn, but the driver never runs, so the turn tests below are fully
  // deterministic — synthetic bus events are the only events.
  process.env.CONCURRENCY = "0";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
}

const TEST_API_KEY = "client-test-api-key-12345";

/** Boot DB + seed a known API key so init never writes one to .env. */
async function bootDb(): Promise<void> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  createApiKey({ name: "test", permissions: ["*"], rawKey: TEST_API_KEY });
}

async function makeClient() {
  const { createClient } = await import("../src/client/index");
  return createClient({ apiKey: TEST_API_KEY });
}

/** Create environment directly in DB (bypasses provider availability checks). */
async function createEnvInDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  const id = newId("env");
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
  ).run(id, `env-${Date.now()}-${Math.random()}`, JSON.stringify({ type: "self_hosted", provider: "sprites" }), nowMs());
  return id;
}

// ---------------------------------------------------------------------------
// Resource surface
// ---------------------------------------------------------------------------

describe("createClient() — local transport resource surface", () => {
  beforeEach(() => freshDbEnv());

  it("agents: create with bare model id, get, update, list, versions, archive", async () => {
    await bootDb();
    const gw = await makeClient();

    const agent = await gw.agents.create({ name: "ClientAgent", model: "claude-sonnet-4-6" });
    expect(agent.id).toBeTruthy();
    expect(agent.model.id).toBe("claude-sonnet-4-6");

    const fetched = await gw.agents.get(agent.id);
    expect(fetched.name).toBe("ClientAgent");

    const updated = await gw.agents.update(agent.id, { version: agent.version, name: "ClientAgent2" });
    expect(updated.name).toBe("ClientAgent2");
    expect(updated.version).toBeGreaterThan(agent.version);

    const page = await gw.agents.list({ limit: 10 });
    expect(page.data.some((a) => a.id === agent.id)).toBe(true);

    const versions = await gw.agents.versions(agent.id);
    expect(versions.data.length).toBeGreaterThanOrEqual(2);

    const archived = await gw.agents.archive(agent.id);
    expect(archived.archived_at).toBeTruthy();
  });

  it("agents: engine selected explicitly or inferred from model prefix", async () => {
    await bootDb();
    const gw = await makeClient();

    // Explicit engine wins.
    const explicit = await gw.agents.create({
      name: "ExplicitEngine",
      model: "gemini-2.0-flash",
      engine: "gemini",
    });
    expect(explicit.engine).toBe("gemini");

    // Omitted engine → inferred from the model prefix.
    const inferred = await gw.agents.create({ name: "InferredEngine", model: "gemini-2.0-flash" });
    expect(inferred.engine).toBe("gemini");

    const claude = await gw.agents.create({ name: "InferredClaude", model: "claude-sonnet-4-6" });
    expect(claude.engine).toBe("claude");
  });

  it("unwraps the error envelope into ApiClientError with status", async () => {
    await bootDb();
    const gw = await makeClient();
    const { ApiClientError } = await import("../src/client/index");

    const err = await gw.agents.get("agt_does_not_exist").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as InstanceType<typeof ApiClientError>).status).toBe(404);
    expect((err as Error).message).toBeTruthy();
  });

  it("sessions: create via start(), handle.get(), list filter", async () => {
    await bootDb();
    const gw = await makeClient();

    const agent = await gw.agents.create({ name: "SessAgent", model: "claude-sonnet-4-6" });
    const envId = await createEnvInDb();

    const handle = await gw.sessions.start({ agent: agent.id, environment_id: envId, title: "t1" });
    expect(handle.id).toBeTruthy();

    const session = await handle.get();
    expect(session.status).toBe("idle");
    expect(session.title).toBe("t1");

    const page = await gw.sessions.list({ agent_id: agent.id });
    expect(page.data.some((s) => s.id === handle.id)).toBe(true);
  });

  it("vault entries: set, get, list, delete", async () => {
    await bootDb();
    const gw = await makeClient();

    const agent = await gw.agents.create({ name: "VaultAgent", model: "claude-sonnet-4-6" });
    const vault = await gw.vaults.create({ agent_id: agent.id, name: "v1" });

    await gw.vaults.entries.set(vault.id, "MY_SECRET", "shh");
    const entry = await gw.vaults.entries.get(vault.id, "MY_SECRET");
    expect(entry.key).toBe("MY_SECRET");

    const entries = await gw.vaults.entries.list(vault.id);
    expect(entries.data.some((e) => e.key === "MY_SECRET")).toBe(true);

    await gw.vaults.entries.delete(vault.id, "MY_SECRET");
    const after = await gw.vaults.entries.list(vault.id);
    expect(after.data.some((e) => e.key === "MY_SECRET")).toBe(false);
  });

  it("memory: store + memory CRUD", async () => {
    await bootDb();
    const gw = await makeClient();

    const agent = await gw.agents.create({ name: "MemAgent", model: "claude-sonnet-4-6" });
    const store = await gw.memory.stores.create({ name: "notes", agent_id: agent.id });
    expect(store.id).toBeTruthy();

    const mem = await gw.memory.memories.create(store.id, { path: "/facts/a.md", content: "alpha" });
    expect(mem.id).toBeTruthy();

    const listed = await gw.memory.memories.list(store.id);
    expect(listed.data.some((m) => m.id === mem.id)).toBe(true);

    await gw.memory.memories.delete(store.id, mem.id);
    await gw.memory.stores.delete(store.id);
  });

  it("batch: executes operations through the same envelope", async () => {
    await bootDb();
    const gw = await makeClient();

    // Agent creation uses a nested transaction that batch can't wrap —
    // environments are the canonical batchable op (see api-comprehensive).
    const res = await gw.batch.execute([
      { method: "POST", path: "/anthropic/v1/environments", body: { name: "BatchEnv", config: { type: "cloud" } } },
    ]);
    expect(res.results.length).toBe(1);
    expect(res.results[0].status).toBeGreaterThanOrEqual(200);
    expect(res.results[0].status).toBeLessThan(300);
  });

  it("events: send returns {data} with seq; list round-trips", async () => {
    await bootDb();
    const gw = await makeClient();

    const agent = await gw.agents.create({ name: "EvtAgent", model: "claude-sonnet-4-6" });
    const envId = await createEnvInDb();
    const session = await gw.sessions.create({ agent: agent.id, environment_id: envId });

    const posted = await gw.events.send(session.id, [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(posted.data.length).toBe(1);
    expect(posted.data[0].type).toBe("user.message");
    expect(typeof posted.data[0].seq).toBe("number");

    const listed = await gw.events.list(session.id, { order: "asc" });
    expect(listed.data.some((e) => e.type === "user.message")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SessionHandle turn semantics
// ---------------------------------------------------------------------------

describe("SessionHandle — turn iteration", () => {
  beforeEach(() => freshDbEnv());

  async function makeIdleSession(): Promise<{ gw: Awaited<ReturnType<typeof makeClient>>; sessionId: string }> {
    await bootDb();
    const gw = await makeClient();
    const agent = await gw.agents.create({ name: "TurnAgent", model: "claude-sonnet-4-6" });
    const envId = await createEnvInDb();
    const session = await gw.sessions.create({ agent: agent.id, environment_id: envId });
    return { gw, sessionId: session.id };
  }

  it("stream() live-tails events appended to the bus", async () => {
    const { gw, sessionId } = await makeIdleSession();
    const { appendEvent } = await import("../src/sessions/bus");
    const handle = gw.sessions.open(sessionId);

    const received: string[] = [];
    const consumer = (async () => {
      for await (const evt of handle.stream(0)) {
        received.push(evt.type);
        if (evt.type === "session.status_idle") break;
      }
    })();

    // Give the SSE subscription a beat to attach, then emit a turn's worth
    // of synthetic events (no driver involved — fully deterministic).
    await new Promise((r) => setTimeout(r, 150));
    appendEvent(sessionId, {
      type: "agent.message",
      payload: { content: [{ type: "text", text: "hi" }] },
      origin: "server",
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
      origin: "server",
    });

    await consumer;
    expect(received).toEqual(["agent.message", "session.status_idle"]);
  }, 15_000);

  it("send() posts user.message and completes when the session goes idle", async () => {
    const { gw, sessionId } = await makeIdleSession();
    const { appendEvent } = await import("../src/sessions/bus");
    const handle = gw.sessions.open(sessionId);

    const received: string[] = [];
    const turn = (async () => {
      for await (const evt of handle.send("do the thing")) {
        received.push(evt.type);
      }
    })();

    // CONCURRENCY=0 keeps the driver out — these synthetic events are the
    // only ones the turn can see.
    await new Promise((r) => setTimeout(r, 150));
    appendEvent(sessionId, {
      type: "agent.message",
      payload: { content: [{ type: "text", text: "done" }] },
      origin: "server",
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
      origin: "server",
    });

    await turn;
    // The posted user.message is not replayed back to the sender.
    expect(received).toEqual(["agent.message", "session.status_idle"]);

    // The message itself is durably in the log.
    const events = await handle.events({ order: "asc" });
    expect(events.data.some((e) => e.type === "user.message")).toBe(true);
  }, 15_000);

  it("run() settles into a TurnResult with text and stop reason", async () => {
    const { gw, sessionId } = await makeIdleSession();
    const { appendEvent } = await import("../src/sessions/bus");
    const handle = gw.sessions.open(sessionId);

    const turn = handle.run("summarize");

    await new Promise((r) => setTimeout(r, 150));
    appendEvent(sessionId, {
      type: "agent.message",
      payload: { content: [{ type: "text", text: "the summary" }] },
      origin: "server",
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
      origin: "server",
    });

    const result = await turn;
    expect(result.text).toBe("the summary");
    expect(result.stopReason).toBe("end_turn");
    expect(result.error).toBeNull();
    expect(result.events.map((e) => e.type)).toEqual(["agent.message", "session.status_idle"]);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Middleware + typed events
// ---------------------------------------------------------------------------

describe("client middleware", () => {
  it("withRetry retries 5xx and succeeds; passes 4xx through untouched", async () => {
    const { AgentStepClient, ApiClientError, withRetry } = await import("../src/client/index");
    const { applyMiddleware } = await import("../src/client/middleware");

    let calls = 0;
    const flaky = {
      call: async <T>(): Promise<T> => {
        calls++;
        if (calls < 3) throw new ApiClientError("busy", 503, "server_busy");
        return { ok: true } as T;
      },
      // eslint-disable-next-line require-yield
      stream: async function* () {},
    };

    const gw = new AgentStepClient(applyMiddleware(flaky as never, [withRetry({ baseDelayMs: 1 })]));
    const res = await gw.skills.stats();
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(3);

    // 4xx must not be retried.
    let notFoundCalls = 0;
    const notFound = {
      call: async (): Promise<never> => {
        notFoundCalls++;
        throw new ApiClientError("nope", 404, "not_found");
      },
      // eslint-disable-next-line require-yield
      stream: async function* () {},
    };
    const gw2 = new AgentStepClient(applyMiddleware(notFound as never, [withRetry({ baseDelayMs: 1 })]));
    await expect(gw2.skills.stats()).rejects.toMatchObject({ status: 404 });
    expect(notFoundCalls).toBe(1);
  });

  it("withLogging observes calls without altering results", async () => {
    const { AgentStepClient, withLogging } = await import("../src/client/index");
    const { applyMiddleware } = await import("../src/client/middleware");

    const lines: string[] = [];
    const fake = {
      call: async <T>(): Promise<T> => ({ ok: true }) as T,
      // eslint-disable-next-line require-yield
      stream: async function* () {},
    };
    const gw = new AgentStepClient(
      applyMiddleware(fake as never, [withLogging({ log: (l) => lines.push(l) })]),
    );
    await gw.skills.stats();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("GET /v1/skills/stats ok");
  });
});

describe("typed event guards", () => {
  it("narrow events and extract text", async () => {
    const { isAgentMessage, isSessionIdle, isSessionError, eventText } = await import("../src/client/events");
    const base = { id: "evt_1", seq: 1, session_id: "s", processed_at: null };

    const msg = { ...base, type: "agent.message", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    const idle = { ...base, type: "session.status_idle", stop_reason: { type: "end_turn" } };
    const err = { ...base, type: "session.error", error: { type: "server_error", message: "boom" } };

    expect(isAgentMessage(msg)).toBe(true);
    expect(eventText(msg)).toBe("ab");
    expect(isSessionIdle(idle) && idle.stop_reason.type).toBe("end_turn");
    expect(isSessionError(err) && err.error.message).toBe("boom");
    expect(isAgentMessage(idle)).toBe(false);
    expect(eventText(idle)).toBe("");
  });
});

describe("deprecated aliases", () => {
  it("createGateway / GatewayClient / GatewayApiError still resolve to the new names", async () => {
    const mod = await import("../src/client/index");
    expect(mod.createGateway).toBe(mod.createClient);
    expect(mod.GatewayClient).toBe(mod.AgentStepClient);
    expect(mod.GatewayApiError).toBe(mod.ApiClientError);
  });
});
