# Skills CRUD — DB-stored skills with container mount

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Anthropic Skills API — DB-stored skills with versioning, mounted into containers at turn time. Closes the last 5 endpoint gaps (71/76 → 76/76).

**Architecture:** Skills are stored in SQLite (`skills` + `skill_versions` tables). On first turn, skill content is read from DB and written into the container at the engine's expected path. Same pattern as memory mount. Existing filesystem skills (`source.project_path`) continue to work alongside DB skills.

**Tech Stack:** TypeScript, Zod, libsql, vitest

---

## What already exists

- `packages/agent-sdk/src/handlers/skills-write.ts` — Has 501 stubs for `POST /v1/skills` and `DELETE /v1/skills/:id`
- `packages/agent-sdk/src/handlers/skills.ts` — Catalog/feed/search handlers (read-only from external feed)
- `packages/agent-sdk/src/containers/lifecycle.ts` — `installSkills()` function that writes skill content into containers. Currently resolves from agent config's `skills_json` (filesystem-based sources)
- `packages/agent-sdk/src/lib/skills-cache.ts` — External feed cache for the browse catalog
- Agent `skills` field accepts `[{ source: { type: "project", project_path: "..." } }]`

## Schema

```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  current_version TEXT,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(skill_id, version),
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id, created_at);
```

## Task 1: DB layer + migrations

**Files:**
- Modify: `packages/agent-sdk/src/db/migrations.ts` — Add `skills` and `skill_versions` tables
- Modify: `packages/agent-sdk/src/db/schema.ts` — Add Drizzle schema
- Create: `packages/agent-sdk/src/db/skills.ts` — CRUD functions
- Modify: `packages/agent-sdk/src/types.ts` — Add `Skill`, `SkillVersion` interfaces
- Modify: `packages/agent-sdk/src/util/ids.ts` — Add `skill_` and `sklv_` prefixes

**DB functions:**
```typescript
createSkill(input: { name, description?, content, tenant_id? }): Skill
// Creates skill row + first skill_version (version "1.0.0")

getSkill(id: string): Skill | undefined
// Joins with latest version

listSkills(opts?: { limit, cursor, tenant_id?, include_archived? }): Skill[]

deleteSkill(id: string): boolean
// Hard delete skill + all versions

createSkillVersion(skillId: string, input: { content, version? }): SkillVersion
// Auto-increments version if not specified (1.0.0 → 1.0.1)
// Updates skills.current_version

getSkillVersion(skillId: string, version: string): SkillVersion | undefined

listSkillVersions(skillId: string, opts?: { limit, cursor }): SkillVersion[]

deleteSkillVersion(skillId: string, version: string): boolean
// Cannot delete current_version (must create a new version first or delete the skill)
```

**Types:**
```typescript
export interface Skill {
  type: "skill";
  id: string;
  name: string;
  description: string;
  current_version: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SkillVersion {
  type: "skill_version";
  id: string;
  skill_id: string;
  version: string;
  content: string;
  created_at: string;
}
```

## Task 2: HTTP handlers

**Files:**
- Rewrite: `packages/agent-sdk/src/handlers/skills-write.ts` — Replace 501 stubs with real handlers
- Modify: `packages/agent-sdk/src/handlers/skills.ts` — Add `handleGetSkill`
- Modify: `packages/agent-sdk/src/handlers/index.ts` — Export new handlers
- Modify: `packages/gateway-hono/src/index.ts` — Register routes

**Endpoints:**
```
POST   /v1/skills                           → createSkill (name, description?, content)
GET    /v1/skills                           → listSkills (already exists for catalog — need to merge)
GET    /v1/skills/:id                       → getSkill
DELETE /v1/skills/:id                       → deleteSkill (already has 501 stub)
POST   /v1/skills/:id/versions              → createSkillVersion (content, version?)
GET    /v1/skills/:id/versions              → listSkillVersions
GET    /v1/skills/:id/versions/:version     → getSkillVersion
DELETE /v1/skills/:id/versions/:version     → deleteSkillVersion
```

**Important:** `GET /v1/skills` currently serves the catalog feed. We need to handle both:
- If the request has no query params or has `skill_id`-style params → DB skills CRUD list
- If the request has `q`, `sort`, `leaderboard` params → catalog search (existing behavior)

Or simpler: DB skills list is the primary. The catalog endpoints stay at `/v1/skills/catalog`, `/v1/skills/feed`, `/v1/skills/stats` (our extensions).

**Create schema:**
```typescript
const CreateSkillSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2048).optional(),
  content: z.string().min(1).max(256000), // 256KB max per skill
});
```

## Task 3: Agent skill resolution from DB

**Files:**
- Modify: `packages/agent-sdk/src/containers/lifecycle.ts` — Update `installSkills()` to resolve DB skills
- Modify: `packages/agent-sdk/src/handlers/agents.ts` — Accept Anthropic skill format on agent create/update

**Agent create accepts both formats:**

```json
// Our existing format (filesystem)
{ "source": { "type": "project", "project_path": "/skills/review" } }

// Anthropic format (DB)
{ "skill_id": "skill_...", "type": "custom", "version": "1.0.0" }

// Anthropic catalog format
{ "skill_id": "find-skills", "type": "anthropic", "version": "1.0.0" }
```

**In `installSkills()`:**

Currently resolves skills from agent config and writes `SKILL.md` files. Add a branch:

```typescript
for (const skill of agent.skills) {
  if (skill.skill_id) {
    // DB skill — resolve from skills table
    const dbSkill = getSkillVersion(skill.skill_id, skill.version);
    if (dbSkill) {
      // Write content to container at $HOME/.claude/skills/<name>/SKILL.md
      await writeSkillToContainer(provider, sandboxName, dbSkill.name, dbSkill.content);
    }
  } else if (skill.source?.type === "project") {
    // Existing filesystem resolution
    // ... current code ...
  }
}
```

## Task 4: Tests

**File:** `packages/agent-sdk/test/skills-crud.test.ts`

Cover:
- Create skill → returns skill with version 1.0.0
- Get skill by ID
- List skills with pagination
- Delete skill removes all versions
- Create version → auto-increments version
- Get specific version
- List versions
- Delete version (not current)
- Cannot delete current version
- Agent create with `{ skill_id, type: "custom" }` format
- Agent create with existing `{ source: { type: "project" } }` still works
- Skill content written to container (mock provider)

## Delivery

Single PR. The 501 stubs in `skills-write.ts` become real handlers. Existing catalog endpoints stay unchanged. Agent skill format accepts both our `source` format and Anthropic's `skill_id` format.

After this: 76/76 Anthropic endpoints (100%).
