# Cloudflare Containers Provider

> Goal: Add Cloudflare as a 12th sandbox provider, using Cloudflare
> Containers for agent execution.

## Context

Cloudflare Containers (GA May 2026) are full Linux containers running
on Cloudflare's edge network. Unlike Workers (which have CPU/memory
limits and can't run native binaries), Containers support Node.js,
Claude Code, Gemini CLI, etc. — same as our Docker/sprites providers.

This gives users global edge deployment of agent sandboxes with no
server management.

## How Cloudflare Containers work

- Full Linux containers (not V8 isolates)
- Deployed via `wrangler` or the Containers API
- Support TCP/HTTP networking, persistent storage, SSH
- Run in Cloudflare's edge locations (auto-placed near traffic)
- Billed per-second of container uptime
- Can be started/stopped programmatically via the API
- Accessible via Cloudflare Tunnel or direct HTTP

## Provider interface mapping

| ContainerProvider method | Cloudflare implementation |
|--------------------------|---------------------------|
| `create({ name })` | `POST /containers` — create container with base image |
| `delete(name)` | `DELETE /containers/:id` — stop and remove |
| `list()` | `GET /containers` — list running containers |
| `exec(name, argv)` | HTTP exec endpoint on the container (like sprites) |
| `startExec(name, opts)` | Streaming HTTP exec (NDJSON response) |

## Architecture

Same pattern as sprites provider: HTTP-based exec. The container
exposes an HTTP endpoint, we send exec commands to it. No SSH needed.

```
Gateway → Cloudflare Containers API → Container (runs Claude Code/Gemini CLI)
```

Auth: Cloudflare API token with Containers permission.

## Configuration

```bash
# .env
CLOUDFLARE_API_TOKEN=xxx
CLOUDFLARE_ACCOUNT_ID=xxx
DEFAULT_PROVIDER=cloudflare
```

Or per-environment:
```json
{
  "name": "edge-env",
  "config": {
    "provider": "cloudflare",
    "cloudflare_region": "auto"
  }
}
```

## Implementation

### New files
- `packages/agent-sdk/src/providers/cloudflare.ts` — provider implementation

### Pattern
Follow the existing `cli-provider.ts` factory pattern if Cloudflare
has a local CLI, or the `sprites.ts` HTTP pattern if it's API-only.

Most likely HTTP pattern (like sprites):
1. `createContainer()` → POST to Cloudflare API
2. `exec()` → HTTP request to container's exec endpoint
3. `startExec()` → streaming HTTP request
4. `delete()` → DELETE to Cloudflare API

### Container image
Need a base image with Node.js 22 + npm pre-installed. Either:
- Use our existing Dockerfile as the container image
- Use a standard `node:22-slim` image and install CLIs at runtime (like we do with sprites)

### stripControlChars
Depends on how Cloudflare multiplexes stdout/stderr. Need to test
whether the exec endpoint returns clean stdout or Docker-style
multiplexed output.

## Phases

### Phase 1: Basic provider
- Create/delete/list/exec via Cloudflare Containers API
- Single region (auto-placed)
- Node.js base image
- Test with Claude engine

### Phase 2: Region control
- Support `cloudflare_region` config
- Map to Cloudflare's edge location hints

### Phase 3: Warm pool support
- Pre-create containers for fast session start
- Container checkpointing (if Cloudflare supports it)

## Prerequisites
- Cloudflare account with Containers enabled
- API token with Containers permission
- Need to research the exact Containers API surface (docs may be limited)

## Non-goals
- Running the gateway ITSELF on Cloudflare Workers (that's their approach, not ours)
- Durable Objects integration (we use SQLite, not their state primitives)
- Worker-based harness execution (our harnesses need full Linux)
