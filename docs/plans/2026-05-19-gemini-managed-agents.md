# Research — Managed Agents in the Gemini API

**Date:** 2026-05-19
**Status:** Research note (no code changes)
**Trigger:** https://blog.google/innovation-and-ai/technology/developers-tools/managed-agents-gemini-api/

> **Caveat on sourcing:** Google's developer docs (`ai.google.dev`, `docs.cloud.google.com`)
> returned HTTP 403 to direct fetches from this environment. The technical details below
> are reconstructed from the Google blog post and secondary write-ups (see Sources). Exact
> field names and the Agents API resource shape should be re-verified against the official
> docs before any implementation work.

---

## 1. What Google announced

At Google I/O 2026 (2026-05-19) Google launched **Managed Agents in the Gemini API**:
with a single API call you spin up an agent that **reasons, uses tools, and executes code
in an isolated, ephemeral Linux sandbox hosted by Google**. The developer no longer writes
orchestration code or runs their own sandbox.

- Powered by the new **Antigravity agent**, built on **Gemini 3.5 Flash**, using the same
  harness as the Antigravity IDE.
- Exposed through the new **Interactions API** and Google AI Studio.
- **Preview** in the Gemini API. Enterprise: added to the Gemini Enterprise Agent Platform
  in **private preview**.
- Google is "opening the harness" — developers can register their own **custom managed
  agents** by supplying instructions + skills as markdown files.

This is, in effect, **Google's analog of Anthropic's Managed Agents API** — and the gateway
already integrates the Anthropic version (see §4). That parallel is the main reason this
announcement matters to this repo.

---

## 2. Technical surface

### 2.1 Interactions API

A new unified REST interface for both models and agents — Google's recommended primitive
for new agentic projects (server-side state, multi-modal, multi-turn).

- **Single endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- **Auth header:** `x-goog-api-key: $GEMINI_API_KEY`
- **Versioning header:** `Api-Revision` (e.g. `2026-05-20`)

Observed request fields:

| Field | Meaning |
|---|---|
| `agent` | Named managed agent, e.g. `antigravity-preview-05-2026`, `deep-research-preview-04-2026`. Mutually distinct from a plain `model` request. |
| `input` | The prompt — a string, a `Content`, an array of `Content`, or an array of `Steps`. |
| `agent_config` | Per-agent-type config (e.g. `type`, `thinking_summaries`, `collaborative_planning`). |
| `environment` | The sandbox — `"remote"` for a fresh managed sandbox, or a structured config / a reused environment id. |
| `tools` | Tool list, e.g. `[{"type":"google_search"},{"type":"url_context"}]`. Agents default to `code_execution`, `google_search`, `url_context`. |
| `store` | Server-side history. Default `true`; `store=false` for stateless. |
| `previous_interaction_id` | Continues a conversation server-side without resending history. |
| `background` | Long-running / async execution. |

Example (Antigravity agent):

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Api-Revision: 2026-05-20" \
  -d '{
    "agent": "antigravity-preview-05-2026",
    "input": "Search for the latest AI research papers on reasoning and summarize them.",
    "environment": "remote",
    "tools": [{"type": "google_search"}, {"type": "url_context"}]
  }'
