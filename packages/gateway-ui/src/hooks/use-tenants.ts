import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface Tenant {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
}

/**
 * List tenants. Global admin sees all; the endpoint returns 403 for
 * non-global-admin callers — we catch that here and return an empty
 * list so the UI degrades gracefully (tenant users simply don't see
 * the switcher / tenants page).
 */
export function useTenants() {
  return useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      try {
        const res = await api<{ data: Tenant[] }>("/tenants");
        return res.data;
      } catch (err) {
        // 403 / 404 — caller isn't global admin; pretend empty.
        const status = (err as { status?: number })?.status;
        if (status === 403 || status === 404) return [] as Tenant[];
        throw err;
      }
    },
    // Tenants change rarely; 30s cache is fine and avoids thrashing
    // when the switcher mounts/remounts across pages.
    staleTime: 30_000,
  });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; id?: string }) =>
      api<Tenant>("/tenants", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
}

export function useRenameTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<Tenant>(`/tenants/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
}

export function useArchiveTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; id: string }>(`/tenants/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
}
