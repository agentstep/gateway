/**
 * Composable client middleware — every non-streaming API call flows
 * through the middleware chain before reaching the transport:
 *
 *   const client = createClient({
 *     middleware: [withRetry({ maxRetries: 3 }), withLogging()],
 *   });
 *
 * A middleware receives the call descriptor and a `next` continuation; it
 * can short-circuit, mutate the call, retry, or observe. Streaming calls
 * bypass the chain (the HTTP transport already owns stream reconnect).
 */
import type { ApiCall, StreamCall, Transport } from "./types";
import { ApiClientError } from "./types";
import type { ManagedEvent } from "../types";

export type ClientMiddleware = (
  call: ApiCall,
  next: (call: ApiCall) => Promise<unknown>,
) => Promise<unknown>;

/** Wrap a transport so `call()` runs through the middleware chain. */
export function applyMiddleware(transport: Transport, middleware: ClientMiddleware[]): Transport {
  if (middleware.length === 0) return transport;

  const terminal = (call: ApiCall): Promise<unknown> => transport.call(call);
  const chain = middleware.reduceRight<(call: ApiCall) => Promise<unknown>>(
    (next, mw) => (call) => mw(call, next),
    terminal,
  );

  return {
    call: <T>(c: ApiCall) => chain(c) as Promise<T>,
    stream: (c: StreamCall): AsyncGenerator<ManagedEvent, void, unknown> => transport.stream(c),
  };
}

export interface RetryOptions {
  /** Retry attempts after the initial call (default 3). */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt (default 500ms). */
  baseDelayMs?: number;
  /** Decide retryability. Default: 429/5xx ApiClientErrors and network errors. */
  retryOn?: (err: unknown) => boolean;
}

function defaultRetryOn(err: unknown): boolean {
  if (err instanceof ApiClientError) {
    return err.status === 429 || err.status >= 500;
  }
  // Non-API errors (network failures, timeouts) are worth retrying.
  return err instanceof Error && !(err instanceof ApiClientError);
}

/** Retry failed calls with exponential backoff. Mutating calls are safe to
 * retry only when the server treats them idempotently — scope with
 * `retryOn` if that's a concern. */
export function withRetry(opts: RetryOptions = {}): ClientMiddleware {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const retryOn = opts.retryOn ?? defaultRetryOn;

  return async (call, next) => {
    let attempt = 0;
    for (;;) {
      try {
        return await next(call);
      } catch (err) {
        if (attempt >= maxRetries || !retryOn(err)) throw err;
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
        attempt++;
      }
    }
  };
}

export interface LoggingOptions {
  /** Sink for log lines (default `console.error`). */
  log?: (line: string) => void;
}

/** Log every call's method, path, duration, and outcome. */
export function withLogging(opts: LoggingOptions = {}): ClientMiddleware {
  const log = opts.log ?? ((line: string) => console.error(line));

  return async (call, next) => {
    const started = Date.now();
    try {
      const result = await next(call);
      log(`[agentstep] ${call.method} ${call.path} ok (${Date.now() - started}ms)`);
      return result;
    } catch (err) {
      const status = err instanceof ApiClientError ? ` ${err.status}` : "";
      log(`[agentstep] ${call.method} ${call.path} failed${status} (${Date.now() - started}ms)`);
      throw err;
    }
  };
}
