/**
 * Daytona sandbox provider using REST API.
 *
 * Uses Daytona's sandbox API (app.daytona.io) to create and manage
 * isolated development environments. No SDK required — plain HTTP fetch.
 *
 * Two base URLs:
 *   Control plane: https://app.daytona.io/api  (CRUD lifecycle)
 *   Toolbox proxy: https://proxy.app.daytona.io/toolbox/{sandboxId}  (exec, fs)
 *
 * Sandbox lifecycle:
 *   create → POST /api/sandbox
 *   exec   → POST /toolbox/{sandboxId}/process/execute  (via proxy)
 *   delete → DELETE /api/sandbox/{sandboxId}
 *
 * Env vars: DAYTONA_API_KEY (required),
 *           DAYTONA_API_URL (default: https://app.daytona.io/api),
 *           DAYTONA_PROXY_URL (default: https://proxy.app.daytona.io/toolbox)
 */
import type { ContainerProvider, ExecOptions, ExecSession, ProviderSecrets } from "./types";
import { ContainerGone } from "./types";
import { shellEscape } from "./shared";

function getApiUrl(secrets?: ProviderSecrets): string {
  return (secrets?.DAYTONA_API_URL ?? process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api").replace(/\/+$/, "");
}

function getProxyUrl(secrets?: ProviderSecrets): string {
  return (secrets?.DAYTONA_PROXY_URL ?? process.env.DAYTONA_PROXY_URL ?? "https://proxy.app.daytona.io/toolbox").replace(/\/+$/, "");
}

function getApiKey(secrets?: ProviderSecrets): string {
  const key = secrets?.DAYTONA_API_KEY ?? process.env.DAYTONA_API_KEY;
  if (!key) throw new Error("DAYTONA_API_KEY required — add to vault or .env");
  return key;
}

function headers(secrets?: ProviderSecrets): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey(secrets)}`,
    "Content-Type": "application/json",
  };
}

// HMR-safe name→sandboxId map (Daytona uses separate IDs from names)
type GlobalWithDaytona = typeof globalThis & { __caDaytonaSandboxes?: Map<string, string> };
const g = globalThis as GlobalWithDaytona;
if (!g.__caDaytonaSandboxes) g.__caDaytonaSandboxes = new Map();
const sandboxIds = g.__caDaytonaSandboxes;

// Above this many base64 chars, inlining stdin as `echo '<b64>'` risks blowing
// the kernel's per-arg limit (MAX_ARG_STRLEN ~128KB). Past the threshold we
// write the base64 to a temp file in bounded chunks instead.
const STDIN_INLINE_LIMIT = 96_000;
const STDIN_CHUNK = 48_000;

/** POST a raw shell command to the toolbox (used for chunked stdin writes). */
async function execRaw(
  name: string,
  sandboxId: string,
  command: string,
  secrets: ProviderSecrets | undefined,
  proxyUrl: string,
): Promise<void> {
  const res = await fetch(
    `${proxyUrl}/${encodeURIComponent(sandboxId)}/process/execute`,
    { method: "POST", headers: headers(secrets), body: JSON.stringify({ command }) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404) throw new ContainerGone(name, `Daytona sandbox ${sandboxId} gone (404): ${text}`);
    throw new Error(`Daytona stdin write failed (${res.status}): ${text}`);
  }
}

/**
 * Build the shell command, piping stdin in. Small stdin is inlined via base64;
 * large stdin is written to a temp file in chunks (each a separate small exec)
 * to dodge ARG_MAX, then decoded into the command. base64's alphabet contains
 * no single quotes, so single-quoting each chunk is safe.
 */
async function buildStdinCommand(
  name: string,
  sandboxId: string,
  argv: string[],
  stdin: string | undefined,
  secrets: ProviderSecrets | undefined,
  proxyUrl: string,
): Promise<string> {
  const cmd = argv.map((a) => shellEscape(a)).join(" ");
  if (!stdin) return cmd;
  const b64 = Buffer.from(stdin).toString("base64");
  if (b64.length <= STDIN_INLINE_LIMIT) {
    return `echo '${b64}' | base64 -d | ${cmd}`;
  }
  const path = `/tmp/_stdin_${Date.now()}_${Math.random().toString(36).slice(2)}.b64`;
  for (let i = 0; i < b64.length; i += STDIN_CHUNK) {
    await execRaw(name, sandboxId, `printf '%s' '${b64.slice(i, i + STDIN_CHUNK)}' >> ${path}`, secrets, proxyUrl);
  }
  return `base64 -d ${path} | ${cmd} ; rm -f ${path}`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const daytonaProvider: ContainerProvider = {
  name: "daytona",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    if (!(secrets?.DAYTONA_API_KEY ?? process.env.DAYTONA_API_KEY)) {
      return { available: false, message: "DAYTONA_API_KEY required — add to vault or .env" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const url = getApiUrl(secrets);
    const res = await fetch(`${url}/sandbox`, {
      method: "POST",
      headers: headers(secrets),
      body: JSON.stringify({
        name,
        language: "javascript",
        autoStopInterval: 120,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Daytona create failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { id?: string; name?: string };
    const sandboxId = data.id ?? data.name ?? name;
    sandboxIds.set(name, sandboxId);

    // Wait for sandbox to reach "started" state (max 120s)
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const infoRes = await fetch(`${url}/sandbox/${encodeURIComponent(sandboxId)}`, {
        headers: headers(secrets),
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as { state?: string };
        if (info.state === "started") break;
        if (info.state === "error" || info.state === "build_failed") {
          throw new Error(`Daytona sandbox failed to start: state=${info.state}`);
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (Date.now() >= deadline) {
      throw new Error("Daytona sandbox did not reach 'started' state within 120s");
    }
  },

  async delete(name, secrets?) {
    const sandboxId = sandboxIds.get(name) ?? name;
    const url = getApiUrl(secrets);
    try {
      const res = await fetch(`${url}/sandbox/${encodeURIComponent(sandboxId)}`, {
        method: "DELETE",
        headers: headers(secrets),
      });
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => "");
        console.warn(`Daytona delete failed (${res.status}): ${body}`);
      }
    } catch {
      // Best-effort
    }
    sandboxIds.delete(name);
  },

  async list(opts) {
    const url = getApiUrl();
    try {
      const res = await fetch(`${url}/sandbox`, { headers: headers() });
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ id: string; name?: string }>;
      const prefix = opts?.prefix ?? "ca-sess-";
      // Update name→id map
      for (const s of data) {
        if (s.name) sandboxIds.set(s.name, s.id);
      }
      return data
        .filter((s) => (s.name ?? s.id).startsWith(prefix))
        .map((s) => ({ name: s.name ?? s.id }));
    } catch {
      return [];
    }
  },

  async exec(name, argv, opts) {
    const sandboxId = sandboxIds.get(name) ?? name;
    const secrets = opts?.secrets;
    const proxyUrl = getProxyUrl(secrets);

    const fullCmd = await buildStdinCommand(name, sandboxId, argv, opts?.stdin, secrets, proxyUrl);

    const res = await fetch(
      `${proxyUrl}/${encodeURIComponent(sandboxId)}/process/execute`,
      {
        method: "POST",
        headers: headers(secrets),
        body: JSON.stringify({
          command: fullCmd,
          timeout: opts?.timeoutMs,
        }),
        signal: opts?.timeoutMs
          ? AbortSignal.timeout(opts.timeoutMs + 10_000)
          : undefined,
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 404 means the sandbox was reaped upstream — signal ContainerGone so the
      // driver drops the stale pool entry, re-acquires, and retries.
      if (res.status === 404) {
        throw new ContainerGone(name, `Daytona sandbox ${sandboxId} gone (404): ${text}`);
      }
      throw new Error(`Daytona exec failed (${res.status}): ${text}`);
    }

    const result = (await res.json()) as {
      result?: string;
      exitCode?: number;
    };
    return {
      stdout: result.result ?? "",
      stderr: "",
      exit_code: result.exitCode ?? 0,
    };
  },

  async startExec(name, opts) {
    const sandboxId = sandboxIds.get(name) ?? name;
    const secrets = opts.secrets;
    const proxyUrl = getProxyUrl(secrets);

    const fullCmd = await buildStdinCommand(name, sandboxId, opts.argv, opts.stdin, secrets, proxyUrl);

    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener("abort", () => controller.abort());
      }
    }
    const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs + 10_000) : null;

    let res: Response;
    try {
      res = await fetch(
        `${proxyUrl}/${encodeURIComponent(sandboxId)}/process/execute`,
        {
          method: "POST",
          headers: headers(secrets),
          body: JSON.stringify({
            command: fullCmd,
            timeout: opts.timeoutMs,
          }),
          signal: controller.signal,
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new ContainerGone(name, `Daytona sandbox ${sandboxId} gone (404): ${text}`);
      }
      throw new Error(`Daytona exec failed (${res.status}): ${text}`);
    }

    // Daytona exec is buffered — extract result and wrap in stream.
    const result = (await res.json()) as {
      result?: string;
      exitCode?: number;
    };

    const encoder = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        if (result.result) c.enqueue(encoder.encode(result.result));
        c.close();
      },
    });

    return {
      stdout,
      exit: Promise.resolve({ code: result.exitCode ?? 0 }),
      async kill() {
        controller.abort();
      },
    };
  },
};
