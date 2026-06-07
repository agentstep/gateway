/**
 * Fly.io Machines provider using REST API.
 *
 * Uses the Fly Machines API (docs.machines.dev) to create and manage
 * containers. No SDK required — communicates via plain HTTP fetch.
 *
 * Container lifecycle:
 *   create → POST /v1/apps/{app}/machines
 *   exec   → POST /v1/apps/{app}/machines/{id}/exec
 *   delete → DELETE /v1/apps/{app}/machines/{id}?force=true
 *
 * Exec is always buffered (no streaming endpoint exists). The API returns
 * a JSON envelope with stdout/stderr/exit_code after the command completes.
 *
 * Fly Machines are identified by machine IDs (not names), so we maintain
 * a name→id map to conform to the ContainerProvider interface.
 *
 * Env vars: FLY_API_TOKEN, FLY_APP_NAME, FLY_IMAGE (default: "node:22")
 */
import type { ContainerProvider, ExecOptions, ExecSession, ProviderSecrets } from "./types";
import { ContainerGone } from "./types";
import { shellEscape } from "./shared";
import { readEnvOrSetting, getConfig } from "../config";

const BASE_URL = "https://api.machines.dev";

function getToken(secrets?: ProviderSecrets): string {
  const token = secrets?.FLY_API_TOKEN ?? readEnvOrSetting("FLY_API_TOKEN");
  if (!token) throw new Error("FLY_API_TOKEN required — add to vault, .env, or gateway settings");
  return token;
}

function getAppName(secrets?: ProviderSecrets): string {
  const app = secrets?.FLY_APP_NAME ?? readEnvOrSetting("FLY_APP_NAME");
  if (!app) throw new Error("FLY_APP_NAME required — add to vault, .env, or gateway settings");
  return app;
}

function headers(secrets?: ProviderSecrets): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken(secrets)}`,
    "Content-Type": "application/json",
  };
}

// HMR-safe name→machineId map
type GlobalWithFly = typeof globalThis & { __caFlyMachines?: Map<string, string> };
const g = globalThis as GlobalWithFly;
if (!g.__caFlyMachines) g.__caFlyMachines = new Map();
const machines = g.__caFlyMachines;

function getImage(secrets?: ProviderSecrets): string {
  return secrets?.FLY_IMAGE ?? process.env.FLY_IMAGE ?? "node:22";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Above this many base64 chars, inlining stdin as `echo '<b64>'` risks blowing
// the kernel per-arg limit (MAX_ARG_STRLEN ~128KB). Past it, write the base64
// to a temp file in bounded chunks (each a separate small exec) instead.
const STDIN_INLINE_LIMIT = 96_000;
const STDIN_CHUNK = 48_000;

/** Build the exec request body per the Machines API spec from a final command. */
function buildExecBody(fullCmd: string, timeoutMs?: number): Record<string, unknown> {
  return {
    // `command` (string[]) is the current field; `cmd` (string) is deprecated.
    command: ["bash", "-c", fullCmd],
    timeout: timeoutMs ? Math.ceil(timeoutMs / 1000) : 60,
  };
}

/** Run a raw shell command on a machine (used for chunked stdin writes). */
async function execRaw(
  name: string,
  app: string,
  machineId: string,
  command: string,
  secrets: ProviderSecrets | undefined,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/apps/${app}/machines/${machineId}/exec`, {
    method: "POST",
    headers: headers(secrets),
    body: JSON.stringify({ command: ["bash", "-c", command], timeout: 60 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404) throw new ContainerGone(name, `Fly machine ${machineId} gone (404): ${text}`);
    throw new Error(`Fly stdin write failed (${res.status}): ${text}`);
  }
}

/**
 * Build the full shell command, piping stdin in. Small stdin is inlined via
 * base64; large stdin is written to a temp file in chunks (Fly's Machines exec
 * has no file-write API, so we append via repeated small execs) to dodge
 * ARG_MAX, then decoded. base64 contains no single quotes, so quoting is safe.
 */
async function buildStdinFullCmd(
  name: string,
  app: string,
  machineId: string,
  argv: string[],
  stdin: string | undefined,
  secrets: ProviderSecrets | undefined,
): Promise<string> {
  const cmd = argv.map((a) => shellEscape(a)).join(" ");
  if (!stdin) return cmd;
  const b64 = Buffer.from(stdin).toString("base64");
  if (b64.length <= STDIN_INLINE_LIMIT) {
    return `echo '${b64}' | base64 -d | ${cmd}`;
  }
  const path = `/tmp/_stdin_${Date.now()}_${Math.random().toString(36).slice(2)}.b64`;
  for (let i = 0; i < b64.length; i += STDIN_CHUNK) {
    await execRaw(name, app, machineId, `printf '%s' '${b64.slice(i, i + STDIN_CHUNK)}' >> ${path}`, secrets);
  }
  return `base64 -d ${path} | ${cmd} ; rm -f ${path}`;
}

