/**
 * Vault service — business logic behind /v1/vaults and vault entries.
 * Secret values are masked at this layer: plaintext never crosses the
 * service boundary toward API consumers (only server-side consumers —
 * driver, sync — read plaintext, via db/vaults directly).
 */
import { z } from "zod";
import { getDb } from "../db/client";
import { createVault, getVault, updateVault, archiveVault, deleteVault, listVaults, listEntries, getEntry, setEntry, deleteEntry } from "../db/vaults";
import { getAgent } from "../db/agents";
import { badRequest, notFound, conflict } from "../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../auth/scope";
import type { AuthContext, Vault } from "../types";

function getVaultTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM vaults WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

function getAgentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM agents WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

export function loadVaultForCaller(auth: AuthContext, id: string): Vault {
  const tenantId = getVaultTenantId(id);
  if (tenantId === undefined) throw notFound(`vault not found: ${id}`);
  assertResourceTenant(auth, tenantId, `vault not found: ${id}`);
  const vault = getVault(id);
  if (!vault) throw notFound(`vault not found: ${id}`);
  return vault;
}

/**
 * Mask a secret value for API responses. Returns preview showing
 * at most the first 4 chars and the last 2 chars, separated by asterisks.
 * Short values (<=6 chars) are fully masked.
 */
function maskValue(value: string): string {
  if (value.length <= 6) return "******";
  return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

const CreateVaultSchema = z.object({
  agent_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  /** Anthropic-compatible alias for `name`. */
  display_name: z.string().min(1).optional(),
  metadata: z.record(z.string().max(512)).optional(),
  /** v0.5: required for global admin, ignored for tenant users. */
  tenant_id: z.string().optional(),
}).refine(data => data.name || data.display_name, {
  message: "Either name or display_name is required",
}).refine(data => !data.metadata || Object.keys(data.metadata).length <= 16, {
  message: "metadata must have at most 16 key-value pairs",
});

const UpdateVaultSchema = z.object({
  display_name: z.string().min(1).max(255).optional(),
  metadata: z.record(z.string().max(512)).optional(),
}).refine(data => !data.metadata || Object.keys(data.metadata).length <= 16, {
  message: "metadata must have at most 16 key-value pairs",
});

const PutEntrySchema = z.object({
  value: z.string(),
});

export function createVaultService(auth: AuthContext, body: unknown): Vault {
  const parsed = CreateVaultSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.message);

  let createTenantId: string;

  if (parsed.data.agent_id) {
    // Agent-scoped vault: tenant comes from the agent.
    const agentTenantId = getAgentTenantId(parsed.data.agent_id);
    if (agentTenantId === undefined) {
      throw notFound(`agent not found: ${parsed.data.agent_id}`);
    }
    assertResourceTenant(auth, agentTenantId, `agent not found: ${parsed.data.agent_id}`);
    const agent = getAgent(parsed.data.agent_id);
    if (!agent) throw notFound(`agent not found: ${parsed.data.agent_id}`);

    createTenantId = resolveCreateTenant(auth, parsed.data.tenant_id);
    if (createTenantId !== agentTenantId) {
      throw badRequest(
        `vault tenant_id must match agent tenant_id (${agentTenantId})`,
      );
    }

    // Check for duplicate vault name on same agent
    const vaultName = (parsed.data.name ?? parsed.data.display_name)!;
    const existing = listVaults({ agent_id: parsed.data.agent_id, tenantFilter: tenantFilter(auth) });
    if (existing.some(v => v.name === vaultName)) {
      throw conflict(`Vault "${vaultName}" already exists for this agent`);
    }
  } else {
    // Standalone vault: tenant from auth context
    createTenantId = resolveCreateTenant(auth, parsed.data.tenant_id);
  }

  // Resolve name from either field (name takes precedence)
  const vaultName = (parsed.data.name ?? parsed.data.display_name)!;

  return createVault({
    agent_id: parsed.data.agent_id ?? null,
    name: vaultName,
    metadata: parsed.data.metadata,
    tenant_id: createTenantId,
  });
}

export function listVaultsService(auth: AuthContext, opts: { agentId?: string }): Vault[] {
  return listVaults({ agent_id: opts.agentId, tenantFilter: tenantFilter(auth) });
}

export function getVaultService(auth: AuthContext, id: string): Vault {
  return loadVaultForCaller(auth, id);
}

export function deleteVaultService(auth: AuthContext, id: string): { id: string; type: string } {
  loadVaultForCaller(auth, id); // tenant guard
  const deleted = deleteVault(id);
  if (!deleted) throw notFound(`vault not found: ${id}`);
  return { id, type: "vault_deleted" };
}

export function updateVaultService(auth: AuthContext, id: string, body: unknown): Vault {
  loadVaultForCaller(auth, id); // tenant guard
  const parsed = UpdateVaultSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.message);
  const vault = updateVault(id, {
    display_name: parsed.data.display_name,
    metadata: parsed.data.metadata,
  });
  if (!vault) throw notFound(`vault not found: ${id}`);
  return vault;
}

export function archiveVaultService(auth: AuthContext, id: string): Vault {
  loadVaultForCaller(auth, id); // tenant guard
  const ok = archiveVault(id);
  if (!ok) throw notFound(`vault not found: ${id}`);
  return getVault(id)!;
}

export function listEntriesService(auth: AuthContext, vaultId: string): Array<{ key: string; value: string }> {
  loadVaultForCaller(auth, vaultId); // tenant guard
  // Return keys with masked values — never expose plaintext via list API
  return listEntries(vaultId).map(e => ({ key: e.key, value: maskValue(e.value) }));
}

export function getEntryService(auth: AuthContext, vaultId: string, key: string): { key: string; value: string } {
  loadVaultForCaller(auth, vaultId); // tenant guard
  const entry = getEntry(vaultId, key);
  if (!entry) throw notFound(`entry not found: ${key}`);
  // Mask value — plaintext is only available to server-side consumers (driver, sync)
  return { key: entry.key, value: maskValue(entry.value) };
}

export function putEntryService(auth: AuthContext, vaultId: string, key: string, body: unknown): { key: string; ok: true } {
  loadVaultForCaller(auth, vaultId); // tenant guard
  const parsed = PutEntrySchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.message);
  setEntry(vaultId, key, parsed.data.value);
  return { key, ok: true };
}

export function deleteEntryService(auth: AuthContext, vaultId: string, key: string): { key: string; type: string } {
  loadVaultForCaller(auth, vaultId); // tenant guard
  const deleted = deleteEntry(vaultId, key);
  if (!deleted) throw notFound(`entry not found: ${key}`);
  return { key, type: "entry_deleted" };
}
