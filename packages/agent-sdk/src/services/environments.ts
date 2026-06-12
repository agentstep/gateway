/**
 * Environment service — business logic behind /v1/environments. Same
 * split as services/agents.ts: body validation + tenant guards + domain
 * rules here; URL parsing and proxy forwarding in the handler codec.
 */
import { z } from "zod";
import { getDb } from "../db/client";
import {
  createEnvironment,
  getEnvironment,
  listEnvironments,
  archiveEnvironment,
  deleteEnvironment,
  hasSessionsAttached,
  updateEnvironment,
} from "../db/environments";
import { kickoffEnvironmentSetup } from "../containers/setup";
import { resolveContainerProvider as resolveProvider } from "../providers/registry";
import { badRequest, conflict, notFound } from "../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../auth/scope";
import type { AuthContext, Environment } from "../types";

function getEnvironmentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM environments WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

export function loadEnvForCaller(auth: AuthContext, id: string): Environment {
  const tenantId = getEnvironmentTenantId(id);
  if (tenantId === undefined) throw notFound(`environment ${id} not found`);
  assertResourceTenant(auth, tenantId, `environment ${id} not found`);
  const env = getEnvironment(id);
  if (!env) throw notFound(`environment ${id} not found`);
  return env;
}

const PackagesSchema = z
  .object({
    apt: z.array(z.string()).optional(),
    cargo: z.array(z.string()).optional(),
    gem: z.array(z.string()).optional(),
    go: z.array(z.string()).optional(),
    npm: z.array(z.string()).optional(),
    pip: z.array(z.string()).optional(),
  })
  .optional();

const NetworkingSchema = z.union([
  z.object({ type: z.literal("unrestricted") }),
  z.object({
    type: z.literal("limited"),
    allowed_hosts: z.array(z.string()).optional(),
    allow_mcp_servers: z.boolean().optional(),
    allow_package_managers: z.boolean().optional(),
  }),
]);

const ConfigSchema = z.object({
  type: z.enum(["cloud", "self_hosted"]),
  provider: z.enum(["sprites", "docker", "apple-container", "apple-firecracker", "podman", "e2b", "vercel", "daytona", "fly", "modal", "mvm", "anthropic"]).optional(),
  packages: PackagesSchema,
  networking: NetworkingSchema.optional(),
  warm_pool_size: z.number().int().min(0).optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1),
  config: ConfigSchema,
  description: z.string().optional().nullable(),
  metadata: z.record(z.string()).optional(),
  backend: z.enum(["anthropic"]).optional(),
  /** v0.5: required for global admin, ignored for tenant users. */
  tenant_id: z.string().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  metadata: z.record(z.string()).optional(),
  config: ConfigSchema.optional(),
});

export type CreateEnvironmentOutcome =
  /** backend "anthropic" — the codec must forward upstream (minus the backend field). */
  | { proxy: true; tenantId: string | null }
  | { proxy: false; environment: Environment };

export async function createEnvironmentService(auth: AuthContext, body: unknown): Promise<CreateEnvironmentOutcome> {
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.message);

  // Backward compat: type: "cloud" with a non-anthropic provider is deprecated
  // Silently treat as self_hosted
  let configData = parsed.data.config;
  if (configData.type === "cloud" && configData.provider && configData.provider !== "anthropic") {
    console.warn(`[compat] type: "cloud" with provider "${configData.provider}" is deprecated — use type: "self_hosted"`);
    configData = { ...configData, type: "self_hosted" };
  }

  // Resolve tenant up-front so both the proxy and local paths can
  // stamp it on any created resources.
  const createTenantId = resolveCreateTenant(auth, parsed.data.tenant_id);

  if (parsed.data.backend === "anthropic") {
    return { proxy: true, tenantId: createTenantId };
  }

  // Check for duplicate name within the caller's tenant scope.
  const existingEnvs = listEnvironments({ limit: 1000, tenantFilter: tenantFilter(auth) });
  if (existingEnvs.some(e => e.name === parsed.data.name)) {
    throw conflict(`Environment with name "${parsed.data.name}" already exists`);
  }

  // Pre-flight: check provider availability before creating the environment.
  // cloud type = Anthropic proxy — no local provider needed.
  // self_hosted = provider is optional (executor provides via DEFAULT_PROVIDER).
  const configType = configData.type;
  const providerName = configData.provider;

  if (configType !== "cloud") {
    // self_hosted — provider is a deprecated fallback; not required.
    if (providerName) {
      const CLOUD_PROVIDERS = new Set(["sprites", "e2b", "vercel", "daytona", "fly", "modal", "anthropic"]);
      if (!CLOUD_PROVIDERS.has(providerName)) {
        const provider = await resolveProvider(providerName);
        if (provider.checkAvailability) {
          const result = await provider.checkAvailability();
          if (!result.available) {
            throw badRequest(`Provider "${providerName}" is not available: ${result.message}`);
          }
        }
      }
    }
  }

  const env = createEnvironment({
    name: parsed.data.name,
    config: configData,
    description: parsed.data.description ?? null,
    metadata: parsed.data.metadata,
    tenant_id: createTenantId,
  });

  kickoffEnvironmentSetup(env.id);
  return { proxy: false, environment: env };
}

export function listEnvironmentsService(
  auth: AuthContext,
  opts: { limit: number; order?: "asc" | "desc"; includeArchived?: boolean; cursor?: string | null },
): Environment[] {
  return listEnvironments({
    limit: opts.limit,
    order: opts.order,
    includeArchived: opts.includeArchived ?? false,
    cursor: opts.cursor ?? undefined,
    tenantFilter: tenantFilter(auth),
  });
}

export function getEnvironmentService(auth: AuthContext, id: string): Environment {
  return loadEnvForCaller(auth, id);
}

export function deleteEnvironmentService(auth: AuthContext, id: string): { id: string; type: string } {
  loadEnvForCaller(auth, id); // tenant guard
  if (hasSessionsAttached(id)) {
    throw conflict(`Cannot delete: environment has active sessions. Archive or delete sessions first.`);
  }
  deleteEnvironment(id);
  return { id, type: "environment_deleted" };
}

export function archiveEnvironmentService(auth: AuthContext, id: string): Environment {
  loadEnvForCaller(auth, id); // tenant guard
  if (hasSessionsAttached(id)) {
    throw conflict(`environment ${id} still has active sessions attached`);
  }
  archiveEnvironment(id);
  return getEnvironment(id)!;
}

export function updateEnvironmentService(auth: AuthContext, id: string, body: unknown): Environment {
  loadEnvForCaller(auth, id); // tenant guard

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.message);

  const updated = updateEnvironment(id, {
    name: parsed.data.name,
    description: parsed.data.description,
    metadata: parsed.data.metadata,
    config: parsed.data.config,
  });
  return updated!;
}
