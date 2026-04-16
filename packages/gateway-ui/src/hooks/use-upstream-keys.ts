import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type UpstreamProvider = "anthropic" | "openai" | "gemini";

export interface UpstreamKeyView {
  id: string;
  provider: UpstreamProvider;
  prefix: string;
  weight: number;
  disabled_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

/**
 * List upstream-key pool rows. Admin-only on the server; non-admin
 * callers get a 403 that bubbles up via React Query's error state so
 * the page can hide the section.
 */
export function useUpstreamKeys() {
  return useQuery({
    queryKey: ["upstream-keys"],
    queryFn: async () => {
      try {
        const res = await api<{ data: UpstreamKeyView[] }>("/upstream-keys");
        return res.data;
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 403 || status === 404) return [] as UpstreamKeyView[];
        throw err;
      }
    },
    staleTime: 30_000,
  });
}

export function useAddUpstreamKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { provider: UpstreamProvider; value: string; weight?: number }) =>
      api<UpstreamKeyView>("/upstream-keys", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["upstream-keys"] }),
  });
}

export function useSetUpstreamKeyDisabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      api<UpstreamKeyView>(`/upstream-keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["upstream-keys"] }),
  });
}

export function useDeleteUpstreamKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; id: string }>(`/upstream-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["upstream-keys"] }),
  });
}
