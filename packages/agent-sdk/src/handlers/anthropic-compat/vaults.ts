/**
 * Vault handlers — HTTP codec over the vault service
 * (`services/vaults.ts`). Secret masking happens in the service.
 */
import { routeWrap, jsonOk, paginatedOk, parseLimit } from "../../http";
import {
  archiveVaultService,
  createVaultService,
  deleteEntryService,
  deleteVaultService,
  getEntryService,
  getVaultService,
  listEntriesService,
  listVaultsService,
  putEntryService,
  updateVaultService,
} from "../../services/vaults";

// Re-exported for credentials.ts (tenant guard shared across vault routes).
export { loadVaultForCaller } from "../../services/vaults";

export function handleCreateVault(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json();
    return jsonOk(createVaultService(auth, body), 201);
  });
}

export function handleListVaults(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agent_id") ?? undefined;
    const requestedLimit = parseLimit(url.searchParams.get("limit"), 100);
    const data = listVaultsService(auth, { agentId });
    return paginatedOk(data, requestedLimit);
  });
}

export function handleGetVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => jsonOk(getVaultService(auth, id)));
}

export function handleDeleteVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => jsonOk(deleteVaultService(auth, id)));
}

export function handleUpdateVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json();
    return jsonOk(updateVaultService(auth, id, body));
  });
}

export function handleArchiveVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => jsonOk(archiveVaultService(auth, id)));
}

export function handleListEntries(request: Request, vaultId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => jsonOk({ data: listEntriesService(auth, vaultId) }));
}

export function handleGetEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => jsonOk(getEntryService(auth, vaultId, key)));
}

export function handlePutEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json();
    return jsonOk(putEntryService(auth, vaultId, key, body));
  });
}

export function handleDeleteEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => jsonOk(deleteEntryService(auth, vaultId, key)));
}
