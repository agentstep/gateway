import { ensureInitialized } from "../init";
import { authenticate } from "../auth/middleware";
import { subscribe } from "../sessions/bus";
import { getDb } from "../db/client";
import { getSession } from "../db/sessions";
import { isProxied, getProxiedTenantId } from "../db/proxy";
import { resolveRemoteSessionId } from "../db/sync";
import { forwardToAnthropic } from "../proxy/forward";
import { toResponse, notFound } from "../errors";
import { assertResourceTenant } from "../auth/scope";
import type { ManagedEvent } from "../types";

export async function handleSessionStream(request: Request, sessionId: string): Promise<Response> {
  try {
    await ensureInitialized();
    const auth = await authenticate(request);

    // Tenant guard — cross-tenant SSE looks like 404, not 403.
    // Two possible sources of truth:
    //   - Local sessions row (sync-and-proxy or native)
    //   - Proxy-only row (agent engine=anthropic, no local mirror)
    // Check local first; fall through to the proxy table so pure-
    // proxy sessions don't bypass tenancy.
    const tenantRow = getDb()
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { tenant_id: string | null } | undefined;
    if (tenantRow) {
      assertResourceTenant(auth, tenantRow.tenant_id, `session ${sessionId} not found`);
    } else {
      const proxyTenant = getProxiedTenantId(sessionId);
      if (proxyTenant !== undefined) {
        assertResourceTenant(auth, proxyTenant, `session ${sessionId} not found`);
      }
      // If neither exists, the downstream code will return a 404.
    }

    // Sync-and-proxy sessions have a local record — serve from local event bus.
    // Pure proxy sessions (no local record) forward to Anthropic.
    if (isProxied(sessionId)) {
      const localSession = getSession(sessionId);
      if (!localSession) {
        // Pure proxy — forward to Anthropic
        const remoteId = resolveRemoteSessionId(sessionId);
        const res = await forwardToAnthropic(request, `/v1/sessions/${remoteId}/stream`);
        const headers = new Headers(res.headers);
        headers.set("X-Accel-Buffering", "no");
        return new Response(res.body, { status: res.status, headers });
      }
      // Sync-and-proxy: fall through to local SSE below
    }

    const session = getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId} not found`);

    const url = new URL(request.url);
    const lastEventId = request.headers.get("last-event-id");
    const afterSeq = lastEventId
      ? Number(lastEventId)
      : Number(url.searchParams.get("after_seq") ?? "0");

    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const write = (payload: string) => {
      writer.write(encoder.encode(payload)).catch(() => {});
    };

    const writeEvent = (evt: ManagedEvent) => {
      const lines = [
        `id: ${evt.seq}`,
        `event: ${evt.type}`,
        `data: ${JSON.stringify(evt)}`,
        "",
        "",
      ].join("\n");
      write(lines);
    };

    const keepalive = setInterval(() => {
      write(`data: {"type":"ping"}\n\n`);
    }, 15_000);

    const sub = subscribe(sessionId, Number.isFinite(afterSeq) ? afterSeq : 0, writeEvent);

    const abort = () => {
      clearInterval(keepalive);
      sub.unsubscribe();
      try {
        writer.close();
      } catch { /* ignore */ }
    };
    request.signal.addEventListener("abort", abort);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return toResponse(err);
  }
}
