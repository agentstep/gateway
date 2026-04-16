# Changelog

All notable changes to AgentStep Gateway are documented here. Dates are UTC.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [SemVer](https://semver.org/).

## [0.4.0] — 2026-04-16

### Added

- **Virtual keys** — `POST/GET/PATCH/DELETE /v1/api-keys` admin API plus
  full management UI on `/api-keys`. Per-key scope (`{agents, environments,
  vaults}` allow-lists with `"*"` sentinel), per-key budget ceiling,
  per-key RPM rate limit. Legacy single-key installs keep working because
  `["*"]` permissions hydrate as `{admin: true, scope: null}`.
- **Per-key cost attribution** — sessions capture `api_key_id` from the
  authenticating key. `/v1/metrics?group_by=api_key` groups costs per key;
  legacy sessions bucket under `__unattributed__`. `/v1/api-keys/:id/activity`
  returns recent sessions plus lifetime totals.
- **Time-series metrics** — `?time_bucket=hour|day|week` alongside
  `group_by=api_key` returns one series per key, top-10 keys tracked
  individually, remainder collapses into `__other__`. New recharts
  `LineChart` on the ApiKeys page.
- **Session fallback** — `agents.fallback_json` defines an array of
  `{agent_id, environment_id}` tuples tried on session-creation failure.
  Max 3 hops, cycle-detected. Triggers on env-not-ready, Anthropic
  upstream 5xx/429, and anything classifiable as retryable; does not
  fire on config/billing/scope errors.
- **Upstream-key pool** — per-provider credential pool with LRU selection
  and 3-strike auto-disable. Admin API at `/v1/upstream-keys`. Anthropic
  only in v0.4; OpenAI/Gemini follow in 0.5.
- `tenant_id TEXT` column reserved on `api_keys` (no reads in v0.4 —
  forward-compat hook for v0.5 full tenant isolation).

### Changed

- `AuthContext` now carries the full `{admin, scope}` permissions object,
  plus `budgetUsd`, `rateLimitRpm`, `spentUsd`, `tenantId`. Handlers that
  ignored auth before are source-compatible.
- `bumpSessionStats` is now transactional: session counters and the
  owning key's `spent_usd` update in a single DB transaction, preventing
  crash-induced under-reporting.
- Three scattered `resolveAnthropicKey` call sites (SSE tee, session
  creation, proxy forward) consolidated into a single helper at
  `providers/upstream-keys.ts`.

### Tests

518 → 560 passing. New test files: `test/api-keys-handlers.test.ts`
(29 tests) and `test/upstream-keys.test.ts` (13 tests).

## [0.3.8] — 2026-04-16

### Fixed / Changed

- **Skills catalog URL is now configurable.** New env vars `SKILLS_FEED_URL`
  / `SKILLS_INDEX_URL` and matching settings keys
  `skills_feed_url` / `skills_index_url`. Default flipped from a
  third-party personal GitHub account to `www.agentstep.com/v1/skills/*`
  — removes a supply-chain concern (anyone with write access to the
  previous repo could push arbitrary JSON that every gateway would then
  fetch on the Skills page). Operators running air-gapped can point at
  a self-hosted mirror.
- Index parser now accepts both `{count, items}` and `{totalSkills, skills}`
  response shapes, so the backend endpoint can ship either schema.
- Server-side rejection of `sk-ant-oat*` OAuth tokens for the anthropic
  sync-and-proxy provider (wizard already rejected them; this closes the
  API-direct path that the docs claimed was blocked).
- Minor doc drift: `docs/telemetry.md` cli_version example updated.

## [0.3.7] — 2026-04-16

### Fixed

- **`gateway version` printed "dev"** on the installed npm tarball
  because the path resolver didn't know it was running from the bundled
  `dist/`. Now tries multiple candidate paths and validates by
  package name. Every 0.3.6 install will see "dev" until upgraded.
- **README overclaimed `@anthropic-ai/sdk` compatibility.** The
  upstream SDK doesn't yet expose the `managed-agents-2026-04-01` beta
  endpoints, so the README now honestly recommends raw `fetch` / curl
  with the `anthropic-beta` header.
- **Quickstart Vercel/Modal/Fly fields were single-use** — non-secret
  fields (`VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `MODAL_TOKEN_SECRET`,
  `FLY_APP_NAME`) were only set on `process.env` for the quickstart's
  lifetime. After exit, providers failed at runtime. All fields now
  persist to the settings table. Provider modules read env→settings
  fallback via a new `readEnvOrSetting` helper.
- **Hono + Fastify adapters leaked the API key behind a reverse
  proxy.** Same-host Caddy/Nginx deployments see the socket as
  127.0.0.1 always. Honors `X-Forwarded-For` only when `TRUST_PROXY=1`
  is set, matching the Next adapter's default-closed posture.

## [0.3.6] — 2026-04-16

Closes four blockers from the third-architect review:

- gateway-next `x-real-ip` no longer trusted without `TRUST_PROXY=1` (same class as the original LAN leak)
- `docker-compose.yml` volume path fixed (`/home/node/app/data`) — previously bypassed the vault-key persistence
- Deleted 1700 lines of dead legacy static UI from the agent-sdk tarball
- Cleaned up scrubbed attribution stubs, verbose [tee] and [lifecycle] logs gated behind DEBUG_SYNC and DEBUG_LIFECYCLE
- Added npm metadata (keywords, homepage, bugs, author) for discoverability
- README Packages table relabeled (4 of 6 packages are source-only, not npm)

## [0.3.5] — 2026-04-16

### Security

- **Fastify + Next UI adapters** now gate `window.__MA_API_KEY__` injection
  to loopback-remote requests (previously only the Hono adapter did). Without
  this, any LAN-reachable deployment of either adapter still leaked the
  gateway's API key via the HTML returned at `/`.
- **Docker vault key persistence.** `VAULT_ENCRYPTION_KEY_FILE` is now
  honored by the vault module. The Dockerfile sets it to
  `/home/node/app/data/.vault-key` (inside the `VOLUME`) so the key
  survives container recreation. Previously the key landed in `.env`
  outside the volume, orphaning all encrypted entries on every restart.
- **Telemetry error path no longer leaks raw argv.** The `.catch()`
  handler at `packages/gateway/src/index.ts` now sends only the command
  name chain, matching the success path and `docs/telemetry.md`.
- **Dev server default bind.** `npm run dev` is now loopback
  (`HOST=0.0.0.0` to expose), matching `gateway serve`.
- **Next adapter loopback detection fails closed.** `x-forwarded-for`
  and `x-real-ip` are only trusted under explicit `TRUST_PROXY=1`;
  otherwise no auto-login.

### Operational

- Repository history re-squashed. Pre-0.3.1 tags contained committed
  SQLite DB files with vault secrets. All leaked keys have been rotated
  with their providers; the old commits and tags are removed from both
  public remotes. Single-commit history starts at v0.3.5.

## [0.3.4] — 2026-04-16

### Added
- `gateway db` subcommand with `db reset` — wipes the local SQLite DB with
  live-server detection, Turso-replica refusal, `--include-files`,
  `--dry-run`, and non-TTY safety. Adds 38 tests.
- `gateway serve --host <addr>` flag. Default is now `127.0.0.1` (loopback);
  passing `0.0.0.0` prints a security warning.
- Home tile tooltips (info icon with description) on the overview page.
- `CHANGELOG.md`, `.env.example`, `.github/ISSUE_TEMPLATE/`.

### Changed
- **Security:** server default bind is now loopback. Public binds require
  explicit `--host 0.0.0.0`.
- **Security:** the UI no longer injects `window.__MA_API_KEY__` for
  requests from non-loopback clients, preventing LAN-wide credential leak
  when bound publicly.
- **Security:** `/v1/settings/:key` now masks provider secrets in the
  response body. Existing "configured" state is surfaced via a new
  `configured: boolean` field.
- `db reset` probe uses `/api/health` instead of a catch-all path.
- README lede rewritten around the Anthropic Managed Agents hook.
- Quickstart now prompts for all required provider env vars (Vercel,
  Modal, Fly need multiple).
- API key is masked in the `gateway serve` startup banner; full key is in
  `data/.api-key` and `.env` only.
- Overview page API key is masked by default with reveal + copy.
- Home pulse row cut from 6 tiles to 4 (dropped API p95 + Error rate,
  both live on `/dashboard`). Each tile gained an info tooltip.

### Fixed
- `observability/api-metrics.ts`: `error_rate` is now 5xx-only. 4xx is
  client behavior (404s from UI polling during navigation, 401s) and was
  inflating health signals to ~24% on fresh installs.
- Agent detail routing (`/settings/agents/:id` → `/agents/:id`). The old
  URL was a 404 after the TanStack Router refactor.
- Sidebar height cap (`h-svh overflow-hidden`) — prevents pages from
  pushing the entire layout below the viewport when content is tall.
- Playground center column scrolls within the viewport with a pinned
  ChatInput at the bottom.
- `syncAgent` now passes `agent.tools` to Anthropic's `/v1/agents`
  endpoint; without this, managed agents were created with no tools.
- Wizard-created claude agents default to the full built-in toolset
  (previously empty `tools: []` disabled every tool via `--disallowed-tools`).
- `packages/gateway/package.json` repo URL corrected to `agentstep/gateway`.
- Node engines bumped to `>=22` (matches the real build target).
- Vault name is now editable in the onboarding wizard (was hardcoded to
  `my-vault`).

### Tests
- 515 total passing (477 agent-sdk + 38 gateway). Added
  `anthropic-sync.test.ts`, `db-reset.test.ts`, GET /v1/settings masking
  tests, and a regression test for empty-`tools` resolution.

## [0.3.3] — 2026-04-16

Initial public release. Anthropic Managed Agents sync-and-proxy, vault
encryption at rest, welcome hero empty state, Home analytics pulse row,
engine/provider compatibility enforcement, defensive wizard rules.

## [0.3.1] — 2026-04

First tagged release on GitHub.
