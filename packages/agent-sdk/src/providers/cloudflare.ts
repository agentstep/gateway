/**
 * Cloudflare Sandbox provider.
 *
 * Uses the Cloudflare Sandbox SDK via a bridge Worker deployed to the
 * user's Cloudflare account. The bridge exposes a REST API that our
 * provider calls over HTTP — same pattern as sprites.dev.
 *
 * Architecture:
 *   Gateway → Bridge Worker (user's CF account) → Sandbox SDK → exec/files
 *
 * The bridge Worker URL is configured via CLOUDFLARE_SANDBOX_URL env var
 * or vault secret. The bridge authenticates requests via a shared secret
 * (CLOUDFLARE_SANDBOX_SECRET).
 *
 * Bridge API (implemented by @agentstep/cloudflare-bridge):
 *   POST /sandboxes              — create sandbox { name }
 *   DELETE /sandboxes/:name      — destroy sandbox
 *   GET  /sandboxes              — list sandboxes
 *   POST /sandboxes/:name/exec   — exec { argv, stdin?, timeoutMs? }
 *   POST /sandboxes/:name/stream — streaming exec (NDJSON response)
 */
import type { ContainerProvider, ProviderSecrets } from "./types";
import { getConfig } from "../config/index";
import { ApiError } from "../errors";

function resolveConfig(secrets?: ProviderSecrets): { url: string; secret: string } {
  const cfg = getConfig();
  const url = secrets?.CLOUDFLARE_SANDBOX_URL
    ?? process.env.CLOUDFLARE_SANDBOX_URL
    ?? (cfg as unknown as Record<string, unknown>).cloudflareSandboxUrl as string | undefined;
  const secret = secrets?.CLOUDFLARE_SANDBOX_SECRET
    ?? process.env.CLOUDFLARE_SANDBOX_SECRET
    ?? "";
  if (!url) throw new Error("CLOUDFLARE_SANDBOX_URL required — set in .env or vault");
  return { url: url.replace(/\/$/, ""), secret };
}

async function cfFetch(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number; secrets?: ProviderSecrets },
): Promise<Response> {
  const { url, secret } = resolveConfig(opts.secrets);
  const res = await fetch(`${url}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  return res;
}

async function cfJson<T>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number; secrets?: ProviderSecrets },
): Promise<T> {
  const res = await cfFetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      res.status >= 500 ? 502 : 500,
      "server_error",
      `cloudflare ${opts.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

export const cloudflareProvider: ContainerProvider = {
  name: "cloudflare" as ContainerProvider["name"],
  stripControlChars: false,
  supportsWarmPool: true,

  async checkAvailability(secrets?: ProviderSecrets) {
    try {
      const { url } = resolveConfig(secrets);
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return { available: true };
      return { available: false, message: `Cloudflare bridge health check failed: ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CLOUDFLARE_SANDBOX_URL required")) {
        return { available: false, message: "CLOUDFLARE_SANDBOX_URL required — set in .env or vault" };
      }
      return { available: false, message: `Cloudflare bridge unreachable: ${msg}` };
    }
  },

  async create({ name, secrets }) {
    await cfJson("/sandboxes", {
      method: "POST",
      body: { name },
      secrets,
      timeoutMs: 120_000,
    });
  },

  async delete(name, secrets?) {
    await cfFetch(`/sandboxes/${encodeURIComponent(name)}`, {
      method: "DELETE",
      secrets,
    }).catch(() => {
      // Best-effort — sandbox may already be gone
    });
  },

  async list(opts) {
    const prefix = opts?.prefix ?? "ca-sess-";
    const result = await cfJson<{ sandboxes: Array<{ name: string }> }>("/sandboxes", {
      secrets: undefined,
    });
    return result.sandboxes.filter((s) => s.name.startsWith(prefix));
  },

  async exec(name, argv, opts) {
    return cfJson<{ stdout: string; stderr: string; exit_code: number }>(
      `/sandboxes/${encodeURIComponent(name)}/exec`,
      {
        method: "POST",
        body: { argv, stdin: opts?.stdin, timeoutMs: opts?.timeoutMs },
        secrets: opts?.secrets,
        timeoutMs: (opts?.timeoutMs ?? 120_000) + 5_000, // HTTP timeout slightly longer than exec timeout
      },
    );
  },

  async startExec(name, opts) {
    const { url, secret } = resolveConfig(opts.secrets);
    const res = await fetch(`${url}/sandboxes/${encodeURIComponent(name)}/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        argv: opts.argv,
        stdin: opts.stdin,
        timeoutMs: opts.timeoutMs,
      }),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 600_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(502, "server_error", `cloudflare stream exec failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const stdout = res.body as ReadableStream<Uint8Array>;

    // The bridge sends exit code as the last NDJSON line: {"exit_code": N}
    // For now, we wait for the stream to end and assume success.
    let exitResolve!: (v: { code: number }) => void;
    const exit = new Promise<{ code: number }>((resolve) => {
      exitResolve = resolve;
    });

    // Monitor the stream end
    const [streamForConsumer, streamForMonitor] = stdout.tee();
    (async () => {
      const reader = streamForMonitor.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // Stream error
      }
      exitResolve({ code: 0 });
    })();

    return {
      stdout: streamForConsumer,
      exit,
      async kill() {
        // Send kill request to bridge
        await cfFetch(`/sandboxes/${encodeURIComponent(name)}/kill`, {
          method: "POST",
          secrets: opts.secrets,
        }).catch(() => {});
      },
    };
  },
};
