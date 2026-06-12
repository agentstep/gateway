/**
 * Programmatic client — the SDK's "real library" surface.
 *
 *   import { createClient } from "@agentstep/agent-sdk/client";
 *
 *   const client = createClient();                         // in-process engine
 *   const client = createClient({ baseUrl, apiKey });      // remote gateway server
 *
 *   const agent = await client.agents.create({ name: "dev", model: "claude-sonnet-4-6" });
 *   const session = await client.sessions.start({ agent: agent.id, environment_id });
 *   for await (const event of session.send("Refactor the auth module")) { ... }
 *
 * Both modes expose the identical typed surface. In-process calls go
 * through the same handler functions as HTTP traffic (auth, validation,
 * audit included) — the client never touches the DB layer directly.
 *
 * Naming: "gateway" is the deployed server/CLI product. This module is the
 * client for it (remote mode) or for the embedded engine (local mode), so
 * its names carry the brand, not the topology.
 */
import type {
  Agent,
  Environment,
  ManagedEvent,
  Memory,
  MemoryStore,
  Session,
  SessionThread,
  Vault,
  VaultEntry,
} from "../types";
import type { ApiCall, Page, Transport } from "./types";
import { ApiClientError, GatewayApiError } from "./types";
import { HttpTransport, type HttpTransportOptions } from "./http-transport";
import { LocalTransport, type LocalTransportOptions } from "./local-transport";
import { applyMiddleware, type ClientMiddleware } from "./middleware";
import { SessionHandle, type SendOptions, type TurnResult, type UserContentBlock } from "./session";
import { buildQuery } from "./wire";

export { ApiClientError, GatewayApiError, SessionHandle };
export type { ApiCall, Page, SendOptions, Transport, TurnResult, UserContentBlock };
export type { HttpTransportOptions, LocalTransportOptions };

// Middleware
export { withLogging, withRetry, type ClientMiddleware } from "./middleware";
export type { LoggingOptions, RetryOptions } from "./middleware";

// Typed event views + guards
export {
  eventText,
  isAgentMessage,
  isAgentThinking,
  isAgentToolResult,
  isAgentToolUse,
  isSessionError,
  isSessionIdle,
  isSessionRunning,
} from "./events";
export type {
  AgentMessageEvent,
  AgentThinkingEvent,
  AgentToolResultEvent,
  AgentToolUseEvent,
  ContentBlock,
  SessionErrorEvent,
  SessionStatusIdleEvent,
  SessionStatusRunningEvent,
  TextBlock,
  ThinkingBlock,
} from "./events";

/** A resource deletion acknowledgement. */
export interface Deleted {
  id: string;
  type: string;
}

export interface CreateAgentInput {
  name: string;
  /** Bare model id (`claude-sonnet-4-6`) or `{ id, speed }`. */
  model: string | { id: string; speed?: "standard" | "fast" };
  system?: string;
  backend?: string;
  confirmation_mode?: boolean;
  [key: string]: unknown;
}

export interface CreateSessionInput {
  agent: string | { id: string; version?: number; type?: string };
  environment_id: string;
  title?: string;
  max_budget_usd?: number;
  [key: string]: unknown;
}

export interface ListOptions {
  limit?: number;
  order?: string;
  include_archived?: boolean;
}

export type ClientOptions = (
  | (HttpTransportOptions & { apiKey: string })
  | LocalTransportOptions
) & {
  /** Composable call middleware, outermost first (e.g. `[withRetry(), withLogging()]`). */
  middleware?: ClientMiddleware[];
};

/** @deprecated Renamed — use `ClientOptions`. */
export type GatewayOptions = ClientOptions;

/**
 * Create a client. With `baseUrl` it talks to a deployed gateway server
 * over HTTP; without, it runs against the in-process engine (local SQLite
 * DB), calling the same handler functions the HTTP adapters mount.
 */
export function createClient(options: ClientOptions = {}): AgentStepClient {
  const transport =
    "baseUrl" in options && options.baseUrl
      ? new HttpTransport(options)
      : new LocalTransport(options);
  return new AgentStepClient(applyMiddleware(transport, options.middleware ?? []));
}

