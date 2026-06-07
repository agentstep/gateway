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

/**
 * The bridge streams the agent's NDJSON stdout, then emits the process exit
 * code as a final NDJSON line: `{"exit_code": N}`. We must (a) surface that
 * code on `exit` so the driver can pick the right stop reason, and (b) strip
 * it from the consumer stream so it never reaches the agent NDJSON translator.
 *
 * Strategy: split into lines and hold the most-recent complete line back by
 * one (a one-line lookahead). Whatever line is held when the stream ends is
 * the exit-code candidate; if it parses as a lone `{"exit_code": N}` we consume
 * it, otherwise we emit it and default to code 0 (older bridge with no footer).
 */
function parseStreamWithExitCode(source: ReadableStream<Uint8Array>): {
  stdout: ReadableStream<Uint8Array>;
  exit: Promise<{ code: number }>;
} {
  let exitResolve!: (v: { code: number }) => void;
  const exit = new Promise<{ code: number }>((r) => (exitResolve = r));
  let settled = false;
  const settle = (code: number) => {
    if (!settled) {
      settled = true;
      exitResolve({ code });
    }
  };

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const tryExitCode = (line: string): number | null => {
    const t = line.trim();
    if (!t) return null;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (
        obj && typeof obj === "object" &&
        Object.keys(obj).length === 1 &&
        typeof obj.exit_code === "number"
      ) {
        return obj.exit_code;
      }
    } catch {
      // Not JSON — a normal agent stdout line.
    }
    return null;
  };

  const stdout = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      let buf = "";
      // Most recent complete segment (newline included), held back by one so
      // we can decide whether the final segment is the exit-code footer.
      let held: string | null = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const seg = buf.slice(0, nl + 1); // keep the newline → byte-exact
            buf = buf.slice(nl + 1);
            // The previously held segment is definitely not the last → emit it.
            if (held !== null) controller.enqueue(encoder.encode(held));
            held = seg;
          }
        }
        // Flush any trailing partial (exit-code footer may arrive unterminated).
        if (buf.length > 0) {
          if (held !== null) controller.enqueue(encoder.encode(held));
          held = buf;
        }
        // `held` is now the final segment — the exit-code candidate.
        if (held !== null) {
          const code = tryExitCode(held);
          if (code === null) controller.enqueue(encoder.encode(held));
          else settle(code);
        }
        controller.close();
        settle(0);
      } catch (err) {
        try { controller.error(err); } catch { /* already errored */ }
        settle(0);
      }
    },
  });

  return { stdout, exit };
}

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
    // Best-effort, like every other provider's list(): boot recovery and the
    // sweeper call this and must not crash if the bridge URL is unset or the
    // bridge is unreachable. resolveConfig() throws on a missing URL, so guard.
    const prefix = opts?.prefix ?? "ca-sess-";
    try {
      const result = await cfJson<{ sandboxes: Array<{ name: string }> }>("/sandboxes", {
        secrets: undefined,
      });
      return result.sandboxes.filter((s) => s.name.startsWith(prefix));
    } catch {
      return [];
    }
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

    const source = res.body as ReadableStream<Uint8Array>;

    // Parse the bridge's trailing `{"exit_code": N}` footer into `exit` and
    // strip it from the consumer stream (see parseStreamWithExitCode).
    const { stdout, exit } = parseStreamWithExitCode(source);

    return {
      stdout,
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
