/**
 * HttpTransport — executes ApiCalls against a remote gateway over fetch.
 * Streaming reconnects with exponential backoff, resuming from the last
 * seen seq so no events are dropped across connection failures.
 */
import type { ApiCall, StreamCall, Transport } from "./types";
import type { GatewayEvent } from "../events/registry";
import { parseJsonResponse, parseSseResponse, toApiError } from "./wire";

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout for non-streaming calls (default 30s). */
  timeoutMs?: number;
}

const MAX_STREAM_RETRIES = 10;
const MAX_BACKOFF_MS = 30_000;

export class HttpTransport implements Transport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async call<T>(c: ApiCall): Promise<T> {
    const headers: Record<string, string> = { "x-api-key": this.apiKey };
    const init: RequestInit = {
      method: c.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (c.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(c.body);
    }
    const res = await fetch(`${this.baseUrl}${c.path}`, init);
    return parseJsonResponse<T>(res);
  }

  async *stream(c: StreamCall): AsyncGenerator<GatewayEvent, void, unknown> {
    let lastSeq = c.lastEventId != null ? Number(c.lastEventId) : undefined;
    let backoff = 1000;
    let retries = 0;

    while (retries <= MAX_STREAM_RETRIES) {
      try {
        let gotEvents = false;
        for await (const evt of this.streamOnce(c, lastSeq)) {
          gotEvents = true;
          retries = 0;
          backoff = 1000;
          if (typeof evt.seq === "number") lastSeq = evt.seq;
          yield evt;
        }
        // Stream ended cleanly (server closed the connection).
        if (!gotEvents) return; // empty stream — nothing to reconnect for
      } catch {
        // connection error — retry below
      }

      retries++;
      if (retries > MAX_STREAM_RETRIES) return;
      console.error(`[client] stream disconnected — reconnecting in ${backoff / 1000}s...`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  private async *streamOnce(c: StreamCall, afterSeq?: number): AsyncGenerator<GatewayEvent, void, unknown> {
    // Rewrite after_seq in the path so reconnects resume from the last seq.
    const u = new URL(c.path, "http://placeholder");
    if (afterSeq != null) u.searchParams.set("after_seq", String(afterSeq));
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      Accept: "text/event-stream",
    };
    if (afterSeq != null) headers["Last-Event-ID"] = String(afterSeq);

    const res = await fetch(`${this.baseUrl}${u.pathname}${u.search}`, { headers });
    if (!res.ok || !res.body) throw await toApiError(res);
    yield* parseSseResponse(res);
  }
}
