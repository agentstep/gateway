/**
 * Programmatic client types — the transport seam.
 *
 * A `Transport` executes one described API call. Two implementations:
 * - `LocalTransport` dispatches to handler functions in-process (same code
 *   path as the HTTP adapters — handlers are looked up by export name).
 * - `HttpTransport` sends the same call to a remote gateway over fetch.
 *
 * Every resource method in `GatewayClient` builds a single `ApiCall`
 * descriptor that works on both transports, so the resource surface is
 * defined exactly once.
 */
import type { ManagedEvent } from "../types";

/** Standard list envelope returned by paginated endpoints. */
export interface Page<T> {
  data: T[];
  next_page: string | null;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ApiCall {
  /**
   * Export name in `handlers/index` (e.g. "handleCreateAgent"). The local
   * transport dispatches on this; the HTTP transport ignores it.
   */
  handler: string;
  method: HttpMethod;
  /** URL path including query string, e.g. `/v1/agents?limit=10`. */
  path: string;
  /** Positional path params the handler expects after the Request. */
  ids?: string[];
  body?: unknown;
}

export interface StreamCall extends ApiCall {
  /** Resume marker — sent as the `Last-Event-ID` header. */
  lastEventId?: string;
}

export interface Transport {
  call<T>(c: ApiCall): Promise<T>;
  stream(c: StreamCall): AsyncGenerator<ManagedEvent, void, unknown>;
}

/**
 * Error thrown by both transports on a non-2xx response. `message` is the
 * server's error message; `errorType` is the error envelope's `type` field.
 */
export class GatewayApiError extends Error {
  readonly status: number;
  readonly errorType: string;

  constructor(message: string, status: number, errorType = "api_error") {
    super(message);
    this.name = "GatewayApiError";
    this.status = status;
    this.errorType = errorType;
  }
}
