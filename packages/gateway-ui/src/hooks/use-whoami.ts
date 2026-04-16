import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface WhoamiResponse {
  name: string;
  tenant_id: string | null;
  is_global_admin: boolean;
  permissions: {
    admin: boolean;
    scope: { agents: string[]; environments: string[]; vaults: string[] } | null;
  };
}

/**
 * Identify the caller. Used by the sidebar footer and by page-level
 * permission checks (e.g. hiding the Tenants nav item from non-admins
 * after we learn they're scoped).
 *
 * The endpoint was added in v0.5; older gateways return 404. We surface
 * that as `undefined` rather than a thrown error so the UI can still
 * render in pre-upgrade mode.
 */
export function useWhoami() {
  return useQuery({
    queryKey: ["whoami"],
    queryFn: async () => {
      try {
        return await api<WhoamiResponse>("/whoami");
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 404) return undefined;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}
