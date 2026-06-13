/**
 * Agent handlers — HTTP codec over the agent service.
 *
 * Responsibilities here: routeWrap (init/auth/error envelopes), URL and
 * query parsing, response envelopes, and proxy interception (engine
 * "anthropic" agents live upstream — forwarding needs the raw Request,
 * which never reaches the service layer). Business logic, body
 * validation, and tenant guards live in `services/agents.ts`.
 */
import { routeWrap, jsonOk, paginatedOk, decodeCursor } from "../../http";
import { isProxied, markProxied, unmarkProxied, getProxiedTenantId } from "../../db/proxy";
import { forwardToAnthropic } from "../../proxy/forward";
import { assertResourceTenant } from "../../auth/scope";
import type { AuthContext } from "../../types";
import {
  archiveAgentService,
  createAgentService,
  deleteAgentService,
  getAgentService,
  listAgentVersionsService,
  listAgentsService,
  updateAgentService,
} from "../../services/agents";

/**
 * Tenant guard for proxied agents. Proxied agents live in
 * `proxy_resources` and have no row in the local `agents` table, so
 * the regular service guard can't help. Legacy rows (no tenant_id)
 * resolve as global-admin-only.
 */
function assertProxiedAgentTenant(auth: AuthContext, id: string): void {
  const proxied = getProxiedTenantId(id);
  if (proxied === undefined) return; // not proxied after all
  assertResourceTenant(auth, proxied, `agent ${id} not found`);
}

export function handleCreateAgent(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;

    const outcome = await createAgentService(auth, body);
    if (outcome.proxy) {
      const proxyRes = await forwardToAnthropic(request, "/v1/agents", { body: rawBody });
      if (proxyRes.ok) {
        try {
          const data = (await proxyRes.clone().json()) as { id: string };
          // Stamp the caller's tenant so subsequent cross-tenant access
          // attempts against this proxy-only resource are rejected.
          markProxied(data.id, "agent", outcome.tenantId);
        } catch { /* best-effort */ }
      }
      return proxyRes;
    }
    return jsonOk(outcome.agent, 201);
  });
}

export function handleListAgents(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const cursor = decodeCursor(url.searchParams.get("after_id") ?? url.searchParams.get("page"));

    const requestedLimit = limit ? Number(limit) : 20;
    const data = listAgentsService(auth, {
      limit: requestedLimit,
      order: order ?? undefined,
      includeArchived,
      cursor,
    });
    return paginatedOk(data, requestedLimit);
  });
}

export function handleGetAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      return forwardToAnthropic(request, `/v1/agents/${id}`);
    }
    const url = new URL(request.url);
    const versionParam = url.searchParams.get("version");
    const version = versionParam ? Number(versionParam) : undefined;
    return jsonOk(getAgentService(auth, id, version));
  });
}

export function handleUpdateAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      return forwardToAnthropic(request, `/v1/agents/${id}`);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    return jsonOk(await updateAgentService(auth, id, body));
  });
}

export function handleDeleteAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/agents/${id}`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    return jsonOk(deleteAgentService(auth, id));
  });
}

export function handleArchiveAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/agents/${id}/archive`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    return jsonOk(archiveAgentService(auth, id));
  });
}

export function handleListAgentVersions(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const cursorRaw = decodeCursor(url.searchParams.get("after_id") ?? url.searchParams.get("page"));
    const cursor = cursorRaw ? Number(cursorRaw) : undefined;

    const requestedLimit = limit ? Number(limit) : 20;
    const data = listAgentVersionsService(auth, id, { limit: requestedLimit, cursor });

    const hasMore = data.length === requestedLimit;
    const firstId = data.length > 0 ? String(data[0].version) : null;
    const lastId = data.length > 0 ? String(data[data.length - 1].version) : null;
    return jsonOk({ data, has_more: hasMore, first_id: firstId, last_id: lastId });
  });
}
