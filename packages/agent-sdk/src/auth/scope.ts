/**
 * Scope + admin enforcement helpers for virtual keys.
 *
 * v0.4 model:
 *   - AuthContext.permissions = { admin, scope }
 *   - scope === null → unrestricted (equivalent to every resource array = ["*"])
 *   - scope !== null → each resource type (agents, environments, vaults) is an
 *     allow-list. "*" in an array means "all of this type".
 *   - permissions.admin === true → may CRUD keys and other admin-only endpoints.
 *
 * v0.5 will add a tenant precondition before scope check. AuthContext.tenantId
 * is already exposed but unused in v0.4.
 */
import type { AuthContext } from "../types";
import { forbidden } from "../errors";

/** Throws 403 unless the caller is an admin. */
export function requireAdmin(auth: AuthContext): void {
  if (!auth.permissions.admin) {
    throw forbidden("admin permission required");
  }
}

/** True if `id` is present in the allow-list (direct match OR "*" sentinel). */
function allowed(list: string[], id: string): boolean {
  return list.includes("*") || list.includes(id);
}

/**
 * Assert that the caller's scope permits access to the given resources.
 * Pass whichever subset of {agent, env, vaults} applies to the current
 * operation. Undefined fields are not checked.
 *
 * Scope is null (unrestricted) → always pass.
 * Scope is an object → every supplied resource must appear in its list.
 */
export function checkResourceScope(
  auth: AuthContext,
  resources: { agent?: string; env?: string; vaults?: string[] },
): void {
  const { scope } = auth.permissions;
  if (scope === null) return; // unrestricted

  if (resources.agent != null && !allowed(scope.agents, resources.agent)) {
    throw forbidden(`api key scope does not include agent ${resources.agent}`);
  }
  if (resources.env != null && !allowed(scope.environments, resources.env)) {
    throw forbidden(`api key scope does not include environment ${resources.env}`);
  }
  if (resources.vaults && resources.vaults.length > 0) {
    for (const vid of resources.vaults) {
      if (!allowed(scope.vaults, vid)) {
        throw forbidden(`api key scope does not include vault ${vid}`);
      }
    }
  }
}
