/**
 * AWS Lambda MicroVMs provider.
 *
 * Lambda MicroVMs (announced 2026) are Firecracker-backed, stateful,
 * isolated sandboxes with full lifecycle control: launch from a snapshot,
 * suspend, resume, terminate. Each running microVM exposes a dedicated
 * HTTPS endpoint that clients connect to — there is no kubectl/docker-style
 * "exec into the box", so command execution goes through a small agent
 * served on that endpoint (the same shape as our Cloudflare bridge).
 *
 * Two planes:
 *   Control plane (SigV4-signed, AWS service "lambda"):
 *     create    → POST   {prefix}/microvms              (RunMicroVM)
 *     get       → GET    {prefix}/microvms/{id}
 *     suspend   → POST   {prefix}/microvms/{id}/suspend (SuspendMicroVM)
 *     resume    → POST   {prefix}/microvms/{id}/resume  (ResumeMicroVM)
 *     terminate → DELETE {prefix}/microvms/{id}         (TerminateMicroVM)
 *   Data plane (per-microVM HTTPS endpoint, bearer auth token from RunMicroVM):
 *     exec      → POST {endpoint}/exec         { argv, stdin?, timeoutMs? }
 *     stream    → POST {endpoint}/exec/stream  (raw stdout stream)
 *
 * The control-plane host and version prefix are configurable because the
 * service is new; defaults follow standard AWS conventions and can be
 * overridden per-deployment without code changes.
 *
 * Env / vault secrets:
 *   AWS_ACCESS_KEY_ID            required
 *   AWS_SECRET_ACCESS_KEY        required
 *   AWS_SESSION_TOKEN            optional (STS)
 *   AWS_REGION                   default "us-east-1"
 *   LAMBDA_MICROVM_SNAPSHOT      required — snapshot id/ARN to launch from
 *   LAMBDA_MICROVM_ENDPOINT      default https://lambda.{region}.amazonaws.com
 *   LAMBDA_MICROVM_SERVICE       default "lambda"  (SigV4 service name)
 *   LAMBDA_MICROVM_PREFIX        default "/2026-06-30"  (API version path)
 *   LAMBDA_MICROVM_VCPUS         default 2
 *   LAMBDA_MICROVM_MEMORY_MIB    default 4096
 */
import { createHash, createHmac } from "node:crypto";
import type { ContainerProvider, ExecOptions, ExecSession, ProviderSecrets } from "./types";
import { readEnvOrSetting, getConfig } from "../config";

function val(secrets: ProviderSecrets | undefined, key: string): string | undefined {
  return secrets?.[key] ?? readEnvOrSetting(key);
}

function getRegion(secrets?: ProviderSecrets): string {
  return val(secrets, "AWS_REGION") ?? "us-east-1";
}

function getEndpoint(secrets?: ProviderSecrets): string {
  return (
    val(secrets, "LAMBDA_MICROVM_ENDPOINT") ?? `https://lambda.${getRegion(secrets)}.amazonaws.com`
  ).replace(/\/+$/, "");
}

function getPrefix(secrets?: ProviderSecrets): string {
  return (val(secrets, "LAMBDA_MICROVM_PREFIX") ?? "/2026-06-30").replace(/\/+$/, "");
}

