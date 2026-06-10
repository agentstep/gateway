# AgentStep Gateway

> ## Same API. Your infrastructure. Any agent engine.
>
> The open-source, self-hosted gateway for the Claude Managed Agents API — run autonomous agents on Claude, GPT, Gemini, or fully-local models, in sandboxes you control, with state that never leaves your network.

```bash
npx @agentstep/gateway quickstart
```

*30 seconds to a running gateway, a seeded API key, and your first agent session.*

[Get Started](#quickstart) · [GitHub](https://github.com/agentstep/gateway) · [Docs](#) · [Hosted at agentstep.com](https://agentstep.com)

---

## The agent platform API is here. The lock-in doesn't have to be.

In April 2026, Anthropic shipped **Claude Managed Agents** — and got the abstraction right. Agents, environments, stateful sessions, event streams: this is what production agent infrastructure looks like. Google followed with **Gemini Managed Agents**. The industry has converged on a shape.

But the hosted versions come with trade-offs:

- **Your data lives on their servers.** Session history, sandbox filesystems, and conversation state are stored vendor-side — Claude Managed Agents is explicitly ineligible for Zero Data Retention and HIPAA BAA coverage.
- **One vendor, one model family.** Claude agents run Claude. Gemini agents run Gemini. Your API contract is welded to a model roadmap.
- **Their infrastructure, their rules.** Sandbox lifecycles, network egress, compute sizing, and retention windows are someone else's decisions.

**AgentStep Gateway keeps the API and removes the trade-offs.** Point any Anthropic SDK at your gateway URL and everything works — except now the engine, the sandbox, and the data are yours.

---

## One API, six engines

The same `POST /v1/sessions` call can run any of these behind it. Engine is auto-inferred from the model ID — `claude-*`, `gpt-*`, `gemini-*` — or set explicitly.

| Engine | Powered by | Models |
|---|---|---|
| **Claude** | Claude Code (`claude -p`) | Opus 4.8, Sonnet 4.6, Haiku 4.5 |
| **Codex** | OpenAI Codex CLI | GPT-5.4, GPT-5.4-mini, Codex |
| **Gemini** | Gemini CLI | Gemini 3.1 Pro/Flash, 2.5 |
| **OpenCode** | sst/opencode | Anthropic, OpenAI, and more |
| **Factory** | Factory `droid` | Multi-provider router |
| **Pi** | pi.dev | Anthropic, OpenAI, Google |
| **Ollama** | via Codex/OpenCode | qwen3, llama3.3, gemma4 — fully offline |

Swap a model ID, swap the brain. No client changes.

---

## Any sandbox, from laptop to fleet

Thirteen container providers behind one interface. Set a default, or pick per-environment.

**Local:** Docker · Podman · Apple Container · Apple Firecracker
**Cloud:** Sprites (default) · E2B · Fly.io · Modal · Vercel · Daytona · Cloudflare *(beta)*
**Hosted:** Anthropic's own sandboxes, via sync-and-proxy

```bash
gateway environments create --name prod --provider fly
gateway environments create --name dev  --provider docker
```

Each session gets its own isolated sandbox, lazily acquired on first turn. Concurrency limits enforced globally and per-environment.

---

## Three ways to run it

### 1 · Local mode — full sovereignty
Everything self-hosted: agents in local SQLite, sessions in your containers, vault secrets AES-256-GCM encrypted on your disk. Pair with Ollama and run agents with **zero external network calls**.

### 2 · Sync-and-proxy — hybrid
Create an environment with `provider: "anthropic"` and the gateway syncs your agent config up to the real Managed Agents API, proxies session traffic, and tees every event back into your local bus. Anthropic runs the sandbox; **you keep config-as-source-of-truth, full observability, and your secrets** (vault shapes sync — values never leave). Migrate workloads in-house later without changing a line of client code.

### 3 · Passthrough — one URL for everyone
Opt-in: callers presenting real `sk-ant-api*` keys are transparently forwarded to Anthropic with zero local writes. Your gateway URL serves both populations.

---

## Quickstart

```bash
# Interactive setup — picks a provider, creates an agent, starts a chat
npx @agentstep/gateway quickstart

# Or piece by piece
npm install -g @agentstep/gateway
gateway serve                                                  # API on :4000
gateway agents create --name reviewer --model claude-sonnet-4-6
gateway environments create --name dev --provider docker
gateway sessions create --agent <agent_id> --environment <env_id>
gateway chat <session_id>
```

It speaks the wire format your SDK already knows:

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:4000/anthropic",
    api_key="ask-...",  # your gateway key
)

