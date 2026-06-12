# One Great SDK — Consolidation Plan

**Goal.** Evolve `@agentstep/agent-sdk` into a single, coherent SDK that is
simultaneously: the best *embedded* agent engine (a real library), the best
*client* for a deployed gateway, and the best *managed-agents API surface*
available off-platform — across all six harnesses and eleven container
providers.

**Positioning sentence the SDK must make true:**

> AgentStep ships an engine you can embed, a client to talk to it, and a
> Gateway server when you want it deployed — one resource model, one event
> schema, any harness, your infrastructure.

**Compatibility contract.** The SDK's TypeScript API is **not** subject to
backward compatibility — exports, signatures, package layout, and internal
architecture may break freely between releases. What must stay stable is
the **wire protocol**:

- `/anthropic/v1/*` — Managed Agents-compatible shapes (requests,
  responses, event payloads, SSE framing, error envelopes)
- `/google/v1beta/*` — Google-compat shapes
- `/v1/*` — gateway-native API
- Webhook payloads and signatures; the work-queue protocol

The compat test suites (`ma-compat`, `sdk-compat`, `api-comprehensive`)
are the contract; they must pass unchanged through every phase. Everything
not covered by them is fair game to redesign without shims or deprecation
cycles.

**Method.** Phased, not big-bang — every phase ships independently and is
test-guarded — but with no obligation to preserve the library surface
between phases. No deprecated aliases, no compat shims: when a name or
shape improves, the old one is deleted in the same commit.

---

## Status

| Phase | State |
|---|---|
| 0 — typed client, turn ergonomics, middleware, naming | ✅ shipped |
| 1.1 — event schema registry (`GatewayEvent`, drift guard) | ✅ shipped |
| 1.2 — service core extraction | ⏳ next up (start: sessions/events; `sessions/kickoff.ts` is the first extracted piece) |
| 1.3 — explicit runtime | ⏳ after 1.2 |
| 2.1/2.2 — turn pipeline + `registerTurnMiddleware` hooks | ✅ shipped (executor interface 2.3 pending) |
| 3 — egress credential substitution | ⏳ MCP creds already gateway-side; proxy pending |
| 4.1 — outcomes on the client (`defineOutcome` → `OutcomeResult`) | ✅ shipped |
| 4.2 — scheduled deployments + runs + scheduler | ✅ shipped |
| 4.3 — threads parity | ⏳ |
| 5.1 — lite execution tier | ⏳ needs 2.3 |
| 5.2 — chat/UI message stream endpoint | ✅ shipped |
| 5.3 — packaging rename | ⏳ decision pending |

## Where we stand (Phase 0 — shipped)

- Typed programmatic client (`src/client/`): `createClient()` over two
  transports (in-process handler dispatch / remote HTTP with SSE
  reconnect-and-resume), one resource layer defined once.
- Turn ergonomics: `SessionHandle.send()` (async-iterable turn) and
  `run()` (awaitable `TurnResult`), `stream()`, `interrupt()`,
  `confirmTool()`.
- Composable call middleware (`withRetry`, `withLogging`), typed event
  guards (`isAgentMessage`, `eventText`, ...), `ApiClientError`.
- CLI collapsed onto the public client (deleted ~850 lines of duplicated
  `any`-typed surface); four latent CLI bugs fixed that typing exposed.
- Brand-accurate naming (`createClient` / `AgentStepClient`); no legacy
  aliases — the TS surface breaks freely per the compatibility contract.

Already strong and underappreciated in our surface: **outcomes**
(`user.define_outcome` + `sessions/grader.ts` iterate→grade→revise loop with
`span.outcome_evaluation_*` events), the **work queue** for self-hosted
workers, **webhooks** with HMAC signing, **threads**, **memory stores**,
**traces/OTLP**, and the ops layer (tenants, audit, metrics, API keys,
upstream keys) that no comparable SDK has.

---

## Phase 1 — Foundations: one schema, one core, one runtime

### 1.1 Event schema registry (do first — everything wants it)

Today events are `type: string` + flattened JSON payloads; the client's
typed guards were hand-derived. Define the event union **once** in the
engine and derive everything from it.

- `src/events/registry.ts`: zod schema per event type (the ~33 types
  emitted today), exported discriminated union `GatewayEvent`.
- Translators compile to registry types (compile-time check that all six
  backends emit valid events).
