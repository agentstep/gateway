# Cloud Executor

A lightweight Go HTTP server (~350 LOC) that runs commands inside cloud-managed containers. The gateway talks to it over HTTP instead of local Docker/process exec.

## Architecture

```
Your infrastructure                    Cloud provider
┌──────────────────┐                   ┌─────────────────────────┐
│  AgentStep       │                   │  Executor (Go binary)   │
│  Gateway         │   POST /exec     │                         │
│                  │ ──────────────→  │  Runs: gemini, claude,  │
│  Sessions,       │                   │  codex, opencode, pi    │
│  events, vaults  │   SSE stdout     │                         │
│                  │ ←──────────────  │  Returns NDJSON stream  │
└──────────────────┘                   └─────────────────────────┘
```

The gateway doesn't know or care that the agent CLI is running in GCP/AWS/Azure. It uses the same `ContainerProvider` interface — `exec()` and `startExec()` map to HTTP calls instead of `docker exec`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/ping` | Health check. Returns `{"status":"healthy"}` with `X-Executor-API: 1` header |
| `POST` | `/exec` | One-shot command. Request: `{ argv, stdin?, timeout_ms? }` → Response: `{ stdout, stderr, exit_code }` |
| `POST` | `/exec/stream` | Streaming command. Same request → SSE with `event: stdout` (base64 lines) + `event: exit` |
| `POST` | `/fs/put` | Write a file. Request: `{ path, content, content_encoding?, mode? }` |
| `POST` | `/invocations` | AWS Bedrock AgentCore compatibility. Request: `{ input: { argv, stdin } }` |

Auth: `Authorization: Bearer <EXECUTOR_TOKEN>` on all endpoints except `/ping`.

## Images

Two Docker images, both multi-arch (AMD64 + ARM64):

| Image | Base | Size | Use case |
|-------|------|------|----------|
| `executor` | distroless + busybox | ~8MB | Minimal — only echo, cat, ls. For testing or pre-installed CLI images |
| `executor-coding` | node:22-slim + executor | ~200MB | Has Node.js + npm. Gateway installs agent CLIs on first turn |

The coding image is what you deploy for agent workloads. The gateway's existing setup code (`npm install -g @google/gemini-cli`, etc.) runs automatically on first turn.

## Gateway Provider

The `cloud-run` provider in `packages/agent-sdk/src/providers/cloud-run.ts` implements the `ContainerProvider` interface:

```typescript
// Environment config
{
  "type": "cloud",
  "provider": "cloud-run"
}

// Required env vars
CLOUD_RUN_EXECUTOR_URL=https://executor-xxx.us-central1.run.app
CLOUD_RUN_EXECUTOR_TOKEN=<bearer token>
```

| Provider method | Executor call |
|----------------|---------------|
| `create()` | No-op (cloud manages instances) |
| `delete()` | No-op |
| `exec()` | `POST /exec` |
| `startExec()` | `POST /exec/stream` → SSE → `ReadableStream` |
| `checkAvailability()` | `GET /ping` |

## Deployment

### GCP Cloud Run

```bash
# Build and push
cd packages/executor
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/PROJECT/REPO/executor-coding:VERSION \
  --region us-central1 \
  --config cloudbuild-coding.yaml

# Deploy
gcloud run deploy executor \
  --image us-central1-docker.pkg.dev/PROJECT/REPO/executor-coding:VERSION \
  --region us-central1 \
  --set-env-vars "EXECUTOR_TOKEN=$(openssl rand -hex 16)" \
  --port 8080 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --min-instances 0 \
  --max-instances 10
```

Then set the gateway env vars:
```bash
CLOUD_RUN_EXECUTOR_URL=https://executor-xxx.us-central1.run.app
CLOUD_RUN_EXECUTOR_TOKEN=<the token you set above>
```

### AWS Bedrock AgentCore

The executor exposes `/invocations` (required by AgentCore) and `/ping` (health check). Deploy as a custom container runtime on port 8080 (ARM64 required).

### Azure Container Apps

Deploy as a custom container session pool image. Azure forwards HTTP requests to the container — all executor endpoints work natively. Per-session Hyper-V isolation with pre-warmed pool.

## How a Turn Works

1. User sends message via `POST /v1/sessions/{id}/events`
2. Gateway driver calls `provider.exec()` to install the agent CLI (first turn only)
3. Gateway driver calls `provider.startExec()` with the CLI command + stdin (env vars + prompt)
4. Cloud Run provider sends `POST /exec/stream` to the executor
5. Executor spawns the CLI process, streams stdout as base64 SSE events
6. Gateway provider decodes base64, pushes to `ReadableStream`
7. Driver reads NDJSON from the stream, translates to Managed Agents events
8. Events stored in DB, pushed to SSE subscribers

## Limitations

- **No per-session isolation on Cloud Run** — all sessions share the same instance filesystem. Use Azure Container Apps session pools for multi-tenant isolation.
- **Cold start** — ~5-8s on first request after scale-to-zero. Set `min-instances: 1` (~$5-10/month) to keep warm.
- **CLI install on first turn** — ~30-60s for `npm install -g`. Subsequent turns on the same instance are instant. Build a kitchen-sink image with pre-installed CLIs to eliminate this.
- **Cloud Run timeout** — max 60 minutes per request. Long-running agent turns may need higher limits.

## Verified

Tested end-to-end: Gateway (localhost) → Cloud Run executor (GCP us-central1) → Gemini agent → responded "Hello!"

All 5 executor endpoints verified on GCP Cloud Run. 12 Go unit tests passing.