/** @deprecated Renamed — use `createClient`. */
export const createGateway = createClient;

export class AgentStepClient {
  constructor(readonly transport: Transport) {}

  private call<T>(c: ApiCall): Promise<T> {
    return this.transport.call<T>(c);
  }

  agents = {
    create: (input: CreateAgentInput): Promise<Agent> => {
      const { model, ...rest } = input;
      const modelObj = typeof model === "string" ? { id: model } : model;
      return this.call({
        handler: "handleCreateAgent",
        method: "POST",
        path: "/anthropic/v1/agents",
        body: { ...rest, model: modelObj },
      });
    },
    list: (opts?: ListOptions): Promise<Page<Agent>> =>
      this.call({
        handler: "handleListAgents",
        method: "GET",
        path: `/anthropic/v1/agents${buildQuery({
          limit: opts?.limit,
          order: opts?.order,
          include_archived: opts?.include_archived,
        })}`,
      }),
    get: (id: string, version?: number): Promise<Agent> =>
      this.call({
        handler: "handleGetAgent",
        method: "GET",
        path: `/v1/agents/${id}${buildQuery({ version })}`,
        ids: [id],
      }),
    /** Updates use optimistic concurrency — `version` must match the current agent version. */
    update: (id: string, input: { version: number; [key: string]: unknown }): Promise<Agent> =>
      this.call({ handler: "handleUpdateAgent", method: "POST", path: `/v1/agents/${id}`, ids: [id], body: input }),
    delete: (id: string): Promise<Deleted> =>
      this.call({ handler: "handleDeleteAgent", method: "DELETE", path: `/v1/agents/${id}`, ids: [id] }),
    archive: (id: string): Promise<Agent> =>
      this.call({ handler: "handleArchiveAgent", method: "POST", path: `/v1/agents/${id}/archive`, ids: [id] }),
    versions: (id: string, opts?: { limit?: number }): Promise<Page<Agent>> =>
      this.call({
        handler: "handleListAgentVersions",
        method: "GET",
        path: `/v1/agents/${id}/versions${buildQuery({ limit: opts?.limit })}`,
        ids: [id],
      }),
  };

  environments = {
    create: (input: { name: string; config: Record<string, unknown> }): Promise<Environment> =>
      this.call({ handler: "handleCreateEnvironment", method: "POST", path: "/anthropic/v1/environments", body: input }),
    list: (opts?: ListOptions): Promise<Page<Environment>> =>
      this.call({
        handler: "handleListEnvironments",
        method: "GET",
        path: `/anthropic/v1/environments${buildQuery({
          limit: opts?.limit,
          order: opts?.order,
          include_archived: opts?.include_archived,
        })}`,
      }),
    get: (id: string): Promise<Environment> =>
      this.call({ handler: "handleGetEnvironment", method: "GET", path: `/v1/environments/${id}`, ids: [id] }),
    delete: (id: string): Promise<Deleted> =>
      this.call({ handler: "handleDeleteEnvironment", method: "DELETE", path: `/v1/environments/${id}`, ids: [id] }),
    archive: (id: string): Promise<Environment> =>
      this.call({ handler: "handleArchiveEnvironment", method: "POST", path: `/v1/environments/${id}/archive`, ids: [id] }),
  };

