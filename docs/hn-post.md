# Show HN post

**Title:** Show HN: AgentStep Gateway – self-hosted, drop-in replacement for Claude Managed Agents

**URL:** https://github.com/agentstep/gateway

---

Hi HN,

When Anthropic shipped the Managed Agents API in April, I thought the abstraction was right — agents, environments, stateful sessions, SSE event streams — but I wanted to run it myself: on my own sandboxes, with my own data retention, and not only with Claude.

So I built a self-hosted implementation of the same API. You point the official Anthropic SDK at your gateway URL (change `base_url`, nothing else) and agents/sessions/events/vaults/files/memory all answer locally. State lives in SQLite on your disk.

The part that turned out to be the most fun: the engine behind the API is pluggable. The gateway drives coding-agent CLIs as the execution harness — `claude -p`, OpenAI's `codex exec`, Gemini CLI, OpenCode, Factory's droid, and pi — each with a translator that normalizes their NDJSON streams into one event schema. So the same `sessions.create` call can run Claude, GPT, Gemini, or (via Ollama through Codex/OpenCode) a fully local model. Engine is inferred from the model ID. Sandboxes are pluggable too: Docker/Podman locally, or E2B/Fly/Modal/Vercel/Daytona/Cloudflare, behind one provider interface with lazy imports.

A few design decisions that might be interesting:

- The CLI and the HTTP server execute the same handler functions — the CLI constructs `Request` objects and calls them directly, so there's exactly one code path and the ~1,400 tests cover both.
- Per-session mutations are serialized through a FIFO promise-chain actor; the event log is append-only with the DB authoritative and an EventEmitter as live tail.
- There's a hybrid mode: mark an environment `provider: "anthropic"` and the gateway syncs your agent config to the real hosted API (idempotent via config hash), proxies the session, and tees every SSE event back into your local log. Vault *shapes* sync; secret values never leave your box. So you can use Anthropic's hosted sandboxes today and move in-house later without client changes.
- Whole thing bundles to a single `gateway.js` via esbuild, with the React console inlined as one HTML file.

Honest limitations: it tracks a moving beta, so compatibility is a treadmill. Mid-turn custom-tool re-entry only works on the Claude engine (the other CLIs can't resume a turn). Multi-agent delegation is depth-1, not the parallel orchestration the hosted product does. The Google Interactions surface is partial. And the dreaming/outcomes features are reimplementations of the concepts, not wire-compatible ports.

On sustainability, since HN will find it in the source anyway: there's a community/enterprise split (tenancy, budgets, Redis rate limiting are license-gated). The gate is a handful of `requireFeature()` calls and the comment above them says "anyone can fork and remove them — the gate is a social contract, not DRM." That's the actual plan: free core, paid governance features, hosted version at agentstep.com.

Try it: `npx @agentstep/gateway quickstart` (or `docker compose up`).

I'd especially love feedback from anyone who's hit the data-retention wall with the hosted agent platforms, and from anyone who thinks normalizing six agent CLIs into one event schema is doomed — you may be right, and I'd like to hear why before the seventh.
