# AgentStep Gateway

> ## A drop-in replacement for the Claude Managed Agents API. With full control.
>
> AgentStep Gateway is an open-source, self-hosted implementation of the Claude Managed Agents API. Change one line — the `base_url` — and your agents keep working exactly as they do today. Everything else changes hands: the models, the infrastructure, and the data are now yours.

```bash
npx @agentstep/gateway quickstart
```

*Thirty seconds from this command to your first running agent.*

**[Get started →](#quickstart)**

<!-- HERO VISUAL: 30-second terminal recording of `quickstart` → first agent reply.
     Below it: screenshot of the session-replay dashboard. Show, don't tell. -->

---

## Agents are ready for real work. Your requirements didn't go away.

In 2026, running an AI agent stopped being a research project. Anthropic's Claude Managed Agents and Google's Gemini Managed Agents proved what production agent infrastructure looks like: an agent, an environment, a long-running session, a stream of events. It works, and it's the right shape.

Now comes the part where you bring agents to *your* work — the codebase under NDA, the customer data with residency rules, the model budget that changes quarter to quarter, the security review that asks "where exactly does the session history live?"

Until now the choice was binary: take the hosted platform as-is, or walk away from the API and build your own harness. AgentStep Gateway removes the choice. **It's a drop-in replacement — same SDK, same routes, same streaming events — that hands you full control of everything behind the API:**

- **Your data stays home.** Sessions, conversation history, sandbox filesystems, and secrets are stored on your disk, under your existing security and compliance controls. Nothing is retained anywhere you don't operate.
- **Your choice of mind.** The same agent definition can run on Claude, GPT, Gemini, or an open model on your own hardware. When your needs change, you change a model ID — not your architecture.
- **Your infrastructure, your rules.** Sandboxes run where you say: the Docker daemon on a laptop, your Kubernetes-adjacent cloud of choice, or — when it's the right tool — Anthropic's own hosted sandboxes, connected through the gateway.

No fear, no lock-in lecture. The hosted platforms are excellent, and the gateway works *with* them. This is simply what it looks like when the standard API meets your requirements.

---

## "Drop-in" is a one-line claim. Here's the line.

The official Anthropic SDK, unchanged, creating a **GPT** agent:

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:4000/anthropic",
    api_key="ck_...",                 # your gateway key
)

