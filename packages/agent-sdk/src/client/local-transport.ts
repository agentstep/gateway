/**
 * LocalTransport — executes ApiCalls by invoking handler functions
 * in-process, the same code path the Hono/Next.js adapters use over HTTP.
 * Handlers are looked up by export name from `handlers/index` (lazily, so
 * importing the client doesn't pull the whole handler tree until first use).
 *
 * Auth uses a real API key so the audit log and key scoping behave exactly
 * as they do over HTTP. Resolution order: explicit option → SEED_API_KEY
 * env var → `.env` in cwd → mint a fresh key and persist it to `.env`
 * (mirrors what the CLI has always done).
 */
import type { ApiCall, StreamCall, Transport } from "./types";
import type { GatewayEvent } from "../events/registry";
import { parseJsonResponse, parseSseResponse, toApiError } from "./wire";

type HandlerFn = (req: Request, ...ids: string[]) => Promise<Response>;

export interface LocalTransportOptions {
  /** API key to authenticate in-process calls. Resolved automatically if omitted. */
  apiKey?: string;
}

export class LocalTransport implements Transport {
  private apiKey: string;

  constructor(opts: LocalTransportOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
  }

  async call<T>(c: ApiCall): Promise<T> {
    const res = await this.dispatch(c, { "Content-Type": "application/json" });
    return parseJsonResponse<T>(res);
  }

  async *stream(c: StreamCall): AsyncGenerator<GatewayEvent, void, unknown> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (c.lastEventId != null) headers["Last-Event-ID"] = c.lastEventId;
    const res = await this.dispatch(c, headers);
    if (!res.ok) throw await toApiError(res);
    yield* parseSseResponse(res);
  }

  private async dispatch(c: ApiCall, headers: Record<string, string>): Promise<Response> {
    const handler = await this.handlerByName(c.handler);
    const apiKey = await this.resolveApiKey();
    const init: RequestInit = {
      method: c.method,
      headers: { ...headers, "x-api-key": apiKey },
    };
    if (c.body !== undefined) init.body = JSON.stringify(c.body);
    const req = new Request(`http://localhost${c.path}`, init);
    return handler(req, ...(c.ids ?? []));
  }

  private async handlerByName(name: string): Promise<HandlerFn> {
    const handlers = (await import("../handlers/index")) as unknown as Record<string, unknown>;
    const fn = handlers[name];
    if (typeof fn !== "function") {
      throw new Error(`LocalTransport: unknown handler "${name}"`);
    }
    return fn as HandlerFn;
  }

  private async resolveApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;

    // Prefer the env var that ensureInitialized() seeds on first boot.
    if (process.env.SEED_API_KEY) {
      this.apiKey = process.env.SEED_API_KEY;
      return this.apiKey;
    }

    // Re-read .env to pick up a key written earlier in this process's life.
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const envPath = path.resolve(process.cwd(), ".env");
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        const match = /^SEED_API_KEY=(.+)$/m.exec(content);
        if (match) {
          this.apiKey = match[1].trim();
          return this.apiKey;
        }
      }
    } catch {
      // best-effort
    }

    // Last resort: the DB has keys but raw values aren't recoverable.
    // Mint a new key for local use and persist it to .env.
    try {
      const { createApiKey } = await import("../db/api_keys");
      const { key } = createApiKey({ name: "cli", permissions: ["*"] });
      const fs = await import("node:fs");
      const path = await import("node:path");
      const envPath = path.resolve(process.cwd(), ".env");
      if (!fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, `SEED_API_KEY=${key}\n`, "utf-8");
      } else {
        fs.appendFileSync(envPath, `\nSEED_API_KEY=${key}\n`, "utf-8");
      }
      process.env.SEED_API_KEY = key;
      this.apiKey = key;
      return this.apiKey;
    } catch (err) {
      console.error("[client] local API key creation failed:", err);
    }

    throw new Error(
      "No API key available for the local client. Pass { apiKey } to createClient(), set SEED_API_KEY, or let the server generate one on first run.",
    );
  }
}