- Derived consumers: bus typing, SSE payloads, webhook payloads, client
  guards (replace `client/events.ts` internals; keep its API), OpenAPI
  event schemas (replace hand-written ones in `openapi/schemas.ts`), docs.
- Versioning rule: additive fields only; new event types are minor bumps.

*Acceptance:* `switch (ev.type)` narrows without guards anywhere in the
codebase; one place to add an event type; translator tests fail on schema
drift. *Size: S–M.*

### 1.2 Service core extraction (handlers become codecs)

Business logic moves from handler bodies into typed services
(`AgentService`, `SessionService`, `VaultService`, ...) taking an explicit
`AuthContext`. Handlers shrink to parse → call service → serialize.
The client's `LocalTransport` then calls services directly — no more
fabricated `Request` objects in-process, while auth/validation/audit
semantics stay identical because they live in the services.

Order of extraction (by traffic and risk): sessions/events → agents →
environments → vaults → the rest. Each resource is one PR; the wire-level
compat suites must pass unchanged after each — handler *signatures* and
client *types* may change freely.

*Acceptance:* `LocalTransport` contains zero `new Request(...)`; handler
files contain zero DB imports. *Size: L (the center of gravity).*

### 1.3 Explicit runtime (`createRuntime`)

Replace the ~nine `globalThis.__ca*` singletons with a constructed
`Runtime` owning db, bus, actors, queue, sweeper, config. Services are
built against a runtime instance.

- `createRuntime(config)` / `runtime.close()`; a default runtime preserves
  today's zero-config behavior.
- `createClient({ runtime })` binds the local transport to an instance.
- Tests: `freshDbEnv()` globalThis surgery replaced by
  `createRuntime({ db: ':memory:' })` per test.

*Acceptance:* two runtimes in one process pass the full client test suite
concurrently; `grep -r "globalThis.__ca" src` returns only a
compat shim. *Size: M–L. Depends on 1.2.*

---

## Phase 2 — Turn pipeline: stages, hooks, pluggable execution

### 2.1 Driver decomposition

`driver.ts` (~1,300 lines) becomes composed stages:
`resolve → decorate → execute → translate → settle`. Each inline
decoration block (provider quirks, RESOURCES_DIR, MCP timeout, vault env
injection, OAuth remap, local-model wiring) becomes a named, separately
tested turn middleware — same composition pattern as the client's call
middleware.

### 2.2 Programmable turn hooks (closes the in-process-hooks gap)

Two registration surfaces over the same mechanism:

- **In-process:** `createRuntime({ turnMiddleware: [...] })` and
  `preToolUse`/`postToolUse` hooks invoked from the tool-confirmation and
  tool-bridge paths — policy code that can inspect/mutate/deny.
- **Declarative:** agent-level `permission_policy` (exists) plus
  webhook-style external hooks for deployed gateways.

This gives embedded users the interception power that in-process agent
SDKs offer, with our multi-harness reach.

### 2.3 Executor interface

`execute` becomes an interface with one implementation today
(`ContainerExecutor` wrapping `provider.startExec` + NDJSON translation).
This is the honest seam for a future `LiteExecutor` (sandbox-less
sessions) without committing to it now.

*Acceptance:* driver file < 300 lines of orchestration; a user-supplied
turn middleware can veto a tool call in a test; interrupt/secrets/tool
bridge behavior unchanged (existing e2e tests pass). *Size: L. Depends
on 1.1 (events), benefits from 1.3.*

---

## Phase 3 — Security: secrets never enter the sandbox

Today vault entries are injected as container env vars (driver decorate
stage). The superior model — used by the hosted managed-agents platform —
is **egress substitution**: the sandbox sees an opaque placeholder; the
real secret is added to outbound requests by a gateway-side proxy, scoped
to allowed hosts. Even a prompt-injected agent cannot exfiltrate what it
never has.

Staged delivery:

- **3.1 MCP credentials gateway-side (S–M).** MCP server auth headers are
  already consumed gateway-side (`MCP_AUTH_*`/`MCP_HEADER_*` never enter
  the container env — driver.ts filters them). Formalize this as the
  credential rule, add OAuth refresh (`mcp_oauth` credential type with
  refresh-token grant) on top of the existing `mcp-auth.ts`.
