/**
 * /v1/upstream-keys — admin-only CRUD for the per-provider upstream key pool.
 *
 * v0.5 provider set: "anthropic", "openai", "gemini". The resolver in
 * providers/upstream-keys.ts knows how to pull the right vault entry
 * name and config field for each.
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { badRequest, notFound } from "../errors";
import { requireAdmin } from "../auth/scope";
import {
  addUpstreamKey,
  listUpstreamKeys,
  getUpstreamKey,
  disableUpstreamKey,
  enableUpstreamKey,
  deleteUpstreamKey,
} from "../db/upstream_keys";
import { SUPPORTED_PROVIDERS } from "../providers/upstream-keys";
import { recordAudit } from "../db/audit";

const AddBody = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS),
  value: z.string().min(20).max(500),
  weight: z.number().int().positive().optional(),
});

const PatchBody = z.object({
  disabled: z.boolean(),
});

export function handleAddUpstreamKey(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireAdmin(auth);
    const body = await req.json().catch(() => null);
    const parsed = AddBody.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.errors.map(e => e.message).join("; "));
    }
    try {
      const added = addUpstreamKey(parsed.data);
      recordAudit({
        auth,
        action: "upstream_keys.add",
        resource_type: "upstream_key",
        resource_id: added.id,
        metadata: { provider: added.provider, prefix: added.prefix },
      });
      return jsonOk(added, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) {
        throw badRequest("an identical value is already in the pool for this provider");
      }
      throw err;
    }
  });
}

export function handleListUpstreamKeys(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireAdmin(auth);
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider") ?? undefined;
    return jsonOk({ data: listUpstreamKeys(provider) });
  });
}

export function handleGetUpstreamKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    const row = getUpstreamKey(id);
    if (!row) throw notFound(`upstream key ${id} not found`);
    return jsonOk(row);
  });
}

/** Enable or disable a pool entry. Body: { disabled: true|false }. */
export function handlePatchUpstreamKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireAdmin(auth);
    const body = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.errors.map(e => e.message).join("; "));
    }
    const ok = parsed.data.disabled ? disableUpstreamKey(id) : enableUpstreamKey(id);
    if (!ok) throw notFound(`upstream key ${id} not found`);
    const after = getUpstreamKey(id);
    recordAudit({
      auth,
      action: parsed.data.disabled ? "upstream_keys.disable" : "upstream_keys.enable",
      resource_type: "upstream_key",
      resource_id: id,
      metadata: { provider: after?.provider },
    });
    return jsonOk(after);
  });
}

export function handleDeleteUpstreamKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    const before = getUpstreamKey(id);
    const ok = deleteUpstreamKey(id);
    if (!ok) throw notFound(`upstream key ${id} not found`);
    recordAudit({
      auth,
      action: "upstream_keys.delete",
      resource_type: "upstream_key",
      resource_id: id,
      metadata: before ? { provider: before.provider, prefix: before.prefix } : {},
    });
    return jsonOk({ ok: true, id });
  });
}
