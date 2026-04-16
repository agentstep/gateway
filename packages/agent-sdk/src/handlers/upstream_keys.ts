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
    return jsonOk(after);
  });
}

export function handleDeleteUpstreamKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    const ok = deleteUpstreamKey(id);
    if (!ok) throw notFound(`upstream key ${id} not found`);
    return jsonOk({ ok: true, id });
  });
}
