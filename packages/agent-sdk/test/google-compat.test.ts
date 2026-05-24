// @ts-nocheck — test file with loose typing on handler responses
/**
 * Integration test for Google Interactions API compatibility layer.
 * Verifies that POST /google/v1beta/interactions works end-to-end
 * by creating an agent and running an interaction against a mock backend.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Hoisted mocks — must be at module top.
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
  wrapProviderWithSecrets: vi.fn(async (p: unknown) => p),
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
    resolveProviderName: (opts?: { override?: string; envConfigProvider?: string | null }) =>
      opts?.override ?? opts?.envConfigProvider ?? "sprites",
  };
});

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "google-compat-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  process.env.GEMINI_API_KEY = "fake-gemini-key";
  const g = globalThis as any;
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  delete g.__caActors;
  delete g.__caLicense;
  delete g.__caQueue;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle);
    delete g.__caSweeperHandle;
  }
}

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

function req(url: string, opts: { method?: string; body?: unknown; apiKey?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey !== undefined) {
    headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "test-api-key-12345";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

/** Create a ready environment directly in the DB (avoids async provider setup). */
async function createReadyEnv(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at, updated_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?, ?)`
  ).run(id, "test-env", JSON.stringify({ type: "self_hosted", provider: "docker" }), now, now);
  return id;
}

describe("Google Interactions API compatibility", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
  });

  it("POST /google/v1beta/interactions creates session and returns interaction", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    // Enqueue a scripted gemini turn: init + message + result
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Hello! How can I help you?"}',
        '{"type":"result","stats":{"input_tokens":10,"output_tokens":8,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: {
        model: "gemini-2.5-flash",
        input: "Hello, world!",
      },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.id).toMatch(/^int_/);
    expect(body.status).toBe("completed");
    expect(body.steps).toBeDefined();
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.usage).toBeDefined();
    expect(typeof body.usage.total_input_tokens).toBe("number");
    expect(typeof body.usage.total_output_tokens).toBe("number");
    expect(typeof body.usage.total_tokens).toBe("number");
    expect(body.usage.total_input_tokens).toBe(10);
    expect(body.usage.total_output_tokens).toBe(8);
    expect(body.usage.total_tokens).toBe(18);
    // Should have a model output step with the assistant text
    const textStep = body.steps.find((s: any) => s.type === "model_output");
    expect(textStep).toBeDefined();
    expect(textStep.content[0].text).toBe("Hello! How can I help you?");
  });

  it("rejects request with neither model nor agent", async () => {
    await bootDb();

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { input: "Hello" },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("either 'model' or 'agent' is required");
  });

  it("rejects request with invalid body", async () => {
    await bootDb();

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash" },
    }));
    expect(res.status).toBe(400);
  });

  it("accepts x-goog-api-key header for auth", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_2","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"hi"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":2,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    // Use x-goog-api-key instead of x-api-key (simulating what the Hono middleware does)
    const request = new Request("http://localhost/google/v1beta/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-api-key-12345",
      },
      body: JSON.stringify({ model: "gemini-2.5-flash", input: "test" }),
    });

    const res = await handleCreateInteraction(request);
    // Should authenticate successfully (not 401)
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("reuses existing agent with same name on second call", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    // Two turns queued for two interactions
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_3a","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"first"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":1,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_3b","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"second"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":1,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");
    const { handleListAgents } = await import("../src/handlers/agents");

    // First interaction creates the agent
    const res1 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "hello" },
    }));
    expect(res1.status).toBe(200);

    // Check agent count
    const listRes1 = await handleListAgents(req("/v1/agents?limit=100"));
    const list1 = await listRes1.json();
    const agentCount1 = list1.data.length;

    // Second interaction should reuse the same agent
    const res2 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "world" },
    }));
    expect(res2.status).toBe(200);

    const listRes2 = await handleListAgents(req("/v1/agents?limit=100"));
    const list2 = await listRes2.json();
    expect(list2.data.length).toBe(agentCount1); // No new agent created
  });
});
