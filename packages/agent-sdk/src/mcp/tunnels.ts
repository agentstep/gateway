/**
 * MCP tunnels — outbound-only gateway for reaching private MCP servers.
 *
 * Status: DRAFT. This module defines the wire protocol and an
 * in-memory dispatcher. The WebSocket transport adapter that connects
 * tunnel clients to this dispatcher lives in the server packages
 * (gateway-hono / gateway-fastify) and is not part of this file.
 *
 * Threat model
 * ------------
 * The customer's MCP servers (databases, ticketing systems, internal APIs)
 * sit behind a firewall with no inbound holes. Instead, the customer runs
 * a lightweight client that makes a single outbound connection to the
 * gateway. All MCP traffic for that customer's `tunnel://<id>/...` servers
 * is multiplexed over that connection.
 *
 *   gateway  ──auth──>  tunnel client  ─local fetch─>  private MCP server
 *            <──RPC───                 <──response──
 *
 * Wire protocol (JSON over WebSocket, one message per frame)
 * ----------------------------------------------------------
 * Client → gateway (hello, sent immediately after connect):
 *   { "type": "hello", "tunnel_id": "...", "token": "..." }
 *
 * Gateway → client (request):
 *   { "type": "request", "id": "<correlation-id>",
 *     "path": "/sse",                 // path component from tunnel:// URL
 *     "method": "POST",
 *     "headers": { ... },
 *     "body": "<utf-8 string>" }
 *
 * Client → gateway (response):
 *   { "type": "response", "id": "<correlation-id>",
 *     "status": 200,
 *     "headers": { ... },
 *     "body": "<utf-8 string>" }
 *
 * Either side → other (ping/pong):
 *   { "type": "ping" } | { "type": "pong" }
 *
 * URL convention
 * --------------
 * An MCP server entry with `url: "tunnel://<tunnel-id>/<path>"` is routed
 * through the registered tunnel instead of being fetched directly. The
 * scheme/host parsing lives in `parseTunnelUrl`.
 */

export type TunnelHello = {
  type: "hello";
  tunnel_id: string;
  token: string;
};

export type TunnelRequest = {
  type: "request";
  id: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

export type TunnelResponse = {
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body?: string;
};

export type TunnelPing = { type: "ping" };
export type TunnelPong = { type: "pong" };

export type TunnelFrame = TunnelHello | TunnelRequest | TunnelResponse | TunnelPing | TunnelPong;

/**
 * Transport-agnostic connection interface. The server adapter wraps a
 * WebSocket (or any duplex JSON channel) in this shape, then hands it
 * to `registerTunnel`.
 */
export interface TunnelTransport {
  send(frame: TunnelFrame): void;
  close(code?: number, reason?: string): void;
  /** Called by the registry to push frames received on the wire. */
  onMessage(handler: (frame: TunnelFrame) => void): void;
  onClose(handler: () => void): void;
}

interface Pending {
  resolve(r: TunnelResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RegisteredTunnel {
  transport: TunnelTransport;
  pending: Map<string, Pending>;
  lastSeenAt: number;
}

// HMR-safe registry: tunnelId → live transport. A tunnel can only have
// one active connection at a time; a second connect kicks the first.
type GlobalWithTunnels = typeof globalThis & {
  __caMcpTunnels?: Map<string, RegisteredTunnel>;
};
const g = globalThis as GlobalWithTunnels;
if (!g.__caMcpTunnels) g.__caMcpTunnels = new Map();
const tunnels = g.__caMcpTunnels;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Register a freshly-authenticated tunnel transport. Replaces any
 * existing transport for the same id (the old one is closed).
 */
export function registerTunnel(tunnelId: string, transport: TunnelTransport): void {
  const existing = tunnels.get(tunnelId);
  if (existing) {
    for (const p of existing.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("tunnel replaced by new connection"));
    }
    try { existing.transport.close(1000, "replaced"); } catch { /* best-effort */ }
  }

  const entry: RegisteredTunnel = {
    transport,
    pending: new Map(),
    lastSeenAt: Date.now(),
  };
  tunnels.set(tunnelId, entry);

  transport.onMessage((frame) => {
    entry.lastSeenAt = Date.now();
    if (frame.type === "response") {
      const p = entry.pending.get(frame.id);
      if (p) {
        clearTimeout(p.timer);
        entry.pending.delete(frame.id);
        p.resolve(frame);
      }
      return;
    }
    if (frame.type === "ping") {
      try { transport.send({ type: "pong" }); } catch { /* best-effort */ }
    }
    // Hello frames are consumed by the auth adapter before reaching here;
    // duplicates and pongs are ignored.
  });

  transport.onClose(() => {
    // Only unregister if we're still the active entry — a concurrent
    // replacement may have already replaced us.
    if (tunnels.get(tunnelId) === entry) tunnels.delete(tunnelId);
    for (const p of entry.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("tunnel closed"));
    }
  });
}

export function isTunnelConnected(tunnelId: string): boolean {
  return tunnels.has(tunnelId);
}

export function closeTunnel(tunnelId: string, reason = "closed by gateway"): void {
  const entry = tunnels.get(tunnelId);
  if (!entry) return;
  try { entry.transport.close(1000, reason); } catch { /* best-effort */ }
  tunnels.delete(tunnelId);
}

let correlationCounter = 0;
function nextId(): string {
  correlationCounter = (correlationCounter + 1) >>> 0;
  return `${Date.now().toString(36)}-${correlationCounter.toString(36)}`;
}

/**
 * Dispatch a request through a tunnel and await the matching response.
 * Throws if the tunnel is not connected or the response times out.
 */
export async function dispatchTunneledRequest(
  tunnelId: string,
  req: { path: string; method: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs?: number } = {},
): Promise<TunnelResponse> {
  const entry = tunnels.get(tunnelId);
  if (!entry) throw new Error(`tunnel "${tunnelId}" is not connected`);

  const id = nextId();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<TunnelResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`tunnel "${tunnelId}" request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    entry.pending.set(id, { resolve, reject, timer });

    try {
      entry.transport.send({
        type: "request",
        id,
        path: req.path,
        method: req.method,
        headers: req.headers ?? {},
        body: req.body,
      });
    } catch (err) {
      clearTimeout(timer);
      entry.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Parse a `tunnel://<id>/<path>` URL.
 * Returns null for non-tunnel URLs.
 */
export function parseTunnelUrl(url: string): { tunnelId: string; path: string } | null {
  if (!url.startsWith("tunnel://")) return null;
  const rest = url.slice("tunnel://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    if (!rest) return null;
    return { tunnelId: rest, path: "/" };
  }
  const tunnelId = rest.slice(0, slash);
  if (!tunnelId) return null;
  return { tunnelId, path: rest.slice(slash) };
}
