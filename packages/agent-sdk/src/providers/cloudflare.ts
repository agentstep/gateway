/**
 * Cloudflare sandbox provider.
 *
 * Cloudflare's sandbox runtime (Workers + Durable Objects, exposed via the
 * `@cloudflare/sandbox` SDK) only runs inside Workers — there is no public
 * REST endpoint that takes "execute this command in sandbox X". To use it
 * from outside Cloudflare, you deploy a small Worker that wraps the SDK and
 * exposes the contract below; the gateway calls that Worker over HTTPS.
 *
 * Required configuration:
 *   CLOUDFLARE_SANDBOX_URL    Base URL of the deployed Worker
 *                             (e.g. https://my-sandbox.example.workers.dev)
 *   CLOUDFLARE_SANDBOX_TOKEN  Shared bearer secret the Worker validates
 *
 * Optional:
 *   CLOUDFLARE_SANDBOX_IMAGE  Docker image hint forwarded to the Worker
 *                             (default left to the Worker)
 *
 * Worker contract (the gateway is the client of this — implement on your side):
 *
 *   POST   {base}/sandboxes/{name}          → 201 {} | 200 {} (idempotent create)
 *   POST   {base}/sandboxes/{name}/exec     body {argv, stdin?, timeoutMs?}
 *                                           → 200 {stdout, stderr, exit_code}
 *   DELETE {base}/sandboxes/{name}          → 204 (idempotent)
 *   GET    {base}/sandboxes?prefix=PREFIX   → 200 [{name}]
 *
 * Reference Worker (sketch):
 *
 *   import { getSandbox } from "@cloudflare/sandbox";
 *   export default {
 *     async fetch(req, env) {
 *       if (req.headers.get("authorization") !== `Bearer ${env.TOKEN}`) {
 *         return new Response("unauthorized", { status: 401 });
 *       }
 *       const url = new URL(req.url);
 *       const m = url.pathname.match(/^\/sandboxes\/([^/]+)(\/exec)?$/);
 *       if (!m) return new Response("not found", { status: 404 });
 *       const [, name, isExec] = m;
 *       const sandbox = getSandbox(env.Sandbox, name);
 *       if (req.method === "DELETE") { await sandbox.destroy(); return new Response(null, { status: 204 }); }
 *       if (!isExec)               { return Response.json({}, { status: 201 }); }
 *       const { argv, stdin, timeoutMs } = await req.json();
 *       const r = await sandbox.exec(argv.join(" "), { stdin, timeout: timeoutMs });
 *       return Response.json({ stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode });
 *     },
 *   };
 */
import type { ContainerProvider, ProviderSecrets } from "./types";

function getBaseUrl(secrets?: ProviderSecrets): string {
  const url = secrets?.CLOUDFLARE_SANDBOX_URL ?? process.env.CLOUDFLARE_SANDBOX_URL;
  if (!url) throw new Error("CLOUDFLARE_SANDBOX_URL required — add to vault or .env");
  return url.replace(/\/+$/, "");
}

function getToken(secrets?: ProviderSecrets): string {
  const token = secrets?.CLOUDFLARE_SANDBOX_TOKEN ?? process.env.CLOUDFLARE_SANDBOX_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_SANDBOX_TOKEN required — add to vault or .env");
  return token;
}

function headers(secrets?: ProviderSecrets): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken(secrets)}`,
    "Content-Type": "application/json",
  };
}

export const cloudflareProvider: ContainerProvider = {
  name: "cloudflare",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    if (!(secrets?.CLOUDFLARE_SANDBOX_URL ?? process.env.CLOUDFLARE_SANDBOX_URL)) {
      return { available: false, message: "CLOUDFLARE_SANDBOX_URL required — add to vault or .env" };
    }
    if (!(secrets?.CLOUDFLARE_SANDBOX_TOKEN ?? process.env.CLOUDFLARE_SANDBOX_TOKEN)) {
      return { available: false, message: "CLOUDFLARE_SANDBOX_TOKEN required — add to vault or .env" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const base = getBaseUrl(secrets);
    const res = await fetch(`${base}/sandboxes/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: headers(secrets),
      body: JSON.stringify({
        image: secrets?.CLOUDFLARE_SANDBOX_IMAGE ?? process.env.CLOUDFLARE_SANDBOX_IMAGE,
      }),
    });
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cloudflare sandbox create failed (${res.status}): ${body}`);
    }
  },

  async delete(name, secrets?) {
    try {
      const base = getBaseUrl(secrets);
      const res = await fetch(`${base}/sandboxes/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: headers(secrets),
      });
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => "");
        console.warn(`Cloudflare sandbox delete failed (${res.status}): ${body}`);
      }
    } catch {
      // Best-effort
    }
  },

  async list(opts) {
    try {
      const base = getBaseUrl();
      const prefix = opts?.prefix ?? "ca-sess-";
      const res = await fetch(`${base}/sandboxes?prefix=${encodeURIComponent(prefix)}`, {
        headers: headers(),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ name: string }>;
      return data.filter((s) => s.name.startsWith(prefix));
    } catch {
      return [];
    }
  },

  async exec(name, argv, opts) {
    const secrets = opts?.secrets;
    const base = getBaseUrl(secrets);

    const controller = new AbortController();
    const timer = opts?.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs + 10_000) : null;

    let res: Response;
    try {
      res = await fetch(`${base}/sandboxes/${encodeURIComponent(name)}/exec`, {
        method: "POST",
        headers: headers(secrets),
        body: JSON.stringify({
          argv,
          stdin: opts?.stdin,
          timeoutMs: opts?.timeoutMs,
        }),
        signal: controller.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Cloudflare sandbox exec failed (${res.status}): ${text}`);
    }

    const result = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      exit_code?: number;
    };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exit_code: result.exit_code ?? 0,
    };
  },

  async startExec(name, opts) {
    const secrets = opts.secrets;
    const base = getBaseUrl(secrets);

    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort());
    }
    const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs + 10_000) : null;

    let res: Response;
    try {
      res = await fetch(`${base}/sandboxes/${encodeURIComponent(name)}/exec`, {
        method: "POST",
        headers: headers(secrets),
        body: JSON.stringify({
          argv: opts.argv,
          stdin: opts.stdin,
          timeoutMs: opts.timeoutMs,
        }),
        signal: controller.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Cloudflare sandbox exec failed (${res.status}): ${text}`);
    }

    const result = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      exit_code?: number;
    };

    const encoder = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        if (result.stdout) c.enqueue(encoder.encode(result.stdout));
        c.close();
      },
    });

    return {
      stdout,
      exit: Promise.resolve({ code: result.exit_code ?? 0 }),
      async kill() {
        controller.abort();
      },
    };
  },
};
