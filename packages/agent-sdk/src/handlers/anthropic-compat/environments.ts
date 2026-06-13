/**
 * Environment handlers — HTTP codec over the environment service.
 * Proxy interception (backend "anthropic") stays here; everything else
 * lives in `services/environments.ts`.
 */
import { routeWrap, jsonOk, paginatedOk, decodeCursor } from "../../http";
import { isProxied, markProxied, unmarkProxied, getProxiedTenantId } from "../../db/proxy";
import { forwardToAnthropic } from "../../proxy/forward";
import { assertResourceTenant } from "../../auth/scope";
import type { AuthContext } from "../../types";
import {
  archiveEnvironmentService,
  createEnvironmentService,
  deleteEnvironmentService,
  getEnvironmentService,
  listEnvironmentsService,
  updateEnvironmentService,
} from "../../services/environments";

/**
 * Tenant guard for proxied environments. Same rationale as
 * assertProxiedAgentTenant in agents.ts.
 */
function assertProxiedEnvTenant(auth: AuthContext, id: string): void {
  const proxied = getProxiedTenantId(id);
  if (proxied === undefined) return;
  assertResourceTenant(auth, proxied, `environment ${id} not found`);
}

export function handleCreateEnvironment(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;

    const outcome = await createEnvironmentService(auth, body);
    if (outcome.proxy) {
      const { backend: _, ...rest } = body as Record<string, unknown>;
      const forwardBody = JSON.stringify(rest);
      const proxyRes = await forwardToAnthropic(request, "/v1/environments", { body: forwardBody });
      if (proxyRes.ok) {
        try {
          const data = (await proxyRes.clone().json()) as { id: string };
          markProxied(data.id, "environment", outcome.tenantId);
        } catch { /* best-effort */ }
      }
      return proxyRes;
    }
    return jsonOk(outcome.environment, 201);
  });
}

export function handleListEnvironments(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const cursor = decodeCursor(url.searchParams.get("after_id") ?? url.searchParams.get("page"));

    const requestedLimit = limit ? Number(limit) : 20;
    const data = listEnvironmentsService(auth, {
      limit: requestedLimit,
      order: order ?? undefined,
      includeArchived,
      cursor,
    });
    return paginatedOk(data, requestedLimit);
  });
}

export function handleGetEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      return forwardToAnthropic(request, `/v1/environments/${id}`);
    }
    return jsonOk(getEnvironmentService(auth, id));
  });
}

export function handleDeleteEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/environments/${id}`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    return jsonOk(deleteEnvironmentService(auth, id));
  });
}

export function handleArchiveEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/environments/${id}/archive`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    return jsonOk(archiveEnvironmentService(auth, id));
  });
}

export function handleUpdateEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      return forwardToAnthropic(request, `/v1/environments/${id}`, {
        body: await request.text(),
      });
    }
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    return jsonOk(updateEnvironmentService(auth, id, body));
  });
}
