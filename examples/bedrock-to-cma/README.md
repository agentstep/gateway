# Bedrock → Claude Managed Agents adapter

`bedrock_to_cma.py` exposes an **AWS "Agents for Amazon Bedrock"**-shaped
interface and translates each call into **Claude Managed Agents (CMA)** REST
endpoints. Point existing Bedrock-agent code at this adapter and it talks to
`api.anthropic.com` — or to an [AgentStep gateway](../../README.md), which
mirrors the same API shapes — underneath.

## Install

```bash
pip install -r requirements.txt
```

## Use against api.anthropic.com

```python
from bedrock_to_cma import BedrockToCMAAdapter

adapter = BedrockToCMAAdapter(api_key="sk-ant-...")

agent = adapter.create_agent(
    agentName="support-bot",
    foundationModel="anthropic.claude-opus-4",
    instruction="You are a concise customer-support agent.",
)
agent_id = agent["agent"]["agentId"]

for chunk in adapter.invoke_agent(
    agentId=agent_id,
    agentAliasId="TSTALIASID",
    sessionId="my-client-session-1",
    inputText="Where is my order?",
):
    if "chunk" in chunk:
        print(chunk["chunk"]["bytes"].decode(), end="", flush=True)
```

## Use against an AgentStep gateway

The gateway serves the CMA shapes under an `/anthropic/v1/*` prefix, so pass
its origin plus the prefix:

```python
adapter = BedrockToCMAAdapter(
    api_key="<gateway api key>",
    base_url="https://my-gateway.example.com",
    api_prefix="/anthropic/v1",
)
```

## Operation map

| AWS (Bedrock) | CMA endpoint |
| --- | --- |
| `CreateAgent` | `POST /v1/agents` |
| `UpdateAgent` | `POST /v1/agents/{id}` — reads current `version` first (optimistic concurrency) |
| `GetAgent` / `ListAgents` | `GET /v1/agents/{id}` / `GET /v1/agents` |
| `DeleteAgent` | `POST /v1/agents/{id}/archive` (archive is the terminal, irreversible equivalent — there is no true delete) |
| `PrepareAgent` | no-op (CMA agents are usable as soon as they are created) |
| `CreateAgentAlias` | tracked locally as a pointer to an agent version |
| `CreateAgentActionGroup` | folded into `tools` / `mcp_servers` (best-effort) |
| `CreateSession` … `EndSession` | `POST/GET/DELETE /v1/sessions/...`, `…/archive` |
| `InvokeAgent` | `POST /v1/sessions/{id}/events` then `GET …/events/stream` (SSE) |

## Known limitations

- **Lambda action groups** have no CMA equivalent. Only action groups that
  expose an MCP server URL (`mcpServerUrl` / `mcp_url`) are translated; the
  rest are logged and dropped.
- **Agent memory** (`GetAgentMemory` / `DeleteAgentMemory`) does not map 1:1 —
  these raise `NotImplementedError`. Use a `memory_store` session resource
  instead.
- **Knowledge bases** are not a 1:1 concept; attach context via session
  resources or agent skills.
- `DeleteAgent` archives rather than deletes — it cannot be undone.

## Event-shape handling

`InvokeAgent` recognises both the raw Anthropic SSE event names
(`agent`, `status_idle`, `tool_use`, …) and a gateway's dotted re-broadcast
names (`agent.message`, `session.status_idle`, `agent.tool_use`, …, with the
original event nested under `payload`), so the same code works against either
target.

## Tests

Offline unit tests cover the translation logic (no network required):

```bash
python -m unittest test_bedrock_to_cma.py -v
```
