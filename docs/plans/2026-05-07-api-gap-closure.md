# API Gap Closure — 16 Missing Endpoints

> Current coverage: 60/76 Anthropic MA endpoints (79%).
> Target: 76/76 (100%) + our 6 extensions.

## What's missing

### Group A: Small fixes to existing resources (7 endpoints, ~1 day)

These are minor additions to resources we already fully support.

**Memory stores (2):**
- `POST /v1/memory_stores/:id` — update store (name, description, metadata). We have the DB function (`updateMemoryStore` may need to be added) but no HTTP handler. Anthropic schema: `{ name?, description?, metadata? }`.
- `POST /v1/memory_stores/:id/memories/:memId` — update memory via POST. We have `PATCH` but Anthropic uses `POST`. Add POST as an alias, or make the existing PATCH handler also accept POST.

**Memory version redaction (1):**
- `POST /v1/memory_stores/:id/memory_versions/:vid/redact` — scrub content from a historical version while preserving the audit trail. Sets `redacted_at` timestamp, nulls `content`. Cannot redact the current head version of a live memory.

**Session resource update (1):**
- `POST /v1/sessions/:id/resources/:rid` — update a resource (e.g., change `mount_path`). We have GET and DELETE. Anthropic schema: `{ mount_path? }`.

**Credential archive (1):**
- `POST /v1/vaults/:id/credentials/:credId/archive` — soft-archive a credential. We have DELETE (hard delete). Add archive with `archived_at`.

**Credential MCP OAuth validate (1):**
- `POST /v1/vaults/:id/credentials/:credId/mcp_oauth_validate` — validate that an MCP OAuth credential can successfully authenticate. Calls the token endpoint and reports success/failure.

**Credential DELETE → archive alignment (1):**
- Anthropic doesn't have `DELETE` for credentials — they use `POST /archive`. We have DELETE. Keep DELETE for backward compat but add archive.

### Group B: Skills CRUD with versioning (4 endpoints, ~2 days)

We have `POST /v1/skills` (create) and `GET /v1/skills` (list from catalog) and `DELETE /v1/skills/:id`. Missing:

- `GET /v1/skills/:id` — retrieve a single skill
- `GET /v1/skills/:id/versions` — list skill versions
- `GET /v1/skills/:id/versions/:version` — retrieve specific version
- `POST /v1/skills/:id/versions` — create new version
- `DELETE /v1/skills/:id/versions/:version` — delete specific version

Anthropic's skills are versioned resources (like agents). Each skill has a `skill_id`, content (markdown), and immutable versions.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(skill_id, version)
);
```

**Files to modify:**
- `packages/agent-sdk/src/db/migrations.ts` — skill_versions table
- `packages/agent-sdk/src/handlers/skills.ts` — add get, versions list, version get, version create, version delete
- `packages/agent-sdk/src/handlers/skills-write.ts` — may already have some of this
- `packages/gateway-hono/src/index.ts` — register routes

### Group C: User Profiles (5 endpoints, ~2 days)

Entirely new resource type. User profiles map end-users to trust grants — used for per-user credential scoping in enterprise deployments.

- `POST /v1/user_profiles` — create
- `GET /v1/user_profiles` — list
- `GET /v1/user_profiles/:id` — retrieve
- `POST /v1/user_profiles/:id` — update
- `POST /v1/user_profiles/:id/enrollment_url` — generate enrollment URL for user to authorize OAuth credentials

**Anthropic schema:**
```json
{
  "type": "user_profile",
  "id": "uprof_...",
  "external_id": "user-123",
  "display_name": "Jane Doe",
  "trust_grants": [
    { "type": "vault_credential", "vault_id": "vlt_...", "credential_id": "cred_..." }
  ],
  "created_at": "...",
  "updated_at": "..."
}
```

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  display_name TEXT,
  trust_grants_json TEXT NOT NULL DEFAULT '[]',
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Files to create:**
- `packages/agent-sdk/src/db/user-profiles.ts` — CRUD
- `packages/agent-sdk/src/handlers/user-profiles.ts` — 5 endpoint handlers

**Files to modify:**
- `packages/agent-sdk/src/db/migrations.ts` — user_profiles table
- `packages/agent-sdk/src/types.ts` — UserProfile interface
- `packages/agent-sdk/src/util/ids.ts` — `uprof_` prefix
- `packages/agent-sdk/src/handlers/index.ts` — exports
- `packages/gateway-hono/src/index.ts` — register routes

## Delivery order

1. **Group A — Small fixes** (~1 day) — 7 endpoints, all additions to existing resources
2. **Group B — Skills versioning** (~2 days) — 4 endpoints, new table + handlers
3. **Group C — User Profiles** (~2 days) — 5 endpoints, entirely new resource

Total: ~5 days to reach 76/76 (100% coverage)

## Out of scope

- Our 6 extension endpoints (vault entries, DELETE agents, PATCH memories) stay as-is — they're additive, not conflicting
- Skills catalog/feed/index endpoints (`/v1/skills/catalog`, `/v1/skills/feed`, etc.) are our extensions for the browse UI — keep them alongside the Anthropic-compatible CRUD
