/**
 * Cloud Run executor provider.
 *
 * Connects to a Go executor deployed on GCP Cloud Run. The executor
 * is always running — no container lifecycle management needed.
 *
 * Endpoints:
 *   GET  /ping         — health check (expects X-Executor-API: 1 header)
 *   POST /exec         — one-shot exec: { argv, stdin, timeout_ms } → { stdout, stderr, exit_code }
 *   POST /exec/stream  — SSE streaming: same request body, returns event: stdout (base64) + event: exit
 *   POST /fs/put       — file write: { path, content, content_encoding?, mode? } → { path, size, ok }
 *
 * Env vars: CLOUD_RUN_EXECUTOR_URL (required), CLOUD_RUN_EXECUTOR_TOKEN (required for auth)
 */
import type { ContainerProvider, ExecOptions, ExecSession, ProviderSecrets } from "./types";

function getExecutorUrl(secrets?: ProviderSecrets): string | undefined {
  return (secrets?.CLOUD_RUN_EXECUTOR_URL ?? process.env.CLOUD_RUN_EXECUTOR_URL)?.replace(/\/+$/, "");
}

function getExecutorToken(secrets?: ProviderSecrets): string {
  const token = secrets?.CLOUD_RUN_EXECUTOR_TOKEN ?? process.env.CLOUD_RUN_EXECUTOR_TOKEN;
  if (!token) throw new Error("CLOUD_RUN_EXECUTOR_TOKEN required — add to vault or .env");
  return token;
}

function headers(secrets?: ProviderSecrets): Record<string, string> {
  return {
    Authorization: `Bearer ${getExecutorToken(secrets)}`,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const cloudRunProvider: ContainerProvider = {
  name: "cloud-run",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    const url = getExecutorUrl(secrets);
    if (!url) {
      return { available: false, message: "CLOUD_RUN_EXECUTOR_URL not configured" };
    }

    try {
      const res = await fetch(`${url}/ping`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return { available: false, message: `Cloud Run executor ping failed (${res.status})` };
      }
      const apiHeader = res.headers.get("X-Executor-API");
      if (apiHeader !== "1") {
        return { available: false, message: "Cloud Run executor missing X-Executor-API: 1 header" };
      }
      return { available: true };
    } catch (err) {
      return {
        available: false,
        message: `Cloud Run executor unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  // Cloud Run manages instances — create/delete are no-ops.
  async create() {},
  async delete() {},

  async list() {
    return [{ name: "cloud-run-session" }];
  },

  async exec(_name, argv, opts) {
    const secrets = opts?.secrets;
    const url = getExecutorUrl(secrets);
    if (!url) throw new Error("CLOUD_RUN_EXECUTOR_URL not configured");

    const res = await fetch(`${url}/exec`, {
      method: "POST",
      headers: headers(secrets),
      body: JSON.stringify({
        argv,
        stdin: opts?.stdin ?? "",
        timeout_ms: opts?.timeoutMs ?? 300_000,
      }),
      signal: opts?.timeoutMs
        ? AbortSignal.timeout(opts.timeoutMs + 10_000)
        : AbortSignal.timeout(310_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Cloud Run exec failed (${res.status}): ${text}`);
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

  async startExec(_name, opts) {
    const secrets = opts.secrets;
    const url = getExecutorUrl(secrets);
    if (!url) throw new Error("CLOUD_RUN_EXECUTOR_URL not configured");

    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener("abort", () => controller.abort());
      }
    }
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs + 10_000);

    let res: Response;
    try {
      res = await fetch(`${url}/exec/stream`, {
        method: "POST",
        headers: headers(secrets),
        body: JSON.stringify({
          argv: opts.argv,
          stdin: opts.stdin ?? "",
          timeout_ms: timeoutMs,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new Error(`Cloud Run exec/stream failed (${res.status}): ${text}`);
    }

    // Parse SSE stream from the executor.
    // Events:
    //   event: stdout\ndata: <base64>\n\n   — one line of stdout (base64-encoded, without trailing \n)
    //   event: exit\ndata: {"exit_code":0}\n\n — process exited
    const body = res.body;
    if (!body) {
      clearTimeout(timer);
      throw new Error("Cloud Run exec/stream returned no body");
    }

    let exitResolve: (result: { code: number }) => void;
    let exitReject: (err: Error) => void;
    const exitPromise = new Promise<{ code: number }>((resolve, reject) => {
      exitResolve = resolve;
      exitReject = reject;
    });

    const encoder = new TextEncoder();

    const stdout = new ReadableStream<Uint8Array>({
      start(streamController) {
        // Read the SSE stream line-by-line
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";

        function processLine(line: string): void {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (currentEvent === "stdout") {
              // Decode base64 line and re-add trailing newline
              try {
                const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
                streamController.enqueue(bytes);
                streamController.enqueue(encoder.encode("\n"));
              } catch {
                // If base64 decode fails, push raw data
                streamController.enqueue(encoder.encode(data + "\n"));
              }
            } else if (currentEvent === "exit") {
              try {
                const parsed = JSON.parse(data) as { exit_code?: number };
                exitResolve!({ code: parsed.exit_code ?? 0 });
              } catch {
                exitResolve!({ code: 1 });
              }
            }
            currentEvent = "";
          }
          // Empty line or other lines are ignored (SSE separators)
        }

        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              // Keep the last incomplete line in the buffer
              buffer = lines.pop()!;
              for (const line of lines) {
                processLine(line);
              }
            }
            // Process any remaining data in buffer
            if (buffer.trim()) {
              processLine(buffer);
            }
            streamController.close();
          } catch (err) {
            streamController.error(err);
            exitReject!(err instanceof Error ? err : new Error(String(err)));
          } finally {
            clearTimeout(timer);
          }
        })();
      },
    });

    return {
      stdout,
      exit: exitPromise,
      async kill() {
        controller.abort();
        clearTimeout(timer);
      },
    };
  },
};