agent = client.beta.agents.create(
    name="reviewer",
    model="gpt-5.4",                  # or claude-opus-4-8, gemini-3.1-pro,
    system="You review pull requests.",  # or llama3.3 running on your GPU
)
env = client.beta.environments.create(
    name="dev", config={"type": "self_hosted", "provider": "docker"},
)
session = client.beta.sessions.create(agent=agent.id, environment_id=env.id)
```

Nothing about your code knows the platform changed. Agents, environments, sessions, events, vaults, files, memory — the full Managed Agents surface answers at your URL. What changed is who's in control: the model, the sandbox, and the data are now decisions you own.

---

## Quickstart

```bash
# One command: picks a provider, creates an agent, opens a chat
npx @agentstep/gateway quickstart
```

Or step by step:

```bash
npm install -g @agentstep/gateway
gateway serve                                                   # API on :4000
gateway agents create --name reviewer --model claude-sonnet-4-6
gateway environments create --name dev --provider docker
gateway sessions create --agent <agent_id> --environment <env_id>
gateway chat <session_id>
```

Prefer containers? `docker compose up`.

Everything the CLI does, the bundled web console does too — create agents, watch sessions live, replay any conversation event by event.

<!-- VISUAL: console screenshot — session replay view -->

---

## What you can rely on

### Freedom to choose the model — today and next quarter
One agent definition runs on **Claude, GPT, Gemini, OpenCode, Factory, or Pi**, and on local models through Ollama. The gateway reads the model ID and routes to the right engine automatically. The practical meaning: a model decision is a one-line change, never a migration.

### Sandboxes wherever your work is
Agents execute in isolated sandboxes on whichever substrate fits the job — Docker or Podman on the machine in front of you; E2B, Fly.io, Modal, Vercel, Daytona, or Cloudflare in the cloud; Apple's container runtimes on a Mac. Develop on a laptop, deploy to a fleet, same API call.

### A hybrid path, not a leap
Connecting an environment to Anthropic syncs your agent configuration to the hosted Claude Managed Agents service and streams every event back into your local record. You get Anthropic's managed sandboxes *and* a complete copy of everything at home — your configuration stays the source of truth, and your secret values never sync. Workloads can move in-house later without touching client code. There's even a passthrough mode so colleagues with Anthropic API keys can use your gateway URL as-is.

### Agents that get better at their job
- **Outcomes** — describe what success looks like; an independent grader checks the agent's work and sends it back until it's right.
- **Dreaming** — the gateway periodically reviews past sessions and curates the agent's memory: recurring mistakes, proven workflows, your team's preferences.
- **Delegation** — an agent can hand a subtask to a specialist with its own model and tools.

### Credentials that never wander
Per-user vaults, encrypted with AES-256-GCM, on your disk. Agents use credentials; they don't see your provider keys — those live in a central pool you control.

### Built for the team running it
Multi-tenant isolation with admin and user roles. An append-only audit log of every administrative action. API key issuance and revocation. Webhooks with signed payloads. Metrics, traces, and OpenTelemetry export. These aren't console afterthoughts — they're API-first features you can automate.

---

## Trusted by builders

<!-- PROOF SECTION — fill before launch. Until customer logos exist, use:
     ⭐ GitHub stars · contributors · "X,000 sessions replayed this month"
     One developer quote beats ten adjectives. -->

**1,100+ automated tests** cover the full API surface, every engine, and the vault cryptography. The CLI and the server run the *same* code — what you test locally is what serves production.

---

## How it fits alongside the hosted platforms

| | Claude Managed Agents | Gemini Managed Agents | AgentStep Gateway |
|---|---|---|---|
| Best when | You want zero ops and the newest Claude harness | You want Google's prebuilt agents | You need control over models, infrastructure, or data |
| Models | Claude | Gemini | Claude, GPT, Gemini, local |
| Where agents run | Anthropic cloud or your workers | Google cloud | Anywhere you choose |
| Session data lives | With Anthropic | With Google | With you |
| Works together? | ✅ via gateway sync mode | — | It *is* the connector |

The honest read: if a hosted platform meets your requirements, use it — they're very good. The gateway is for when your requirements say *and also: our data, our models, our infrastructure.* Many teams will want both, which is why the gateway connects to them rather than competing with them.

---

## Pricing

### Community — free, forever
Everything an individual or a small team needs, with no strings — and no telemetry unless you opt in: every engine, every sandbox provider, the full API, vaults, outcomes, dreaming, the web console, and the CLI. Up to 20 API keys and a week of audit history.

### Enterprise — one license key
For platform teams running the gateway as shared, governed infrastructure: multi-tenancy with roles, budgets, per-key analytics, a cross-provider key pool, Redis-backed rate limiting for replicas, and unlimited keys and audit retention. Licensing validates offline — the gateway never phones home per request.

### Hosted — agentstep.com
The same API, run by us. For teams who want the gateway without operating it.

*A note on the license, because you'll find it in the source anyway: the enterprise gate is a handful of checks any fork could remove. We ship it that way on purpose. You'll pay us because the product keeps earning it, not because we locked the door.*

---

## Questions people actually ask

**Is this an Anthropic or Google product?**
No. AgentStep Gateway is independent open source that implements compatible APIs — and connects to the official hosted services when you want them.

**Does anything leave my infrastructure?**
In local mode, nothing — pair Docker with Ollama and the gateway runs with no external calls at all. In hybrid mode, session traffic flows to Anthropic by design, but your secret values and your event record stay home.

**Will my existing code work?**
If it uses an Anthropic SDK, yes — change the `base_url` and keep going.

**Can it satisfy our compliance requirements?**
The gateway doesn't certify anything on your behalf — what it does is keep agent data inside your boundary, so *your existing* controls, audits, and policies apply. For many teams, that's the difference between "blocked by review" and "approved."

**What if Anthropic's API changes?**
Tracking the hosted betas is the core of the project, and the test suite is the contract. The hybrid modes mean you're never stranded on either side.

---

## Start now

```bash
npx @agentstep/gateway quickstart
```

**Drop it in. Take control.**

[GitHub](https://github.com/agentstep/gateway) · [Documentation](https://github.com/agentstep/gateway/tree/main/docs) · [agentstep.com](https://agentstep.com) · Apache-2.0

*Claude is a trademark of Anthropic, PBC; Gemini is a trademark of Google LLC. Names are used solely to identify API compatibility. AgentStep is an independent project — not affiliated with or endorsed by Anthropic or Google.*
