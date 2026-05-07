/**
 * Skill CRUD handlers — standalone, DB-stored skills with versioning.
 *
 * POST   /v1/skills                         — create skill + first version
 * GET    /v1/skills/:id                     — get skill
 * DELETE /v1/skills/:id                     — hard delete skill + all versions
 * POST   /v1/skills/:id/versions            — create new version
 * GET    /v1/skills/:id/versions            — list versions
 * GET    /v1/skills/:id/versions/:version   — get specific version
 * DELETE /v1/skills/:id/versions/:version   — delete version (cannot delete current)
 */
import { z } from "zod";
import { routeWrap, jsonOk, paginatedOk, decodeCursor } from "../http";
import { badRequest, notFound } from "../errors";
import {
  createSkill,
  getSkill,
  listSkills,
  deleteSkill,
  createSkillVersion,
  getSkillVersion,
  listSkillVersions,
  deleteSkillVersion,
} from "../db/skills";
import { resolveCreateTenant, tenantFilter } from "../auth/scope";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateSkillSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  content: z.string().min(1).max(256 * 1024), // 256 KB
  tenant_id: z.string().optional(),
});

const CreateVersionSchema = z.object({
  content: z.string().min(1).max(256 * 1024),
  version: z.string().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /v1/skills */
export function handleCreateSkill(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json().catch(() => null);
    const parsed = CreateSkillSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        `invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    const tenantId = resolveCreateTenant(auth, parsed.data.tenant_id);

    const skill = createSkill({
      name: parsed.data.name,
      description: parsed.data.description,
      content: parsed.data.content,
      tenantId,
    });

    return jsonOk(skill, 201);
  });
}

/** GET /v1/skills/:id */
export function handleGetSkill(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const skill = getSkill(skillId);
    if (!skill) throw notFound(`skill ${skillId} not found`);
    return jsonOk(skill);
  });
}

/** DELETE /v1/skills/:id */
export function handleDeleteSkill(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const ok = deleteSkill(skillId);
    if (!ok) throw notFound(`skill ${skillId} not found`);
    return jsonOk({ id: skillId, type: "skill_deleted" });
  });
}

/** POST /v1/skills/:id/versions */
export function handleCreateSkillVersion(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json().catch(() => null);
    const parsed = CreateVersionSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        `invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    const sv = createSkillVersion(skillId, {
      content: parsed.data.content,
      version: parsed.data.version,
    });
    if (!sv) throw notFound(`skill ${skillId} not found`);

    return jsonOk(sv, 201);
  });
}

/** GET /v1/skills/:id/versions */
export function handleListSkillVersions(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    // Verify skill exists
    const skill = getSkill(skillId);
    if (!skill) throw notFound(`skill ${skillId} not found`);

    const url = new URL(req.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") || "20"), 1),
      100,
    );
    const cursor = decodeCursor(url.searchParams.get("after_id"));

    const versions = listSkillVersions(skillId, { limit, cursor });
    return paginatedOk(versions, limit);
  });
}

/** GET /v1/skills/:id/versions/:version */
export function handleGetSkillVersion(
  request: Request,
  skillId: string,
  version: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const sv = getSkillVersion(skillId, version);
    if (!sv) throw notFound(`skill version ${version} not found`);
    return jsonOk(sv);
  });
}

/** DELETE /v1/skills/:id/versions/:version */
export function handleDeleteSkillVersion(
  request: Request,
  skillId: string,
  version: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const result = deleteSkillVersion(skillId, version);
    if (!result.ok) {
      if (result.reason === "cannot delete the current version") {
        throw badRequest(result.reason);
      }
      throw notFound(`skill version ${version} not found`);
    }
    return jsonOk({ skill_id: skillId, version, type: "skill_version_deleted" });
  });
}