```

An Antigravity interaction is **not** a single completion — one request triggers an
autonomous loop of reasoning → tool calls → code execution → file management. It can
accumulate large token counts (reportedly 3–5M tokens / ~$5 for complex workflows).

### 2.2 Environments (the managed sandbox)

- Each interaction **creates or receives an `environment`**; the returned environment id is
  reused in follow-up calls to **resume the session with files and state intact**.
- The `environment` parameter accepts multiple forms; sources can be **Git, GCS, or inline**,
  with configurable **networking, lifecycle, and resource limits**.
- The **Code Execution** sandbox: secure/isolated, limited filesystem, **no network access**
  for the code tool itself, **Python + JavaScript** only. Execution state (memory) persists
  up to **14 days** (configurable TTL).

### 2.3 Custom managed agents (Agents API)

- Define behavior in markdown — **`AGENTS.md`** (instructions) and **`SKILL.md`** (skills).
  `SKILL.md` frontmatter must lead with `name:` and `description:`.
- Filesystem-native: mount `AGENTS.md` and skills under `.agents/skills/` (Antigravity also
  reads `~/.gemini/antigravity/skills/<name>/SKILL.md`), **or** pass config inline at
  interaction time.
- Workflow: iterate on config inline, then **save it as a managed agent** via the **Agents
  API** (create/manage agent configs + sandbox environments with mounted sources such as
  skills and artifacts). The **Interactions API** is then used to run the saved agent.

### 2.4 Pricing

- Gemini 3.5 Flash: **$1.50 / 1M input**, **$9.00 / 1M output**, **$0.15 / 1M cached input**.
- **Environment compute (CPU, memory, sandbox) is not billed during the preview** — you pay
  only for model tokens.

---

## 3. Relation to the gateway's existing `gemini` backend

The gateway already has a Gemini integration — but a fundamentally different one.

`packages/agent-sdk/src/backends/gemini/` drives the **`@google/gemini-cli`** package:

- `setup.ts` — `npm install -g @google/gemini-cli` on a freshly-created sandbox container.
- `args.ts` — builds `gemini --prompt <text> --output-format stream-json --yolo [--resume …] [--model …]`.
- `translator.ts` — parses the CLI's stream-json NDJSON (`init`/`message`/`tool_use`/
  `tool_result`/`result`) into Managed Agents events.
- `index.ts` — **rejects `toolResults` re-entry** ("gemini backend does not support
  user.custom_tool_result re-entry in v1"), because the CLI has no stream-json input mode.

So today, "gemini" in the gateway means **the Gemini CLI running inside a gateway-managed
sandbox** (sprites / docker / e2b / …). Google's announcement is the opposite model:
**Google runs the agent and the sandbox**; the gateway would only proxy.

These two are complementary, not in conflict:

| | Existing `gemini` backend | Gemini Managed Agents (new) |
|---|---|---|
| Who runs the sandbox | Gateway provider (sprites/docker/…) | Google |
| Engine | `@google/gemini-cli` | Antigravity agent (Gemini 3.5 Flash) |
| Transport | NDJSON over `provider.startExec` | REST `/v1/interactions` |
| Session resume | `--resume <session_id>` | `previous_interaction_id` / `environment` id |
| Custom tool re-entry | Not supported | Plausible (Interactions API has tool calls / HITL) |
| Code execution sandbox | Whatever the container image has | Google-hosted, Python/JS, 14-day TTL |

---

## 4. The precedent already in the repo: the `anthropic` managed-agents path

The gateway **already integrates a vendor-hosted managed-agents product** — Anthropic's —
and that integration is the blueprint for a Gemini equivalent:

- `providers/anthropic.ts` — a **no-op `ContainerProvider`**: `create`/`delete`/`list` do
  nothing, `exec`/`startExec` throw. Exists only so the registry resolves and availability
  checks (just `ANTHROPIC_API_KEY` presence) work.
- `sync/anthropic.ts` — at session-creation time, syncs the local agent / vault / environment
  config to Anthropic's MA API (`POST/PUT api.anthropic.com`, header
  `anthropic-beta: managed-agents-2026-04-01`). Idempotent via a `config_hash`.
- `proxy/forward.ts` — `forwardToAnthropic()`: swaps the caller's local API key for the
  server's `ANTHROPIC_API_KEY`, pipes JSON **and SSE streams** straight back. "No sandbox,
  no CLI, no translator. Anthropic owns the resource IDs."
- `db/sync.ts` + `db/proxy.ts` — sync-state and proxied-session bookkeeping.
- Environment type `cloud` (vs `self_hosted`) selects this path.

A Gemini managed-agents integration would mirror this almost field-for-field.

---

## 5. Integration options for the gateway

Three viable shapes, in increasing order of effort:

### Option A — Do nothing yet (recommended short term)
It's a **preview** API with docs we couldn't even fetch, unstable revision headers
(`Api-Revision: 2026-05-20`), and preview-only pricing. The existing CLI-based `gemini`
backend already gives users Gemini. Track it; revisit when it leaves preview.

### Option B — A Gemini managed-agents proxy provider (the Anthropic-parallel)
Add a `google` (or `gemini-managed`) provider mirroring `anthropic`:

- New no-op provider in `providers/` + `ProviderName` union in `providers/types.ts`.
- `sync/google.ts` — map the local agent's `system` + `skills` into `AGENTS.md` / `SKILL.md`
  and register a custom managed agent via the Agents API.
- `proxy/forward.ts` equivalent — `forwardToGemini()` targeting
  `generativelanguage.googleapis.com/v1beta/interactions`, swapping in the server
  `GEMINI_API_KEY` (already in config as `cfg.geminiApiKey`).
- Session ↔ interaction mapping: the gateway's `backendSessionId` becomes
  `previous_interaction_id` (or the `environment` id) for resume.

**Key friction vs. the Anthropic path:** Anthropic's MA API exposes agents/sessions/events
resources that line up with the gateway's own resource model, so `forward.ts` is a near-pass-
through. Gemini collapses everything into one `/interactions` endpoint with
`previous_interaction_id` chaining — so a pure proxy is less clean; the gateway's
session/event model has to be mapped onto interaction chains, and SSE/`background` responses
translated into the gateway's event schema (the Anthropic path skips translators; this one
probably can't entirely).

### Option C — A first-class `Backend` (not a provider)
Implement `Backend` so a managed-Gemini turn produces gateway events the normal way. This
fits the `Translator` abstraction but fights the `buildTurn → argv/env/stdin → provider.exec`
contract, which assumes a local process. Not recommended — the proxy shape (Option B) is the
right seam, as the `anthropic` integration already proved.

---

## 6. Open questions / to verify against official docs

1. **Agents API resource shape** — exact create/list/update/delete endpoints, and the agent
   config JSON (does it take `display_name`, `instructions`, inline `skills`, `sources`?).
2. **Interactions response & streaming** — response envelope, SSE event types, and how
   `background: true` results are polled/retrieved.
3. **Custom tool calls / HITL** — can a managed agent surface a client-side tool call and
   resume on a result? If so, the managed path could support the `toolResults` re-entry the
   CLI backend rejects today.
4. **Environment lifecycle** — billing, eviction, the 14-day TTL, and how reused environment
   ids interact with the gateway's session archival.
5. **API-key passthrough** — whether `generativelanguage.googleapis.com` keys could ride the
   gateway's existing passthrough mechanism (today scoped to `sk-ant-api*` shapes only).
6. **Region pricing** — non-global Gemini 3.5 Flash is ~10% higher; relevant if surfaced in
   the gateway's metrics/cost reporting.

---

## 7. Recommendation

Hold at **Option A** until the API exits preview and the docs are reachable. When it
stabilizes, **Option B** is the natural fit — the `anthropic` provider + `sync/` + `proxy/`
trio is a proven template, and the env-type split (`cloud` vs `self_hosted`) already gives
the gateway a place to slot a second managed-agents vendor. Budget extra time for the
`/interactions`-to-session mapping, which is messier than the Anthropic pass-through.

---

## Sources

- [Introducing Managed Agents in the Gemini API](https://blog.google/innovation-and-ai/technology/developers-tools/managed-agents-gemini-api/)
- [Google AI Studio's Interactions API for Gemini models and agents](https://blog.google/innovation-and-ai/technology/developers-tools/interactions-api/)
- [I/O 2026 developer highlights: Antigravity, Gemini API, AI Studio](https://blog.google/innovation-and-ai/technology/developers-tools/google-io-2026-developer-highlights/)
- [Antigravity Agent | Gemini API | Google AI for Developers](https://ai.google.dev/gemini-api/docs/antigravity-agent)
- [Agents Overview | Gemini API | Google AI for Developers](https://ai.google.dev/gemini-api/docs/agents)
- [Gemini Interactions API | Gemini API | Google AI for Developers](https://ai.google.dev/api/interactions-api)
- [Gemini Enterprise Agent Platform — Code Execution overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/code-execution-overview)
- [Google Launches Antigravity 2.0 at I/O 2026 — MarkTechPost](https://www.marktechpost.com/2026/05/19/google-launches-antigravity-2-0-at-i-o-2026-a-standalone-agent-first-platform-with-cli-sdk-managed-execution-and-enterprise-support/)
- [Gemini 3.5 Flash: Benchmarks, Pricing, and Complete Specs — llm-stats](https://llm-stats.com/blog/research/gemini-3.5-flash-launch)