  sessions = {
    create: (input: CreateSessionInput): Promise<Session> =>
      this.call({ handler: "handleCreateSession", method: "POST", path: "/anthropic/v1/sessions", body: input }),
    /** Create a session and return a turn-oriented handle for it. */
    start: async (input: CreateSessionInput): Promise<SessionHandle> => {
      const session = await this.sessions.create(input);
      return this.sessions.open(session.id);
    },
    /** Get a turn-oriented handle for an existing session. */
    open: (id: string): SessionHandle => new SessionHandle(this.transport, id),
    list: (
      opts?: ListOptions & { agent_id?: string; environment_id?: string; status?: string },
    ): Promise<Page<Session>> =>
      this.call({
        handler: "handleListSessions",
        method: "GET",
        path: `/anthropic/v1/sessions${buildQuery({
          limit: opts?.limit,
          order: opts?.order,
          agent_id: opts?.agent_id,
          environment_id: opts?.environment_id,
          status: opts?.status,
          include_archived: opts?.include_archived,
        })}`,
      }),
    get: (id: string): Promise<Session> =>
      this.call({ handler: "handleGetSession", method: "GET", path: `/v1/sessions/${id}`, ids: [id] }),
    update: (id: string, input: Record<string, unknown>): Promise<Session> =>
      this.call({ handler: "handleUpdateSession", method: "POST", path: `/v1/sessions/${id}`, ids: [id], body: input }),
    delete: (id: string): Promise<Deleted> =>
      this.call({ handler: "handleDeleteSession", method: "DELETE", path: `/v1/sessions/${id}`, ids: [id] }),
    archive: (id: string): Promise<Session> =>
      this.call({ handler: "handleArchiveSession", method: "POST", path: `/v1/sessions/${id}/archive`, ids: [id] }),
    threads: (id: string, opts?: { limit?: number }): Promise<Page<SessionThread>> =>
      this.call({
        handler: "handleListThreads",
        method: "GET",
        path: `/v1/sessions/${id}/threads${buildQuery({ limit: opts?.limit })}`,
        ids: [id],
      }),
  };

  events = {
    send: (sessionId: string, events: Array<Record<string, unknown>>): Promise<{ data: ManagedEvent[] }> =>
      this.sessions.open(sessionId).post(events),
    list: (
      sessionId: string,
      opts?: { limit?: number; order?: string; after_seq?: number },
    ): Promise<Page<ManagedEvent>> => this.sessions.open(sessionId).events(opts),
    stream: (sessionId: string, afterSeq?: number): AsyncGenerator<ManagedEvent, void, unknown> =>
      this.sessions.open(sessionId).stream(afterSeq),
  };

  vaults = {
    create: (input: { agent_id: string; name: string }): Promise<Vault> =>
      this.call({ handler: "handleCreateVault", method: "POST", path: "/anthropic/v1/vaults", body: input }),
    list: (opts?: { agent_id?: string }): Promise<{ data: Vault[] }> =>
      this.call({
        handler: "handleListVaults",
        method: "GET",
        path: `/anthropic/v1/vaults${buildQuery({ agent_id: opts?.agent_id })}`,
      }),
    get: (id: string): Promise<Vault> =>
      this.call({ handler: "handleGetVault", method: "GET", path: `/v1/vaults/${id}`, ids: [id] }),
    update: (id: string, input: { name?: string; metadata?: Record<string, unknown> }): Promise<Vault> =>
      this.call({ handler: "handleUpdateVault", method: "POST", path: `/v1/vaults/${id}`, ids: [id], body: input }),
    archive: (id: string): Promise<Vault> =>
      this.call({ handler: "handleArchiveVault", method: "POST", path: `/v1/vaults/${id}/archive`, ids: [id] }),
    delete: (id: string): Promise<Deleted> =>
      this.call({ handler: "handleDeleteVault", method: "DELETE", path: `/v1/vaults/${id}`, ids: [id] }),

    entries: {
      list: (vaultId: string): Promise<{ data: VaultEntry[] }> =>
        this.call({ handler: "handleListEntries", method: "GET", path: `/v1/vaults/${vaultId}/entries`, ids: [vaultId] }),
      get: (vaultId: string, key: string): Promise<VaultEntry> =>
        this.call({
          handler: "handleGetEntry",
          method: "GET",
          path: `/v1/vaults/${vaultId}/entries/${encodeURIComponent(key)}`,
          ids: [vaultId, key],
        }),
      set: (vaultId: string, key: string, value: string): Promise<VaultEntry> =>
        this.call({
          handler: "handlePutEntry",
          method: "PUT",
          path: `/v1/vaults/${vaultId}/entries/${encodeURIComponent(key)}`,
          ids: [vaultId, key],
          body: { value },
        }),
      delete: (vaultId: string, key: string): Promise<{ key: string; type: string }> =>
        this.call({
          handler: "handleDeleteEntry",
          method: "DELETE",
          path: `/v1/vaults/${vaultId}/entries/${encodeURIComponent(key)}`,
          ids: [vaultId, key],
        }),
    },
  };