- **3.2 Egress proxy for env-var credentials (L).** A per-session HTTP(S)
  proxy (gateway-side or sidecar) that substitutes
  `environment_variable` credentials into outbound requests for
  `allowed_hosts` only; the container env gets a placeholder. Wire via
  `HTTP_PROXY`/`HTTPS_PROXY` in the turn env. Per-provider network
  plumbing is the risk — ship behind a setting, docker provider first.
- **3.3 Credential API parity (S).** Vault credential objects with
  write-only secrets, `networking.allowed_hosts`, archive-to-rotate
  semantics (the `credentials` handlers already exist — align shapes).

*Acceptance:* a test agent instructed to `echo $SECRET` prints the
placeholder; the same secret reaches the allowed host in an e2e proxy
test. *Size: M overall, 3.2 is the long pole. Independent of Phases 1–2.*

---

## Phase 4 — Work semantics: finish what's started

- **4.1 Outcomes hardening (S).** The grader loop exists. Close parity
  gaps: rubric-by-file-id, `max_iterations` bounds, interrupted result,
  surface `outcome_evaluations` in the client (`session.defineOutcome()`
  + `TurnResult`-style `OutcomeResult`). Document it — it's a flagship
  feature nobody can see.
- **4.2 Scheduled deployments (M).** New resource: `deployments`
  (agent + environment + initial events + cron schedule + timezone) and
  `deployment_runs` (per-firing record with `session_id` or typed error).
  Scheduler loop lives on the runtime (1.3) next to the sweeper; fires
  `SessionService.create` + initial events; pause/unpause/archive;
  manual run endpoint. DST rule: literal wall-clock match.
- **4.3 Threads parity (S–M).** Per-thread event streams exist; align
  list/retrieve/archive + cross-posted confirmations with the compat
  surface and expose threads on the client.

*Acceptance:* a cron deployment fires a session in an e2e test with a
fake clock; `client.sessions.open(id).defineOutcome({...})` resolves with
a grader verdict. *Size: M. 4.2 depends on 1.3.*

---

## Phase 5 — Reach: embed anywhere, render anywhere

- **5.1 Lite execution tier (M–L).** `LiteExecutor` on the 2.3 seam:
  sessions without container acquisition for tool-light agents —
  instant start, zero infrastructure, the embedded-library story
  completed. Explicitly out of scope until 2.3 lands.
- **5.2 UI stream interop (M).** An endpoint translating a session's
  event stream into the de-facto chat-frontend stream protocol, derived
  from the 1.1 registry; optional `@agentstep/react` hooks package.
  Lets any existing chat UI point at any harness through the gateway.
- **5.3 Packaging (S).** The package rename
  (`@agentstep/agent-sdk` → `@agentstep/sdk`) is unblocked by the
  compatibility contract and cheapest done early; subpath exports
  `/client`, `/events`, `/services`; a docs quickstart built around the
  ten-line embed script.

---

## Sequencing

```
1.1 events ──► 1.2 services ──► 1.3 runtime ──► 2.x pipeline/hooks ──► 5.1 lite
     │                                              │
     └────────► 5.2 ui-stream                       └─► 4.2 deployments
3.x egress secrets (independent track)
4.1 outcomes, 4.3 threads, 5.3 packaging (anytime, S)
```

Recommended order of attack: **1.1 → 4.1 → 1.2 → 1.3 → 2.x → 4.2 → 3.2 →
5.x**, with 3.1 and 5.3 slotted early as small wins. Rationale: 1.1 is
days of work with immediate product-wide payoff; 4.1 is near-free flagship
polish; 1.2/1.3 are the structural core everything else stands on; hooks
(2.2) and deployments (4.2) are the two most differentiating features and
both want the core in place; the egress proxy (3.2) is high-value but
self-contained, so it can run as a parallel track.

## Risks

- **1.2 scope creep** — mitigate by one-resource-per-PR and freezing the
  handler test suite as the contract.
- **CLI bundle size** — the single-file esbuild bundle must not balloon;
  registry and services are tree-shakeable, verify per phase.
- **Hosted-product coupling** — the separate product repo consumes
  handlers directly. Its *wire* behavior is protected by the contract,
  but TS signature changes need a coordinated bump (it's our repo, so
  this is scheduling, not a constraint — flag each phase's breaking
  changes in the release notes it pins against).
- **Egress proxy portability** — eleven providers won't all support proxy
  env vars identically; ship provider-gated with docker first and a
  documented fallback (current env-var injection) elsewhere.
