/**
 * Session threads CRUD — multi-agent orchestration.
 *
 * A session thread represents a delegated agent invocation within a
 * coordinator session. Threads share the parent session's container
 * and their events/usage roll up to the parent.
 */
import { eq, and, isNull, lt, gt, asc, desc } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { getAgent } from "./agents";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { SessionThread, SessionThreadRow, SessionThreadStatus } from "../types";

const MAX_THREADS_PER_SESSION = 25;

function hydrate(row: SessionThreadRow): SessionThread {
  const agent = getAgent(row.agent_id, row.agent_version);
  const agentEmbed = agent
    ? {
        type: "agent" as const,
        id: agent.id,
        version: agent.version,
        name: agent.name,
        description: agent.description,
        model: agent.model,
        system: agent.system,
        tools: agent.tools,
        mcp_servers: agent.mcp_servers,
        skills: agent.skills,
      }
    : {
        type: "agent" as const,
        id: row.agent_id,
        version: row.agent_version,
        name: "",
        description: "",
        model: { id: "" },
        system: null as string | null,
        tools: [] as SessionThread["agent"]["tools"],
        mcp_servers: [] as SessionThread["agent"]["mcp_servers"],
        skills: [] as SessionThread["agent"]["skills"],
      };

  return {
    type: "session_thread",
    id: row.id,
    session_id: row.session_id,
    status: row.status,
    agent: agentEmbed,
    parent_thread_id: row.parent_thread_id ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
    usage: {
      input_tokens: row.usage_input_tokens,
      output_tokens: row.usage_output_tokens,
      cache_read_input_tokens: row.usage_cache_read_input_tokens,
      cache_creation: {
        ephemeral_5m_input_tokens: row.usage_cache_creation_input_tokens,
        ephemeral_1h_input_tokens: 0,
      },
    },
    stop_reason: row.stop_reason ?? null,
  };
}

export function createThread(opts: {
  sessionId: string;
  agentId: string;
  agentVersion: number;
  parentThreadId?: string | null;
}): SessionThread {
  const db = getDrizzle();

  // Enforce max threads per session
  const existing = db
    .select({ id: schema.sessionThreads.id })
    .from(schema.sessionThreads)
    .where(
      and(
        eq(schema.sessionThreads.session_id, opts.sessionId),
        isNull(schema.sessionThreads.archived_at),
      ),
    )
    .all();
  if (existing.length >= MAX_THREADS_PER_SESSION) {
    throw new Error(`max threads per session reached (${MAX_THREADS_PER_SESSION})`);
  }

  const id = newId("sth");
  const now = nowMs();

  db.insert(schema.sessionThreads).values({
    id,
    session_id: opts.sessionId,
    agent_id: opts.agentId,
    agent_version: opts.agentVersion,
    parent_thread_id: opts.parentThreadId ?? null,
    status: "idle",
    usage_input_tokens: 0,
    usage_output_tokens: 0,
    usage_cache_read_input_tokens: 0,
    usage_cache_creation_input_tokens: 0,
    created_at: now,
    updated_at: now,
  }).run();

  return getThread(opts.sessionId, id)!;
}

export function getThread(sessionId: string, threadId: string): SessionThread | undefined {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.sessionThreads)
    .where(
      and(
        eq(schema.sessionThreads.id, threadId),
        eq(schema.sessionThreads.session_id, sessionId),
      ),
    )
    .get() as SessionThreadRow | undefined;
  if (!row) return undefined;
  return hydrate(row);
}

export function listThreads(
  sessionId: string,
  opts?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
): SessionThread[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const orderDir = opts?.order === "asc" ? "asc" : "desc";

  const conditions = [eq(schema.sessionThreads.session_id, sessionId)];
  if (opts?.cursor) {
    conditions.push(
      orderDir === "desc"
        ? lt(schema.sessionThreads.id, opts.cursor)
        : gt(schema.sessionThreads.id, opts.cursor),
    );
  }

  const orderClause = orderDir === "desc"
    ? desc(schema.sessionThreads.created_at)
    : asc(schema.sessionThreads.created_at);

  const rows = db
    .select()
    .from(schema.sessionThreads)
    .where(and(...conditions))
    .orderBy(orderClause)
    .limit(limit)
    .all() as SessionThreadRow[];

  return rows.map(hydrate);
}

export function updateThreadStatus(
  threadId: string,
  status: SessionThreadStatus,
  stopReason?: string,
): void {
  const db = getDrizzle();
  const now = nowMs();
  db.update(schema.sessionThreads)
    .set({
      status,
      stop_reason: stopReason ?? null,
      updated_at: now,
    })
    .where(eq(schema.sessionThreads.id, threadId))
    .run();
}

export function updateThreadUsage(
  threadId: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): void {
  const db = getDrizzle();
  const now = nowMs();
  const row = db
    .select()
    .from(schema.sessionThreads)
    .where(eq(schema.sessionThreads.id, threadId))
    .get() as SessionThreadRow | undefined;
  if (!row) return;

  db.update(schema.sessionThreads)
    .set({
      usage_input_tokens: row.usage_input_tokens + (usage.input_tokens ?? 0),
      usage_output_tokens: row.usage_output_tokens + (usage.output_tokens ?? 0),
      usage_cache_read_input_tokens: row.usage_cache_read_input_tokens + (usage.cache_read_input_tokens ?? 0),
      usage_cache_creation_input_tokens: row.usage_cache_creation_input_tokens + (usage.cache_creation_input_tokens ?? 0),
      updated_at: now,
    })
    .where(eq(schema.sessionThreads.id, threadId))
    .run();
}

export function archiveThread(sessionId: string, threadId: string): SessionThread | undefined {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.sessionThreads)
    .where(
      and(
        eq(schema.sessionThreads.id, threadId),
        eq(schema.sessionThreads.session_id, sessionId),
      ),
    )
    .get() as SessionThreadRow | undefined;

  if (!row) return undefined;

  // Can only archive idle threads
  if (row.status !== "idle") {
    throw new Error(`cannot archive thread in status "${row.status}" — must be idle`);
  }

  const now = nowMs();
  db.update(schema.sessionThreads)
    .set({ archived_at: now, updated_at: now })
    .where(eq(schema.sessionThreads.id, threadId))
    .run();

  return getThread(sessionId, threadId);
}

export function countActiveThreads(sessionId: string): number {
  const db = getDrizzle();
  const rows = db
    .select({ id: schema.sessionThreads.id })
    .from(schema.sessionThreads)
    .where(
      and(
        eq(schema.sessionThreads.session_id, sessionId),
        isNull(schema.sessionThreads.archived_at),
      ),
    )
    .all();
  return rows.length;
}