  memory = {
    stores: {
      create: (input: { name: string; agent_id: string; description?: string }): Promise<MemoryStore> =>
        this.call({ handler: "handleCreateMemoryStore", method: "POST", path: "/v1/memory_stores", body: input }),
      list: (): Promise<{ data: MemoryStore[] }> =>
        this.call({ handler: "handleListMemoryStores", method: "GET", path: "/v1/memory_stores" }),
      get: (id: string): Promise<MemoryStore> =>
        this.call({ handler: "handleGetMemoryStore", method: "GET", path: `/v1/memory_stores/${id}`, ids: [id] }),
      delete: (id: string): Promise<Deleted> =>
        this.call({ handler: "handleDeleteMemoryStore", method: "DELETE", path: `/v1/memory_stores/${id}`, ids: [id] }),
    },

    memories: {
      create: (storeId: string, input: { path: string; content: string }): Promise<Memory> =>
        this.call({
          handler: "handleCreateMemory",
          method: "POST",
          path: `/v1/memory_stores/${storeId}/memories`,
          ids: [storeId],
          body: input,
        }),
      list: (storeId: string): Promise<{ data: Memory[] }> =>
        this.call({
          handler: "handleListMemories",
          method: "GET",
          path: `/v1/memory_stores/${storeId}/memories`,
          ids: [storeId],
        }),
      get: (storeId: string, memId: string): Promise<Memory> =>
        this.call({
          handler: "handleGetMemory",
          method: "GET",
          path: `/v1/memory_stores/${storeId}/memories/${memId}`,
          ids: [storeId, memId],
        }),
      update: (storeId: string, memId: string, input: { content: string; content_sha256?: string }): Promise<Memory> =>
        this.call({
          handler: "handleUpdateMemory",
          method: "POST",
          path: `/v1/memory_stores/${storeId}/memories/${memId}`,
          ids: [storeId, memId],
          body: input,
        }),
      delete: (storeId: string, memId: string): Promise<Deleted> =>
        this.call({
          handler: "handleDeleteMemory",
          method: "DELETE",
          path: `/v1/memory_stores/${storeId}/memories/${memId}`,
          ids: [storeId, memId],
        }),
    },
  };

  batch = {
    execute: (
      operations: Array<{ method: string; path: string; body?: unknown }>,
    ): Promise<{ results: Array<{ status: number; body: unknown }> }> =>
      this.call({ handler: "handleBatch", method: "POST", path: "/v1/batch", body: { operations } }),
  };

  skills = {
    search: (opts: {
      q?: string;
      sort?: string;
      limit?: number;
      offset?: number;
      source?: string;
    }): Promise<Record<string, unknown>> =>
      this.call({
        handler: "handleSearchSkills",
        method: "GET",
        path: `/v1/skills${buildQuery({
          q: opts.q,
          sort: opts.sort,
          limit: opts.limit,
          offset: opts.offset,
          source: opts.source,
        })}`,
      }),
    stats: (): Promise<Record<string, unknown>> =>
      this.call({ handler: "handleGetSkillsStats", method: "GET", path: "/v1/skills/stats" }),
    sources: (opts?: { limit?: number }): Promise<Record<string, unknown>> =>
      this.call({
        handler: "handleGetSkillsSources",
        method: "GET",
        path: `/v1/skills/sources${buildQuery({ limit: opts?.limit })}`,
      }),
  };

  providers = {
    status: async (): Promise<Record<string, { available: boolean; message?: string }>> => {
      const res = await this.call<{ data: Record<string, { available: boolean; message?: string }> }>({
        handler: "handleGetProviderStatus",
        method: "GET",
        path: "/v1/providers/status",
      });
      return res.data;
    },
  };
}

/** @deprecated Renamed — use `AgentStepClient`. */
export const GatewayClient = AgentStepClient;
/** @deprecated Renamed — use `AgentStepClient`. */
export type GatewayClient = AgentStepClient;
