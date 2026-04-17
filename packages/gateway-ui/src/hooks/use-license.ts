import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type Feature =
  | "tenancy"
  | "budgets"
  | "upstream_pool"
  | "redis_rate_limit"
  | "per_key_analytics"
  | "unlimited_keys"
  | "unlimited_audit";

export interface LicenseInfo {
  plan: "community" | "enterprise";
  features: Feature[];
  limits: { maxKeys: number; auditRetentionMs: number } | null;
}

/**
 * Fetch the gateway's license tier. Used by UI components to decide
 * whether to show enterprise features (unlocked), badge them
 * (locked + upsell), or hide them entirely.
 *
 * The endpoint is unauthenticated — the plan tier isn't a secret.
 * Returns `{ plan: "community", features: [], limits: {...} }` when
 * no license is configured.
 */
export function useLicense() {
  return useQuery({
    queryKey: ["license"],
    queryFn: async () => {
      try {
        return await api<LicenseInfo>("/license");
      } catch {
        // Pre-v0.5 gateways won't have the endpoint. Treat as community.
        return {
          plan: "community" as const,
          features: [] as Feature[],
          limits: { maxKeys: 20, auditRetentionMs: 7 * 24 * 60 * 60 * 1000 },
        };
      }
    },
    staleTime: 60_000,
  });
}

export function useHasFeature(feature: Feature): boolean {
  const { data } = useLicense();
  if (!data) return false;
  if (data.plan === "enterprise") return true;
  return data.features.includes(feature);
}
