"""
bedrock_to_cma.py
=================

An adapter that exposes an *AWS "Agents for Amazon Bedrock"*-shaped interface
and translates each call into *Claude Managed Agents* (CMA) REST endpoints
on ``api.anthropic.com`` (or any compatible gateway, such as AgentStep).

The goal is drop-in-ish: code written against the Bedrock agent control-plane
(``CreateAgent``, ``UpdateAgent`` ...) and runtime (``InvokeAgent``,
``CreateSession`` ...) can call this adapter instead and hit Claude Managed
Agents underneath.

--------------------------------------------------------------------------
ENDPOINT / OPERATION MAP
--------------------------------------------------------------------------
AWS operation (Bedrock)          -> CMA endpoint
---------------------------------   ------------------------------------------
CreateAgent                      -> POST   /v1/agents
UpdateAgent                      -> POST   /v1/agents/{agent_id}   (needs version!)
GetAgent                         -> GET    /v1/agents/{agent_id}
ListAgents                       -> GET    /v1/agents
DeleteAgent                      -> POST   /v1/agents/{agent_id}/archive   (no true delete!)
PrepareAgent                     -> (no-op; CMA agents are versioned + immediately usable)
CreateAgentAlias                 -> tracked locally as a pointer to an agent version
CreateAgentActionGroup           -> folded into agent.tools / agent.mcp_servers (best-effort)
AssociateKnowledgeBase           -> best-effort: agent.skills / session resources (NOT 1:1)

CreateSession                    -> POST   /v1/sessions          (needs agent + environment)
GetSession                       -> GET    /v1/sessions/{id}
ListSessions                     -> GET    /v1/sessions
UpdateSession                    -> POST   /v1/sessions/{id}
DeleteSession                    -> DELETE /v1/sessions/{id}
EndSession                       -> POST   /v1/sessions/{id}/archive
InvokeAgent                      -> POST   /v1/sessions/{id}/events   (user.message)
                                  + GET    /v1/sessions/{id}/events/stream  (SSE, aggregated)
GetAgentMemory / DeleteAgentMemory -> CMA memory stores (different model; stubbed + flagged)

AUTH:  AWS SigV4  ->  headers: x-api-key, anthropic-version, anthropic-beta

--------------------------------------------------------------------------
POINTING AT A GATEWAY INSTEAD OF api.anthropic.com
--------------------------------------------------------------------------
The CMA endpoints live at ``/v1/*`` on ``api.anthropic.com``. An AgentStep
gateway mirrors the *same* shapes under an ``/anthropic/v1/*`` prefix, so to
target a gateway pass its origin as ``base_url`` plus ``api_prefix="/anthropic/v1"``:

    BedrockToCMAAdapter(api_key=..., base_url="https://my-gateway.example.com",
                        api_prefix="/anthropic/v1")

--------------------------------------------------------------------------
EVENT-SHAPE NOTE (why InvokeAgent handles two naming styles)
--------------------------------------------------------------------------
The raw Anthropic event stream uses short type names (``agent``,
``status_idle``, ``status_running``, ``tool_use``, ``model_request_*``).
A gateway that re-broadcasts the log may use dotted names instead
(``agent.message``, ``session.status_idle``, ``agent.tool_use`` ...) and wrap
the original event under a ``payload`` key. This adapter recognises *both*
families so it works whether you point it at ``api.anthropic.com`` or a gateway.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional

import requests

logger = logging.getLogger("bedrock_to_cma")

CMA_BETA_HEADER = "managed-agents-2026-04-01"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_BASE_URL = "https://api.anthropic.com"
DEFAULT_API_PREFIX = "/v1"

# Event-type families. Both raw (api.anthropic.com) and dotted (gateway) forms.
_AGENT_TEXT_TYPES = {
    "agent", "agent.message", "agent.message_delta",
    "assistant.message", "agent.output_text",
}
_IDLE_TYPES = {"status_idle", "session.status_idle"}
_RUNNING_TYPES = {"status_running", "session.status_running"}


class CMAError(RuntimeError):
    """Raised when the CMA API returns a non-2xx response."""

    def __init__(self, status: int, payload: Dict[str, Any]):
        self.status = status
        self.payload = payload
        err = (payload or {}).get("error", {})
        super().__init__(
            f"CMA {status} {err.get('type', 'error')}: {err.get('message', payload)}"
        )


# --------------------------------------------------------------------------
# Thin REST client over the CMA endpoints
# --------------------------------------------------------------------------
class _CMAClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL,
                 api_prefix: str = DEFAULT_API_PREFIX, timeout: float = 60.0):
        # base = origin + prefix, e.g. "https://api.anthropic.com" + "/v1"
        self._base = base_url.rstrip("/") + "/" + api_prefix.strip("/")
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": CMA_BETA_HEADER,
            "content-type": "application/json",
        })

    def request(self, method: str, path: str,
                body: Optional[Dict[str, Any]] = None,
                params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self._base}{path}"
        resp = self._session.request(
            method, url, params=params,
            data=json.dumps(body) if body is not None else None,
            timeout=self._timeout,
        )
        if resp.status_code == 204:
            return {}
        payload = resp.json() if resp.content else {}
        if not resp.ok:
            raise CMAError(resp.status_code, payload)
        return payload

    def stream(self, path: str,
               params: Optional[Dict[str, Any]] = None) -> Iterator[Dict[str, Any]]:
        """Consume a CMA Server-Sent-Events stream, yielding parsed event dicts."""
        url = f"{self._base}{path}"
        with self._session.get(url, params=params, stream=True,
                               timeout=self._timeout,
                               headers={"accept": "text/event-stream"}) as resp:
            if not resp.ok:
                payload = resp.json() if resp.content else {}
                raise CMAError(resp.status_code, payload)
            data_buf: List[str] = []
            for raw in resp.iter_lines(decode_unicode=True):
                if raw is None:
                    continue
                line = raw.strip()
                if line == "":                       # event boundary
                    if data_buf:
                        chunk = "\n".join(data_buf)
                        data_buf = []
                        if chunk and chunk != "[DONE]":
                            try:
                                yield json.loads(chunk)
                            except json.JSONDecodeError:
                                logger.debug("skipping non-JSON SSE chunk: %r", chunk)
                    continue
                if line.startswith("data:"):
                    data_buf.append(line[len("data:"):].lstrip())


# --------------------------------------------------------------------------
# Local bookkeeping for the AWS concepts CMA has no direct slot for
# --------------------------------------------------------------------------
@dataclass
class _AgentRecord:
    cma_agent_id: str
    aliases: Dict[str, Optional[int]] = field(default_factory=dict)  # alias -> version


@dataclass
class _SessionRecord:
    cma_session_id: str
    cma_agent_id: str


# --------------------------------------------------------------------------
# The adapter
# --------------------------------------------------------------------------
class BedrockToCMAAdapter:
    """
    Presents Bedrock-Agent-style methods; talks CMA underneath.

    Parameters
    ----------
    api_key : str
        Anthropic API key (replaces AWS SigV4 credentials).
    default_model : str
        CMA model id used when a Bedrock ``foundationModel`` has no mapping.
    environment_id : Optional[str]
        Pre-created CMA environment. If omitted, one is created on first use.
    base_url : str
        Origin of the CMA service. Defaults to ``https://api.anthropic.com``.
    api_prefix : str
        Path prefix the CMA endpoints live under. ``/v1`` for the native
        Anthropic API; ``/anthropic/v1`` for an AgentStep gateway.
    """

    # Bedrock foundationModel ARNs/ids -> CMA model ids. Extend as needed.
    MODEL_MAP = {
        "anthropic.claude-opus-4": "claude-opus-4-7",
        "anthropic.claude-sonnet-4": "claude-sonnet-4-6",
        "anthropic.claude-haiku-4": "claude-haiku-4-5",
    }

    def __init__(self, api_key: str, default_model: str = "claude-opus-4-7",
                 environment_id: Optional[str] = None,
                 base_url: str = DEFAULT_BASE_URL,
                 api_prefix: str = DEFAULT_API_PREFIX):
        self._cma = _CMAClient(api_key, base_url=base_url, api_prefix=api_prefix)
        self._default_model = default_model
        self._environment_id = environment_id
        self._agents: Dict[str, _AgentRecord] = {}        # agentId -> record
        self._sessions: Dict[str, _SessionRecord] = {}    # client sessionId -> record

    # ---- helpers --------------------------------------------------------
    def _map_model(self, foundation_model: Optional[str]) -> str:
        if not foundation_model:
            return self._default_model
        for prefix, cma_id in self.MODEL_MAP.items():
            if foundation_model.startswith(prefix) or prefix in foundation_model:
                return cma_id
        logger.warning("No model mapping for %r; using default %s",
                       foundation_model, self._default_model)
        return self._default_model

    def _ensure_environment(self) -> str:
        if self._environment_id:
            return self._environment_id
        env = self._cma.request("POST", "/environments", body={
            "name": "bedrock-adapter-env",
            "config": {"type": "cloud", "networking": {"type": "unrestricted"}},
        })
        self._environment_id = env["id"]
        logger.info("created CMA environment %s", self._environment_id)
        return self._environment_id

    @staticmethod
    def _action_groups_to_tools(action_groups: List[Dict[str, Any]]) -> Dict[str, list]:
        """
        Best-effort translation of Bedrock action groups into CMA tool config.

        Lambda-backed action groups have NO direct CMA equivalent: CMA tools are
        the built-in toolset, MCP servers, and skills. We translate only action
        groups that expose an MCP URL; everything else is reported as unmapped.
        """
        tools: List[Dict[str, Any]] = [{"type": "agent_toolset_20260401"}]
        mcp_servers: List[Dict[str, Any]] = []
        unmapped: List[str] = []
        for ag in action_groups or []:
            mcp_url = ag.get("mcpServerUrl") or ag.get("mcp_url")
            if mcp_url:
                mcp_servers.append({
                    "type": "url",
                    "name": ag.get("actionGroupName", "action_group"),
                    "url": mcp_url,
                })
            else:
                unmapped.append(ag.get("actionGroupName", "<unnamed>"))
        if unmapped:
            logger.warning(
                "Action groups with no MCP equivalent were dropped: %s. "
                "Re-expose them as MCP servers to use them under CMA.", unmapped)
        return {"tools": tools, "mcp_servers": mcp_servers}

    # =====================================================================
    # CONTROL PLANE
    # =====================================================================
    def create_agent(self, agentName: str, foundationModel: Optional[str] = None,
                     instruction: Optional[str] = None,
                     actionGroups: Optional[List[Dict[str, Any]]] = None,
                     **_ignored) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "name": agentName,
            "model": self._map_model(foundationModel),
        }
        if instruction:
            body["system"] = instruction
        if actionGroups:
            body.update(self._action_groups_to_tools(actionGroups))
        else:
            body["tools"] = [{"type": "agent_toolset_20260401"}]

        created = self._cma.request("POST", "/agents", body=body)
        agent_id = created["id"]
        self._agents[agent_id] = _AgentRecord(cma_agent_id=agent_id)
        # Shape the response loosely like Bedrock's CreateAgent.
        return {"agent": {"agentId": agent_id, "agentName": agentName,
                          "agentStatus": "PREPARED", "_cma": created}}

    def update_agent(self, agentId: str, instruction: Optional[str] = None,
                     foundationModel: Optional[str] = None, **_ignored) -> Dict[str, Any]:
        # CMA's update is optimistic-concurrency controlled: it REQUIRES the
        # current version number, and bumps to version+1 on success. Read the
        # agent first so callers don't have to thread a version through the
        # Bedrock-shaped signature.
        current = self._cma.request("GET", f"/agents/{agentId}")
        body: Dict[str, Any] = {"version": current["version"]}
        if instruction is not None:
            body["system"] = instruction
        if foundationModel is not None:
            body["model"] = self._map_model(foundationModel)
        updated = self._cma.request("POST", f"/agents/{agentId}", body=body)
        return {"agent": {"agentId": agentId, "_cma": updated}}

    def get_agent(self, agentId: str) -> Dict[str, Any]:
        return {"agent": self._cma.request("GET", f"/agents/{agentId}")}

    def list_agents(self, **_ignored) -> Dict[str, Any]:
        res = self._cma.request("GET", "/agents")
        return {"agentSummaries": res.get("data", res)}

    def delete_agent(self, agentId: str, **_ignored) -> Dict[str, Any]:
        # CMA has no delete -- archive is the terminal, irreversible equivalent.
        logger.warning("Bedrock DeleteAgent -> CMA archive (PERMANENT, no unarchive): %s",
                       agentId)
        self._cma.request("POST", f"/agents/{agentId}/archive")
        self._agents.pop(agentId, None)
        return {"agentId": agentId, "agentStatus": "DELETING"}

    def prepare_agent(self, agentId: str, **_ignored) -> Dict[str, Any]:
        # No-op: CMA agents are usable as soon as they are created/versioned.
        return {"agentId": agentId, "agentStatus": "PREPARED"}

    def create_agent_alias(self, agentId: str, agentAliasName: str,
                           routingConfiguration: Optional[list] = None,
                           **_ignored) -> Dict[str, Any]:
        version = None
        if routingConfiguration:
            version = routingConfiguration[0].get("agentVersion")
        rec = self._agents.setdefault(agentId, _AgentRecord(cma_agent_id=agentId))
        rec.aliases[agentAliasName] = int(version) if version else None
        return {"agentAlias": {"agentAliasId": agentAliasName,
                               "agentId": agentId, "agentVersion": version}}

    # =====================================================================
    # RUNTIME
    # =====================================================================
    def create_session(self, agentId: str, sessionId: Optional[str] = None,
                       agentAliasId: Optional[str] = None, **_ignored) -> Dict[str, Any]:
        env_id = self._ensure_environment()
        agent_ref: Any = agentId
        rec = self._agents.get(agentId)
        if rec and agentAliasId and rec.aliases.get(agentAliasId):
            agent_ref = {"type": "agent", "id": agentId,
                         "version": rec.aliases[agentAliasId]}
        created = self._cma.request("POST", "/sessions", body={
            "agent": agent_ref,
            "environment_id": env_id,
        })
        client_id = sessionId or created["id"]
        self._sessions[client_id] = _SessionRecord(
            cma_session_id=created["id"], cma_agent_id=agentId)
        return {"sessionId": client_id, "_cmaSessionId": created["id"]}

    def _resolve_session(self, agentId: str, sessionId: str,
                         agentAliasId: Optional[str] = None) -> _SessionRecord:
        """Return the CMA session for a client sessionId, creating it on demand
        (mirrors Bedrock's auto-create-on-first-invoke behaviour)."""
        rec = self._sessions.get(sessionId)
        if rec is None:
            self.create_session(agentId=agentId, sessionId=sessionId,
                                agentAliasId=agentAliasId)
            rec = self._sessions[sessionId]
        return rec

    def get_session(self, sessionId: str, **_ignored) -> Dict[str, Any]:
        rec = self._sessions.get(sessionId)
        cma_id = rec.cma_session_id if rec else sessionId
        return self._cma.request("GET", f"/sessions/{cma_id}")

    def list_sessions(self, **_ignored) -> Dict[str, Any]:
        res = self._cma.request("GET", "/sessions")
        return {"sessionSummaries": res.get("data", res)}

    def update_session(self, sessionId: str, sessionMetadata: Optional[dict] = None,
                       **_ignored) -> Dict[str, Any]:
        rec = self._sessions.get(sessionId)
        cma_id = rec.cma_session_id if rec else sessionId
        body = {"metadata": sessionMetadata} if sessionMetadata else {}
        return self._cma.request("POST", f"/sessions/{cma_id}", body=body)

    def delete_session(self, sessionId: str, **_ignored) -> Dict[str, Any]:
        rec = self._sessions.pop(sessionId, None)
        cma_id = rec.cma_session_id if rec else sessionId
        self._cma.request("DELETE", f"/sessions/{cma_id}")
        return {"sessionId": sessionId}

    def end_session(self, sessionId: str, **_ignored) -> Dict[str, Any]:
        # Bedrock EndSession ~ CMA archive (session becomes read-only).
        rec = self._sessions.get(sessionId)
        cma_id = rec.cma_session_id if rec else sessionId
        self._cma.request("POST", f"/sessions/{cma_id}/archive")
        return {"sessionId": sessionId, "sessionStatus": "ENDED"}

    def invoke_agent(self, agentId: str, agentAliasId: str, sessionId: str,
                     inputText: str, **_ignored) -> Iterator[Dict[str, Any]]:
        """
        The headline translation. Bedrock's single streaming ``InvokeAgent``
        becomes: POST a user.message event, then stream session events and
        re-emit them in Bedrock's ``{"chunk": {"bytes": ...}}`` shape.

        We stream from *after* the just-posted user message (``after_seq``) so
        that on a multi-turn session we don't stop at a previous turn's idle
        event. Terminates on the session-idle event for this turn.

        Yields Bedrock-style chunk dicts.
        """
        rec = self._resolve_session(agentId, sessionId, agentAliasId)
        cma_id = rec.cma_session_id

        # 1) send the user turn. The response echoes the persisted event rows;
        #    capture the highest seq so we can stream strictly newer events.
        posted = self._cma.request("POST", f"/sessions/{cma_id}/events", body={
            "events": [{
                "type": "user.message",
                "content": [{"type": "text", "text": inputText}],
            }],
        })
        after_seq = _max_seq(posted)

        # 2) stream the assistant turn back, translating event shapes.
        params = {"after_seq": after_seq} if after_seq is not None else None
        saw_activity = after_seq is not None  # if we filtered by seq, replay is moot
        for event in self._cma.stream(f"/sessions/{cma_id}/events/stream", params=params):
            etype = event.get("type", "")
            if etype == "ping":                      # keepalive
                continue
            if etype in _RUNNING_TYPES:
                saw_activity = True
                continue
            if etype in _AGENT_TEXT_TYPES:
                saw_activity = True
                text = _extract_text(event)
                if text:
                    yield {"chunk": {"bytes": text.encode("utf-8")},
                           "_cmaType": etype}
            elif "tool_use" in etype or etype.endswith("tool"):
                saw_activity = True
                yield {"trace": {"orchestrationTrace": {"_cma": event}}}
            elif etype in _IDLE_TYPES:
                # End of the turn. Only honour it once we've actually seen this
                # turn begin/produce output, guarding against replayed history
                # when we couldn't compute an after_seq.
                if saw_activity:
                    return
            else:
                # Pass through anything unrecognised for debugging.
                yield {"_cmaEvent": event}

    # ---- memory (model differs; flagged rather than silently wrong) -----
    def get_agent_memory(self, *_a, **_k) -> Dict[str, Any]:
        raise NotImplementedError(
            "Bedrock agent memory does not map 1:1 to CMA memory stores. "
            "Attach a memory_store resource at session-create time and read it "
            "via the FUSE mount instead.")

    delete_agent_memory = get_agent_memory


def _max_seq(posted: Dict[str, Any]) -> Optional[int]:
    """Highest ``seq`` among the event rows returned by POST /events, or None
    if the response doesn't carry sequence numbers."""
    rows = posted.get("data") if isinstance(posted, dict) else None
    if not isinstance(rows, list):
        return None
    seqs = [r["seq"] for r in rows if isinstance(r, dict) and isinstance(r.get("seq"), int)]
    return max(seqs) if seqs else None


def _extract_text(event: Dict[str, Any]) -> str:
    """Pull text out of a CMA assistant event regardless of minor shape diffs.

    Handles the raw Anthropic event (text/content inline) and the gateway
    envelope (the original event nested under ``payload``)."""
    if isinstance(event.get("text"), str):
        return event["text"]
    if isinstance(event.get("delta"), dict) and "text" in event["delta"]:
        return event["delta"]["text"]
    content = event.get("content") or (event.get("message") or {}).get("content")
    if isinstance(content, list):
        text = "".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
        if text:
            return text
    # Gateway form: original event is wrapped under "payload".
    payload = event.get("payload")
    if isinstance(payload, dict):
        return _extract_text(payload)
    return ""


# --------------------------------------------------------------------------
# Usage example (mirrors a Bedrock InvokeAgent flow)
# --------------------------------------------------------------------------
if __name__ == "__main__":
    import os

    logging.basicConfig(level=logging.INFO)
    adapter = BedrockToCMAAdapter(api_key=os.environ["ANTHROPIC_API_KEY"])

    agent = adapter.create_agent(
        agentName="support-bot",
        foundationModel="anthropic.claude-opus-4",
        instruction="You are a concise customer-support agent.",
    )
    agent_id = agent["agent"]["agentId"]

    # Exactly the four positional concepts a Bedrock InvokeAgent caller passes.
    for chunk in adapter.invoke_agent(
        agentId=agent_id,
        agentAliasId="TSTALIASID",
        sessionId="my-client-session-1",
        inputText="Where is my order?",
    ):
        if "chunk" in chunk:
            print(chunk["chunk"]["bytes"].decode("utf-8"), end="", flush=True)
    print()
