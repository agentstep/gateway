import { useAppStore } from "@/stores/app-store";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

// Path resolution:
// - Anthropic-shaped resources use the `/anthropic/v1/*` prefix
// - Gateway-native routes (settings, api-keys, memory, etc.) use `/v1/*`
// Callers pass bare resource names (e.g. "/agents") and the prefix is
// inferred from this list. Adding a new resource requires updating it.
const ANTHROPIC_RESOURCES = new Set([
  "agents", "sessions", "vaults", "files", "environments",
  "user_profiles", "threads", "resources", "oauth",
]);

function resolveUrl(path: string): string {
  const m = path.match(/^\/([^/?#]+)/);
  const first = m?.[1];
  if (first && ANTHROPIC_RESOURCES.has(first)) {
    return `/anthropic/v1${path}`;
  }
  return `/v1${path}`;
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const apiKey = useAppStore.getState().apiKey;
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    ...(opts.headers as Record<string, string>),
  };
  if (opts.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(resolveUrl(path), {
    ...opts,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