function getServiceName(secrets?: ProviderSecrets): string {
  return val(secrets, "LAMBDA_MICROVM_SERVICE") ?? "lambda";
}

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function getCreds(secrets?: ProviderSecrets): Creds {
  const accessKeyId = val(secrets, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = val(secrets, "AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY required — add to vault, .env, or gateway settings");
  }
  return { accessKeyId, secretAccessKey, sessionToken: val(secrets, "AWS_SESSION_TOKEN") };
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Produce SigV4 Authorization + x-amz-* headers for a request. */
function signRequest(opts: {
  method: string;
  url: string;
  body: string;
  region: string;
  service: string;
  creds: Creds;
}): Record<string, string> {
  const { method, url, body, region, service, creds } = opts;
  const u = new URL(url);
  const { amzDate, dateStamp } = amzDates();
  const payloadHash = sha256Hex(body);

  const host = u.host;
  const canonicalHeadersObj: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (creds.sessionToken) canonicalHeadersObj["x-amz-security-token"] = creds.sessionToken;

  const sortedHeaderKeys = Object.keys(canonicalHeadersObj).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${canonicalHeadersObj[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  // Canonical query string: sorted, RFC-3986 encoded.
  const queryPairs: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => queryPairs.push([k, v]));
  queryPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const canonicalQuery = queryPairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    u.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    Authorization: authorization,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "Content-Type": "application/json",
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
  return headers;
}

async function controlPlane<T>(
  method: string,
  path: string,
  opts: { body?: unknown; secrets?: ProviderSecrets; timeoutMs?: number },
): Promise<T> {
  const secrets = opts.secrets;
  const url = `${getEndpoint(secrets)}${getPrefix(secrets)}${path}`;
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const headers = signRequest({
    method,
    url,
    body,
    region: getRegion(secrets),
    service: getServiceName(secrets),
    creds: getCreds(secrets),
  });
  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Lambda MicroVM ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------------------
// Name → microVM mapping (Lambda assigns its own ids; endpoint + token are
// returned at run time and needed for every data-plane call).
// ---------------------------------------------------------------------------

interface MicroVm {
  id: string;
  endpoint: string;
  authToken?: string;
}

type GlobalWithLambda = typeof globalThis & { __caLambdaMicroVms?: Map<string, MicroVm> };
const g = globalThis as GlobalWithLambda;
if (!g.__caLambdaMicroVms) g.__caLambdaMicroVms = new Map();
const microVms = g.__caLambdaMicroVms;

function dataPlaneHeaders(vm: MicroVm): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(vm.authToken ? { Authorization: `Bearer ${vm.authToken}` } : {}),
  };
}

async function resolveVm(name: string, secrets?: ProviderSecrets): Promise<MicroVm> {
  const cached = microVms.get(name);
  if (cached) return cached;
  // Re-discover by name from the control plane after a restart.
  const data = await controlPlane<{ microVms?: Array<{ microVmId?: string; name?: string; endpoint?: string; authToken?: string }> }>(
    "GET",
    "/microvms",
    { secrets },
  ).catch(() => ({ microVms: [] as Array<{ microVmId?: string; name?: string; endpoint?: string; authToken?: string }> }));
  for (const m of data.microVms ?? []) {
    if (m.microVmId && m.endpoint) {
      const vm: MicroVm = { id: m.microVmId, endpoint: m.endpoint.replace(/\/+$/, ""), authToken: m.authToken };
      if (m.name) microVms.set(m.name, vm);
    }
  }
  const found = microVms.get(name);
  if (!found) throw new Error(`Lambda MicroVM not found for name: ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const lambdaMicroVmProvider: ContainerProvider = {
  name: "lambda-microvm",
  stripControlChars: false,
  supportsWarmPool: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    if (!val(secrets, "AWS_ACCESS_KEY_ID") || !val(secrets, "AWS_SECRET_ACCESS_KEY")) {
      return { available: false, message: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY required — add to vault or .env" };
    }
    if (!val(secrets, "LAMBDA_MICROVM_SNAPSHOT")) {
      return { available: false, message: "LAMBDA_MICROVM_SNAPSHOT required (snapshot to launch from) — add to vault or .env" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const snapshot = val(secrets, "LAMBDA_MICROVM_SNAPSHOT");
    if (!snapshot) throw new Error("LAMBDA_MICROVM_SNAPSHOT required — add to vault, .env, or gateway settings");
    const vcpus = Number.parseInt(val(secrets, "LAMBDA_MICROVM_VCPUS") ?? "2", 10);
    const memoryMiB = Number.parseInt(val(secrets, "LAMBDA_MICROVM_MEMORY_MIB") ?? "4096", 10);

    const data = await controlPlane<{ microVmId?: string; endpoint?: string; authToken?: string }>(
      "POST",
      "/microvms",
      {
        body: { name, snapshotId: snapshot, vcpus, memoryMiB },
        secrets,
        timeoutMs: 120_000,
      },
    );
    if (!data.microVmId || !data.endpoint) {
      throw new Error("Lambda MicroVM RunMicroVM response missing microVmId/endpoint");
    }
    microVms.set(name, {
      id: data.microVmId,
      endpoint: data.endpoint.replace(/\/+$/, ""),
      authToken: data.authToken,
    });
  },

  async delete(name, secrets?) {
    const vm = microVms.get(name);
    if (!vm) return;
    try {
      await controlPlane("DELETE", `/microvms/${encodeURIComponent(vm.id)}`, { secrets });
    } catch {
      // Best-effort — microVM may already be terminated
    }
    microVms.delete(name);
  },

  async list(opts) {
    const prefix = opts?.prefix ?? "ca-sess-";
    try {
      const data = await controlPlane<{ microVms?: Array<{ microVmId?: string; name?: string; endpoint?: string; authToken?: string }> }>(
        "GET",
        "/microvms",
        {},
      );
      const out: Array<{ name: string }> = [];
      for (const m of data.microVms ?? []) {
        if (!m.name) continue;
        if (m.microVmId && m.endpoint) {
          microVms.set(m.name, { id: m.microVmId, endpoint: m.endpoint.replace(/\/+$/, ""), authToken: m.authToken });
        }
        if (m.name.startsWith(prefix)) out.push({ name: m.name });
      }
      return out;
    } catch {
      return [];
    }
  },

  async exec(name, argv, opts) {
    const vm = await resolveVm(name, opts?.secrets);
    const res = await fetch(`${vm.endpoint}/exec`, {
      method: "POST",
      headers: dataPlaneHeaders(vm),
      body: JSON.stringify({ argv, stdin: opts?.stdin, timeoutMs: opts?.timeoutMs }),
      signal: AbortSignal.timeout((opts?.timeoutMs ?? 120_000) + 5_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Lambda MicroVM exec failed (${res.status}): ${text.slice(0, 400)}`);
    }
    const result = (await res.json()) as { stdout?: string; stderr?: string; exit_code?: number };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exit_code: result.exit_code ?? 0,
    };
  },

  async startExec(name, opts: ExecOptions): Promise<ExecSession> {
    const vm = await resolveVm(name, opts.secrets);

    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort());
    }
    const timeoutMs = opts.timeoutMs ?? getConfig().agentTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs + 10_000);

    let res: Response;
    try {
      res = await fetch(`${vm.endpoint}/exec/stream`, {
        method: "POST",
        headers: dataPlaneHeaders(vm),
        body: JSON.stringify({ argv: opts.argv, stdin: opts.stdin, timeoutMs }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new Error(`Lambda MicroVM stream exec failed (${res.status}): ${text.slice(0, 400)}`);
    }

    // The agent streams raw stdout and sends the exit code as a trailing
    // header (`x-exit-code`) once the process finishes.
    const [stream, monitor] = res.body.tee();
    let exitResolve!: (v: { code: number }) => void;
    const exit = new Promise<{ code: number }>((resolve) => {
      exitResolve = resolve;
    });
    (async () => {
      const reader = monitor.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* stream error */
      } finally {
        clearTimeout(timer);
      }
      const code = Number.parseInt(res.headers.get("x-exit-code") ?? "0", 10);
      exitResolve({ code: Number.isFinite(code) ? code : 0 });
    })();

    return {
      stdout: stream,
      exit,
      async kill() {
        controller.abort();
      },
    };
  },

  // ---- Extra lifecycle hooks (not part of ContainerProvider, but exposed
  // because suspend/resume is the headline feature of Lambda MicroVMs) ----

  /** Suspend an idle microVM (SuspendMicroVM). */
  async suspend(name: string, secrets?: ProviderSecrets): Promise<void> {
    const vm = microVms.get(name);
    if (!vm) return;
    await controlPlane("POST", `/microvms/${encodeURIComponent(vm.id)}/suspend`, { secrets });
  },

  /** Resume a suspended microVM (ResumeMicroVM). */
  async resume(name: string, secrets?: ProviderSecrets): Promise<void> {
    const vm = microVms.get(name);
    if (!vm) return;
    await controlPlane("POST", `/microvms/${encodeURIComponent(vm.id)}/resume`, { secrets });
  },
} as ContainerProvider & {
  suspend(name: string, secrets?: ProviderSecrets): Promise<void>;
  resume(name: string, secrets?: ProviderSecrets): Promise<void>;
};