agent = client.beta.agents.create(
    name="reviewer",
    model="gpt-5.4",          # yes — GPT through the Anthropic SDK
    system="You review pull requests.",
)
session = client.beta.sessions.create(agent=agent.id, environment_id=env.id)
```

Docker, if you prefer:

```bash
docker compose up
```

---

## The full Managed Agents surface — plus the parts the betas don't expose

### Compatible primitives
**Agents** (versions, archive) · **Environments** · **Sessions** (SSE streaming, interrupt, steer) · **Events** · **Vaults** (per-user credentials, encrypted at rest) · **Files** · **Threads** · **Memory stores** · **User profiles** · **MCP OAuth credentials** · **Skills** — all under `/anthropic/v1/*`, with a Google Interactions surface at `/google/v1beta/*`.

### Intelligence features, reimplemented in the open
- **Dreaming** — a scheduled review of recent sessions that curates your memory stores: recurring mistakes, converged workflows, shared preferences.
- **Outcomes** — define a rubric; an independent grader evaluates output in its own context and sends the agent back for revision until it's right.
- **Multi-agent** — agents can `spawn_agent` to delegate subtasks to specialists with their own model, prompt, and tools.

### Enterprise plumbing, built in
- **Multi-tenancy** — isolated agents, sessions, environments, vaults, and keys per tenant; global admin / tenant admin / tenant user roles.
- **Audit log** — append-only ledger of every admin operation.
- **API key management** — issue, mask, revoke; per-key analytics.
- **Upstream key pool** — centrally manage Anthropic, OpenAI, and Gemini keys; agents never see them.
- **Webhooks** — per-agent HMAC signatures (`X-AgentStep-Signature`).
- **Rate limiting** — in-process or Redis-backed for multi-replica deployments.
- **Metrics & traces** — latency histograms, 5xx error rates, OTLP export, full session traces.

### A real console, included
The CLI bundle ships with an embedded React dashboard: session browser with **replay**, live chat playground, agent and environment editors, vault management, and analytics. One file, no separate deploy.

---

## How it compares

| | Claude Managed Agents | Gemini Managed Agents | **AgentStep Gateway** |
|---|---|---|---|
| Model families | Claude only | Gemini only | **Claude + GPT + Gemini + local** |
| Where tools run | Anthropic cloud, or your workers | Google cloud only | **Anywhere — 13 providers** |
| Session state lives | Anthropic servers | Google servers (7-day expiry) | **Your disk, forever** |
| ZDR / HIPAA path | Not eligible | Google-hosted | **Your controls** |
| Dreaming / outcomes / multi-agent | ✅ / ✅ / ✅ | — | ✅ / ✅ / ✅ |
| Multi-tenancy, audit, key management | Console-level | GCP-level | **First-class, in the API** |
| Cost | Tokens + $0.08/session-hour | Tokens (preview) | **Free OSS + your compute** |
| Hybrid with hosted vendor | — | — | **✅ sync-and-proxy + passthrough** |

*Both hosted products are excellent — that's the point. The gateway speaks their language so you're never choosing between the ecosystem and your requirements.*

---

## Pricing

### Community — Free, forever
Everything a solo developer or a team of twenty needs. Apache-licensed, no telemetry, no phone-home.
- All six engines, all thirteen providers
- Full Managed Agents API surface, vaults, memory, dreaming, outcomes, multi-agent
- Embedded web console + CLI
- Up to 20 API keys · 7-day audit retention

### Enterprise — License key
For platform teams running the gateway as shared infrastructure.
- **Multi-tenancy** with role-based isolation
- **Budgets** and **per-key analytics**
- **Upstream key pool** across providers
- **Redis rate limiting** for replicas
- Unlimited keys · unlimited audit retention
- Validated offline-tolerant licensing — no per-request phone-home

### Hosted — agentstep.com
Don't want to run it? We do. Same API, our infrastructure.

---

## FAQ

**Is this affiliated with Anthropic or Google?**
No. AgentStep Gateway is an independent open-source implementation of compatible API surfaces. It also interoperates *with* the official hosted products via sync-and-proxy and passthrough modes.

**Do my prompts or secrets ever leave my infrastructure?**
In local mode, never. In sync-and-proxy mode, session traffic flows to Anthropic (that's the point) but vault secret **values** stay local — only configuration shapes sync.

**What does "same API" actually mean?**
The official Anthropic SDKs (Python, TypeScript, Go, …) work against the gateway by changing only `base_url`. Agents, sessions, events, SSE streams, vaults — same routes, same payloads, same beta semantics.

**How battle-tested is it?**
1,400+ tests across the API surface, all six engine translators, vault crypto, metrics, and the CLI. The CLI and server execute the *same handler functions* — there is one code path.

**Can I really run this with no cloud at all?**
Yes: Docker or Podman for sandboxes, Ollama for models. Air-gapped agents are a supported configuration, not a hack.

**What's the catch with the license?**
The enterprise gate is a few `requireFeature()` calls — anyone can fork and remove them. We say so in the source. The product is the shipping velocity, not the lock.

---

## Start now

```bash
npx @agentstep/gateway quickstart
```

**AgentStep Gateway** — the Managed Agents API, unmanaged.

[GitHub](https://github.com/agentstep/gateway) · [Docs](#) · [agentstep.com](https://agentstep.com) · MIT/Apache OSS core
