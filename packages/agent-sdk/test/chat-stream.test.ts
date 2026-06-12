/**
 * Chat stream endpoint — POST /v1/sessions/:id/chat returns a UI message
 * stream (SSE) for the turn. Deterministic via CONCURRENCY=0 + synthetic
 * bus events.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-test-"));
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

const TEST_API_KEY = "chat-test-api-key-12345";

async function boot() {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  createApiKey({ name: "test", permissions: ["*"], rawKey: TEST_API_KEY });
  const { createClient } = await import("../src/client/index");
  const gw = createClient({ apiKey: TEST_API_KEY });
  const agent = await gw.agents.create({ name: `ChatAgent-${Math.random()}`, model: "claude-sonnet-4-6" });
  const { newId } = await import("../src/util/ids");
  const { nowMs } = await import("../src/util/clock");
  const envId = newId("env");
  getDb().prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
  ).run(envId, `env-${Math.random()}`, JSON.stringify({ type: "self_hosted", provider: "sprites" }), nowMs());
  const session = await gw.sessions.create({ agent: agent.id, environment_id: envId });
  return { gw, sessionId: session.id };
}

async function readFrames(res: Response): Promise<Array<Record<string, unknown> | "[DONE]">> {
  const text = await res.text();
  const frames: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") frames.push("[DONE]");
    else frames.push(JSON.parse(data) as Record<string, unknown>);
  }
  return frames;
}

describe("chat stream endpoint", () => {
  beforeEach(() => freshDbEnv());

  it("streams a turn as UI message frames and closes on idle", async () => {
    const { sessionId } = await boot();
    const { handleSessionChat } = await import("../src/handlers/chat-stream");
    const { appendEvent } = await import("../src/sessions/bus");

    const resPromise = handleSessionChat(
      new Request(`http://localhost/v1/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "summarize the repo" }] }],
        }),
      }),
      sessionId,
    );

    // Synthesize the turn (driver is parked by CONCURRENCY=0).
    setTimeout(() => {
      appendEvent(sessionId, {
        type: "agent.thinking",
        payload: { content: [{ type: "thinking", thinking: "planning" }] },
        origin: "server",
      });
      appendEvent(sessionId, {
        type: "agent.tool_use",
        payload: { tool_use_id: "toolu_1", name: "Bash", input: { command: "ls" } },
        origin: "server",
      });
      appendEvent(sessionId, {
        type: "agent.tool_result",
        payload: { tool_use_id: "toolu_1", content: "README.md", is_error: false },
        origin: "server",
      });
      appendEvent(sessionId, {
        type: "agent.message",
        payload: { content: [{ type: "text", text: "It's a gateway." }] },
        origin: "server",
      });
      appendEvent(sessionId, {
        type: "session.status_idle",
        payload: { stop_reason: { type: "end_turn" } },
        origin: "server",
      });
    }, 150);

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readFrames(res);
    const types = frames.map((f) => (f === "[DONE]" ? "[DONE]" : (f.type as string)));

    expect(types[0]).toBe("start");
    expect(types).toContain("reasoning-delta");
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");
    expect(types).toContain("text-delta");
    expect(types.at(-2)).toBe("finish");
    expect(types.at(-1)).toBe("[DONE]");

    const textDelta = frames.find((f) => f !== "[DONE]" && f.type === "text-delta") as Record<string, unknown>;
    expect(textDelta.delta).toBe("It's a gateway.");
    const toolIn = frames.find((f) => f !== "[DONE]" && f.type === "tool-input-available") as Record<string, unknown>;
    expect(toolIn.toolName).toBe("Bash");
    expect(toolIn.toolCallId).toBe("toolu_1");
  }, 15_000);

  it("rejects bodies without a user text message", async () => {
    const { sessionId } = await boot();
    const { handleSessionChat } = await import("../src/handlers/chat-stream");
    const res = await handleSessionChat(
      new Request(`http://localhost/v1/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
        body: JSON.stringify({ messages: [{ role: "assistant", content: "hi" }] }),
      }),
      sessionId,
    );
    expect(res.status).toBe(400);
  });

  it("404s for a missing session", async () => {
    await boot();
    const { handleSessionChat } = await import("../src/handlers/chat-stream");
    const res = await handleSessionChat(
      new Request(`http://localhost/v1/sessions/sesn_ghost/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      }),
      "sesn_ghost",
    );
    expect(res.status).toBe(404);
  });
});
