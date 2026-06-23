/**
 * Google GKE Agent Sandbox provider.
 *
 * Targets the open-source Agent Sandbox runtime
 * (github.com/kubernetes-sigs/agent-sandbox), GA on GKE as of 2026. A
 * sandbox is a Kubernetes custom resource (`Sandbox`, group
 * `agents.x-k8s.io/v1beta1`) whose controller materialises a Pod with a
 * stable identity, gVisor/Kata kernel isolation, default-deny networking
 * and snapshot-backed suspend/resume.
 *
 * Lifecycle maps cleanly onto the Kubernetes API — no extra SDK needed,
 * just the stable REST surface every cluster exposes:
 *   create → POST   /apis/agents.x-k8s.io/v1beta1/namespaces/{ns}/sandboxes
 *   delete → DELETE /apis/agents.x-k8s.io/v1beta1/namespaces/{ns}/sandboxes/{name}
 *   list   → GET    /apis/agents.x-k8s.io/v1beta1/namespaces/{ns}/sandboxes
 *   exec   → WebSocket /api/v1/namespaces/{ns}/pods/{name}/exec  (channel proto)
 *
 * The Sandbox controller names the backing Pod after the Sandbox, so the
 * sandbox name doubles as the Pod name for exec.
 *
 * Exec uses the Kubernetes streaming "channel" subprotocol
 * (`v5.channel.k8s.io`, falling back to `v4`). v5 adds a CLOSE channel so
 * we can half-close stdin and signal EOF — the turn driver frames stdin
 * and the agent CLI reads until EOF, so this matters.
 *
 * Auth: a bearer token (e.g. `gcloud auth print-access-token`, or a
 * ServiceAccount token) passed as `GKE_TOKEN`. The token is sent as an
 * Authorization header for REST and as the
 * `base64url.bearer.authorization.k8s.io.<token>` WebSocket subprotocol
 * for exec (custom WS headers aren't portable).
 *
 * TLS: GKE control-plane certs chain to the cluster CA. Provide it via
 * `GKE_CA_DATA` (base64 PEM, as it appears in a kubeconfig) or trust it
 * process-wide with NODE_EXTRA_CA_CERTS. `GKE_INSECURE_SKIP_TLS_VERIFY=1`
 * disables verification for local development only.
 *
 * Env / vault secrets:
 *   GKE_API_SERVER              required — https://<control-plane-endpoint>
 *   GKE_TOKEN                   required — bearer token
 *   GKE_SANDBOX_NAMESPACE       default "default"
 *   GKE_SANDBOX_IMAGE           default "node:22"
 *   GKE_SANDBOX_CONTAINER       default "sandbox"
 *   GKE_SANDBOX_SERVICE_ACCOUNT optional — pod serviceAccountName
 *   GKE_CA_DATA                 optional — base64 PEM cluster CA
 *   GKE_INSECURE_SKIP_TLS_VERIFY optional — "1"/"true" to skip TLS verify
 */
import type { ContainerProvider, ExecOptions, ExecSession, ProviderSecrets } from "./types";
import { readEnvOrSetting } from "../config";

const GROUP = "agents.x-k8s.io";
const VERSION = "v1beta1";
const PLURAL = "sandboxes";

function val(secrets: ProviderSecrets | undefined, key: string): string | undefined {
  return secrets?.[key] ?? readEnvOrSetting(key);
}

function getServer(secrets?: ProviderSecrets): string {
  const server = val(secrets, "GKE_API_SERVER");
  if (!server) throw new Error("GKE_API_SERVER required — add to vault, .env, or gateway settings");
  return server.replace(/\/+$/, "");
}

function getToken(secrets?: ProviderSecrets): string {
  const token = val(secrets, "GKE_TOKEN");
  if (!token) throw new Error("GKE_TOKEN required — add to vault, .env, or gateway settings");
  return token;
}

function getNamespace(secrets?: ProviderSecrets): string {
  return val(secrets, "GKE_SANDBOX_NAMESPACE") ?? "default";
}

function getImage(secrets?: ProviderSecrets): string {
  return val(secrets, "GKE_SANDBOX_IMAGE") ?? "node:22";
}

function getContainer(secrets?: ProviderSecrets): string {
  return val(secrets, "GKE_SANDBOX_CONTAINER") ?? "sandbox";
}

function isInsecure(secrets?: ProviderSecrets): boolean {
  const v = val(secrets, "GKE_INSECURE_SKIP_TLS_VERIFY");
  return v === "1" || v === "true";
}

// ---------------------------------------------------------------------------
// TLS dispatcher (undici) — built lazily when a custom CA or insecure mode
// is requested. Falls back to the default global dispatcher (system CAs +
// NODE_EXTRA_CA_CERTS) when undici can't be loaded.
// ---------------------------------------------------------------------------

type GlobalWithGke = typeof globalThis & { __caGkeDispatcher?: unknown | null };
const g = globalThis as GlobalWithGke;