/** Refresh the in-memory name→machineId map from the Fly API. */
async function refreshMachineMap(
  prefix?: string,
  secrets?: ProviderSecrets,
): Promise<Array<{ name: string }>> {
  const app = getAppName(secrets);
  try {
    const res = await fetch(`${BASE_URL}/v1/apps/${app}/machines`, {
      headers: headers(secrets),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ id: string; name?: string }>;
    const pfx = prefix ?? "ca-sess-";
    for (const m of data) {
      if (m.name) machines.set(m.name, m.id);
    }
    return data
      .filter((m) => m.name?.startsWith(pfx))
      .map((m) => ({ name: m.name! }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const flyProvider: ContainerProvider = {
  name: "fly",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    if (!(secrets?.FLY_API_TOKEN ?? readEnvOrSetting("FLY_API_TOKEN"))) {
      return { available: false, message: "FLY_API_TOKEN required — add to vault, .env, or gateway settings" };
    }
    if (!(secrets?.FLY_APP_NAME ?? readEnvOrSetting("FLY_APP_NAME"))) {
      return { available: false, message: "FLY_APP_NAME required — add to vault, .env, or gateway settings" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const app = getAppName(secrets);
    const res = await fetch(`${BASE_URL}/v1/apps/${app}/machines`, {
      method: "POST",
      headers: headers(secrets),
      body: JSON.stringify({
        name,
        config: {
          image: getImage(secrets),
          auto_destroy: true,
          guest: {
            cpu_kind: "shared",
            cpus: 2,
            memory_mb: 1024,
          },
          init: {
            cmd: ["sleep", "infinity"],
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Fly create failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { id: string };
    machines.set(name, data.id);

    // Wait for the machine to start
    const machineId = data.id;
    const startRes = await fetch(
      `${BASE_URL}/v1/apps/${app}/machines/${machineId}/wait?state=started&timeout=60`,
      { headers: headers(secrets) },
    );
    if (!startRes.ok) {
      const body = await startRes.text().catch(() => "");
      console.warn(`Fly machine wait-for-start warning (${startRes.status}): ${body}`);
    }
  },

  async delete(name, secrets?) {
    const machineId = machines.get(name);
    if (!machineId) return;
    const app = getAppName(secrets);
    try {
      // Stop first, then destroy
      await fetch(`${BASE_URL}/v1/apps/${app}/machines/${machineId}/stop`, {
        method: "POST",
        headers: headers(secrets),
      }).catch(() => {});

      const res = await fetch(
        `${BASE_URL}/v1/apps/${app}/machines/${machineId}?force=true`,
        {
          method: "DELETE",
          headers: headers(secrets),
        },
      );
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => "");
        console.warn(`Fly delete failed (${res.status}): ${body}`);
      }
    } catch {
      // Best-effort
    }
    machines.delete(name);
  },

  async list(opts) {
    return refreshMachineMap(opts?.prefix);
  },

  async exec(name, argv, opts) {
    let machineId = machines.get(name);
    const secrets = opts?.secrets;
    if (!machineId) {
      await refreshMachineMap("ca-sess-", secrets);
      machineId = machines.get(name);
      // Not in the app's machine list → reaped upstream. ContainerGone so the
      // driver re-acquires and retries rather than failing the turn.
      if (!machineId) throw new ContainerGone(name, `Fly machine not found for name: ${name}`);
    }
    const app = getAppName(secrets);

    const fullCmd = await buildStdinFullCmd(name, app, machineId, argv, opts?.stdin, secrets);
    const execBody = buildExecBody(fullCmd, opts?.timeoutMs);
    const timeoutSec = (execBody.timeout as number) ?? 60;

    const res = await fetch(
      `${BASE_URL}/v1/apps/${app}/machines/${machineId}/exec`,
      {
        method: "POST",
        headers: headers(secrets),
        body: JSON.stringify(execBody),
        signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new ContainerGone(name, `Fly machine ${machineId} gone (404): ${text}`);
      }
      throw new Error(`Fly exec failed (${res.status}): ${text}`);
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
    let machineId = machines.get(name);
    const secrets = opts.secrets;
    if (!machineId) {
      await refreshMachineMap("ca-sess-", secrets);
      machineId = machines.get(name);
      if (!machineId) throw new ContainerGone(name, `Fly machine not found for name: ${name}`);
    }
    const app = getAppName(secrets);

    const fullCmd = await buildStdinFullCmd(name, app, machineId, opts.argv, opts.stdin, secrets);
    const execBody = buildExecBody(fullCmd, opts.timeoutMs ?? getConfig().agentTimeoutMs);

    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener("abort", () => controller.abort());
      }
    }
    const timeoutSec = (execBody.timeout as number) ?? 300;
    const fetchTimer = setTimeout(() => controller.abort(), (timeoutSec + 10) * 1000);

    let res: Response;
    try {
      res = await fetch(
        `${BASE_URL}/v1/apps/${app}/machines/${machineId}/exec`,
        {
          method: "POST",
          headers: headers(secrets),
          body: JSON.stringify(execBody),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(fetchTimer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new ContainerGone(name, `Fly machine ${machineId} gone (404): ${text}`);
      }
      throw new Error(`Fly exec failed (${res.status}): ${text}`);
    }

    // Fly exec is always buffered — returns JSON with stdout/stderr/exit_code.
    // Extract stdout and wrap in a ReadableStream for the provider interface.
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