async function getDispatcher(secrets?: ProviderSecrets): Promise<unknown | undefined> {
  const caData = val(secrets, "GKE_CA_DATA");
  const insecure = isInsecure(secrets);
  if (!caData && !insecure) return undefined;
  if (g.__caGkeDispatcher !== undefined) return g.__caGkeDispatcher ?? undefined;

  try {
    const undici: any = await import("undici");
    const connect: Record<string, unknown> = {};
    if (caData) connect.ca = Buffer.from(caData, "base64").toString("utf8");
    if (insecure) connect.rejectUnauthorized = false;
    g.__caGkeDispatcher = new undici.Agent({ connect });
  } catch {
    // undici not importable as a module (only as global fetch) — proceed
    // with the default dispatcher and rely on system / NODE_EXTRA_CA_CERTS.
    g.__caGkeDispatcher = null;
  }
  return g.__caGkeDispatcher ?? undefined;
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function k8sFetch(
  path: string,
  opts: { method?: string; body?: unknown; secrets?: ProviderSecrets; timeoutMs?: number },
): Promise<Response> {
  const server = getServer(opts.secrets);
  const dispatcher = await getDispatcher(opts.secrets);
  return fetch(`${server}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${getToken(opts.secrets)}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    // undici-specific option; ignored by other fetch impls.
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
}

function sandboxPath(ns: string, name?: string): string {
  const base = `/apis/${GROUP}/${VERSION}/namespaces/${ns}/${PLURAL}`;
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}

function podPath(ns: string, name: string): string {
  return `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// WebSocket exec (Kubernetes channel subprotocol)
// ---------------------------------------------------------------------------

const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const ERROR = 3; // carries a terminal V1Status (incl. exit code)
const CLOSE = 255; // v5 only — half-close a stream

interface ExecHandles {
  stdout: ReadableStream<Uint8Array>;
  /** stderr text, resolved when the socket closes (for buffered exec) */
  stderr: Promise<string>;
  exit: Promise<{ code: number }>;
  kill(): Promise<void>;
}

function parseExitCode(statusJson: string): number {
  if (!statusJson.trim()) return 0;
  try {
    const status = JSON.parse(statusJson) as {
      status?: string;
      details?: { causes?: Array<{ reason?: string; message?: string }> };
    };
    if (status.status === "Success") return 0;
    const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
    if (cause?.message) {
      const n = Number.parseInt(cause.message, 10);
      if (Number.isFinite(n)) return n;
    }
    return 1;
  } catch {
    return 0;
  }
}

async function openExec(
  name: string,
  argv: string[],
  opts: { stdin?: string; secrets?: ProviderSecrets; signal?: AbortSignal },
): Promise<ExecHandles> {
  const server = getServer(opts.secrets);
  const ns = getNamespace(opts.secrets);
  const wsBase = server.replace(/^http/, "ws");

  const params = new URLSearchParams();
  params.set("container", getContainer(opts.secrets));
  params.set("stdout", "true");
  params.set("stderr", "true");
  if (opts.stdin) params.set("stdin", "true");
  for (const a of argv) params.append("command", a);

  const url = `${wsBase}${podPath(ns, name)}/exec?${params.toString()}`;

  // Bearer token as a WebSocket subprotocol (no custom-header support in WS).
  const tokenProto = `base64url.bearer.authorization.k8s.io.${Buffer.from(
    getToken(opts.secrets),
  ).toString("base64url")}`;
  const protocols = ["v5.channel.k8s.io", "v4.channel.k8s.io", tokenProto];

  const dispatcher = await getDispatcher(opts.secrets);
  const ws = new WebSocket(url, dispatcher ? ({ protocols, dispatcher } as any) : protocols);
  ws.binaryType = "arraybuffer";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stderrText = "";
  let statusText = "";
  let streamController: ReadableStreamDefaultController<Uint8Array>;

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });

  let exitResolve!: (v: { code: number }) => void;
  let exitReject!: (e: unknown) => void;
  const exit = new Promise<{ code: number }>((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });
  let stderrResolve!: (s: string) => void;
  const stderr = new Promise<string>((resolve) => {
    stderrResolve = resolve;
  });

  ws.onopen = () => {
    if (opts.stdin) {
      const data = encoder.encode(opts.stdin);
      const frame = new Uint8Array(data.length + 1);
      frame[0] = STDIN;
      frame.set(data, 1);
      ws.send(frame);
      // v5 half-close of stdin so the process sees EOF.
      if (ws.protocol === "v5.channel.k8s.io") {
        ws.send(new Uint8Array([CLOSE, STDIN]));
      }
    }
  };

  ws.onmessage = (ev: MessageEvent) => {
    const buf = new Uint8Array(ev.data as ArrayBuffer);
    if (buf.length === 0) return;
    const channel = buf[0];
    const payload = buf.subarray(1);
    if (channel === STDOUT) {
      try {
        streamController.enqueue(payload.slice());
      } catch {
        /* stream closed */
      }
    } else if (channel === STDERR) {
      stderrText += decoder.decode(payload);
    } else if (channel === ERROR) {
      statusText += decoder.decode(payload);
    }
  };

  const finish = () => {
    try {
      streamController.close();
    } catch {
      /* already closed */
    }
    stderrResolve(stderrText);
    exitResolve({ code: parseExitCode(statusText) });
  };

  ws.onclose = finish;
  ws.onerror = () => {
    // The browser/undici WS error event carries no detail; the close
    // handler still resolves exit. Only reject if we never opened.
    if (ws.readyState === WebSocket.CONNECTING) {
      try {
        streamController.error(new Error("GKE exec WebSocket failed to connect"));
      } catch {
        /* ignore */
      }
      exitReject(new Error("GKE exec WebSocket failed to connect"));
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) ws.close();
    else opts.signal.addEventListener("abort", () => ws.close());
  }

  return {
    stdout,
    stderr,
    exit,
    async kill() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pod readiness
// ---------------------------------------------------------------------------

async function waitForPodReady(name: string, secrets: ProviderSecrets | undefined, deadlineMs: number): Promise<void> {
  const ns = getNamespace(secrets);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const res = await k8sFetch(podPath(ns, name), { secrets }).catch(() => null);
    if (res?.ok) {
      const pod = (await res.json()) as {
        status?: { phase?: string; conditions?: Array<{ type?: string; status?: string }> };
      };
      const phase = pod.status?.phase;
      if (phase === "Running") {
        const ready = pod.status?.conditions?.find((c) => c.type === "Ready");
        if (ready?.status === "True") return;
      }
      if (phase === "Failed" || phase === "Succeeded") {
        throw new Error(`GKE sandbox pod entered terminal phase: ${phase}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`GKE sandbox pod "${name}" did not become ready within ${Math.round(deadlineMs / 1000)}s`);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const gkeAgentSandboxProvider: ContainerProvider = {
  name: "gke-agent-sandbox",
  stripControlChars: false,
  supportsWarmPool: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    if (!val(secrets, "GKE_API_SERVER")) {
      return { available: false, message: "GKE_API_SERVER required — add to vault, .env, or gateway settings" };
    }
    if (!val(secrets, "GKE_TOKEN")) {
      return { available: false, message: "GKE_TOKEN required (e.g. `gcloud auth print-access-token`) — add to vault or .env" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const ns = getNamespace(secrets);
    const serviceAccount = val(secrets, "GKE_SANDBOX_SERVICE_ACCOUNT");
    const manifest = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "Sandbox",
      metadata: { name, labels: { "app.kubernetes.io/managed-by": "agentstep-gateway" } },
      spec: {
        podTemplate: {
          spec: {
            ...(serviceAccount ? { serviceAccountName: serviceAccount } : {}),
            containers: [
              {
                name: getContainer(secrets),
                image: getImage(secrets),
                command: ["sleep", "infinity"],
              },
            ],
          },
        },
      },
    };

    const res = await k8sFetch(sandboxPath(ns), { method: "POST", body: manifest, secrets, timeoutMs: 120_000 });
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      throw new Error(`GKE sandbox create failed (${res.status}): ${body.slice(0, 400)}`);
    }

    await waitForPodReady(name, secrets, 180_000);
  },

  async delete(name, secrets?) {
    const ns = getNamespace(secrets);
    try {
      const res = await k8sFetch(sandboxPath(ns, name), { method: "DELETE", secrets });
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => "");
        console.warn(`GKE sandbox delete failed (${res.status}): ${body.slice(0, 200)}`);
      }
    } catch {
      // Best-effort — sandbox may already be gone
    }
  },

  async list(opts) {
    const ns = getNamespace();
    try {
      const res = await k8sFetch(sandboxPath(ns), {});
      if (!res.ok) return [];
      const data = (await res.json()) as { items?: Array<{ metadata?: { name?: string } }> };
      const prefix = opts?.prefix ?? "ca-sess-";
      return (data.items ?? [])
        .map((it) => it.metadata?.name)
        .filter((n): n is string => Boolean(n) && n!.startsWith(prefix))
        .map((name) => ({ name }));
    } catch {
      return [];
    }
  },

  async exec(name, argv, opts) {
    const handles = await openExec(name, argv, {
      stdin: opts?.stdin,
      secrets: opts?.secrets,
    });
    // Drain stdout to a string.
    const chunks: Uint8Array[] = [];
    const reader = handles.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const [{ code }, stderr] = await Promise.all([handles.exit, handles.stderr]);
    const stdout = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { stdout, stderr, exit_code: code };
  },

  async startExec(name, opts: ExecOptions): Promise<ExecSession> {
    const handles = await openExec(name, opts.argv, {
      stdin: opts.stdin,
      secrets: opts.secrets,
      signal: opts.signal,
    });
    return {
      stdout: handles.stdout,
      exit: handles.exit,
      kill: handles.kill,
    };
  },
};
