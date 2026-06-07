"""Offline unit tests for bedrock_to_cma — no network required.

Run: python -m unittest test_bedrock_to_cma.py -v
"""

import unittest
from typing import Any, Dict, Iterator, List, Optional

from bedrock_to_cma import (
    BedrockToCMAAdapter,
    _extract_text,
    _max_seq,
)


class FakeClient:
    """Records requests and replays canned responses / SSE events."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.responses: Dict[str, Dict[str, Any]] = {}
        self.stream_events: List[Dict[str, Any]] = []
        self.stream_params: Optional[Dict[str, Any]] = None

    def request(self, method: str, path: str,
                body: Optional[Dict[str, Any]] = None,
                params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.calls.append({"method": method, "path": path, "body": body, "params": params})
        return self.responses.get(f"{method} {path}", {"id": "stub"})

    def stream(self, path: str,
               params: Optional[Dict[str, Any]] = None) -> Iterator[Dict[str, Any]]:
        self.stream_params = params
        self.calls.append({"method": "STREAM", "path": path, "params": params})
        for evt in self.stream_events:
            yield evt


def make_adapter() -> tuple[BedrockToCMAAdapter, FakeClient]:
    adapter = BedrockToCMAAdapter(api_key="test", environment_id="env_1")
    fake = FakeClient()
    adapter._cma = fake  # type: ignore[assignment]
    return adapter, fake


class TestHelpers(unittest.TestCase):
    def test_extract_text_inline_content(self):
        evt = {"type": "agent", "content": [
            {"type": "text", "text": "hello "},
            {"type": "text", "text": "world"},
        ]}
        self.assertEqual(_extract_text(evt), "hello world")

    def test_extract_text_delta(self):
        self.assertEqual(_extract_text({"delta": {"text": "abc"}}), "abc")

    def test_extract_text_gateway_payload_wrapper(self):
        evt = {"type": "agent.message", "payload": {
            "content": [{"type": "text", "text": "wrapped"}]}}
        self.assertEqual(_extract_text(evt), "wrapped")

    def test_extract_text_skips_non_text_blocks(self):
        evt = {"content": [{"type": "tool_use", "name": "x"},
                           {"type": "text", "text": "keep"}]}
        self.assertEqual(_extract_text(evt), "keep")

    def test_max_seq(self):
        self.assertEqual(_max_seq({"data": [{"seq": 3}, {"seq": 7}, {"seq": 5}]}), 7)
        self.assertIsNone(_max_seq({"data": []}))
        self.assertIsNone(_max_seq({}))

    def test_map_model(self):
        adapter, _ = make_adapter()
        self.assertEqual(adapter._map_model("anthropic.claude-sonnet-4"), "claude-sonnet-4-6")
        self.assertEqual(adapter._map_model("arn:...:anthropic.claude-haiku-4"), "claude-haiku-4-5")
        self.assertEqual(adapter._map_model(None), "claude-opus-4-7")
        self.assertEqual(adapter._map_model("mystery-model"), "claude-opus-4-7")

    def test_action_groups_to_tools(self):
        out = BedrockToCMAAdapter._action_groups_to_tools([
            {"actionGroupName": "weather", "mcpServerUrl": "https://mcp.example.com"},
            {"actionGroupName": "lambda-only"},  # dropped (no MCP url)
        ])
        self.assertEqual(out["tools"], [{"type": "agent_toolset_20260401"}])
        self.assertEqual(len(out["mcp_servers"]), 1)
        self.assertEqual(out["mcp_servers"][0]["url"], "https://mcp.example.com")
        self.assertEqual(out["mcp_servers"][0]["name"], "weather")


class TestControlPlane(unittest.TestCase):
    def test_create_agent_body(self):
        adapter, fake = make_adapter()
        fake.responses["POST /agents"] = {"id": "agent_1", "version": 1}
        res = adapter.create_agent(agentName="bot",
                                   foundationModel="anthropic.claude-opus-4",
                                   instruction="be nice")
        self.assertEqual(res["agent"]["agentId"], "agent_1")
        body = fake.calls[0]["body"]
        self.assertEqual(body["name"], "bot")
        self.assertEqual(body["model"], "claude-opus-4-7")
        self.assertEqual(body["system"], "be nice")
        self.assertEqual(body["tools"], [{"type": "agent_toolset_20260401"}])

    def test_update_agent_reads_version_first(self):
        adapter, fake = make_adapter()
        fake.responses["GET /agents/agent_1"] = {"id": "agent_1", "version": 4}
        fake.responses["POST /agents/agent_1"] = {"id": "agent_1", "version": 5}
        adapter.update_agent("agent_1", instruction="updated")

        # First call must be the GET to read the current version.
        self.assertEqual(fake.calls[0]["method"], "GET")
        self.assertEqual(fake.calls[0]["path"], "/agents/agent_1")
        # Second call is the POST and MUST carry version for optimistic concurrency.
        post = fake.calls[1]
        self.assertEqual(post["method"], "POST")
        self.assertEqual(post["body"]["version"], 4)
        self.assertEqual(post["body"]["system"], "updated")

    def test_delete_agent_archives(self):
        adapter, fake = make_adapter()
        res = adapter.delete_agent("agent_1")
        self.assertEqual(fake.calls[0]["path"], "/agents/agent_1/archive")
        self.assertEqual(res["agentStatus"], "DELETING")


class TestInvoke(unittest.TestCase):
    def _prep(self):
        adapter, fake = make_adapter()
        # Pre-register the session so create isn't attempted.
        from bedrock_to_cma import _SessionRecord
        adapter._sessions["sess"] = _SessionRecord(cma_session_id="cma_sess",
                                                   cma_agent_id="agent_1")
        return adapter, fake

    def test_invoke_raw_anthropic_events(self):
        adapter, fake = self._prep()
        fake.responses["POST /sessions/cma_sess/events"] = {"data": [{"seq": 10}]}
        fake.stream_events = [
            {"type": "status_running"},
            {"type": "agent", "content": [{"type": "text", "text": "Hi there"}]},
            {"type": "status_idle", "stop_reason": "end_turn"},
            {"type": "agent", "content": [{"type": "text", "text": "SHOULD NOT APPEAR"}]},
        ]
        chunks = list(adapter.invoke_agent("agent_1", "alias", "sess", "hello"))
        text = b"".join(c["chunk"]["bytes"] for c in chunks if "chunk" in c).decode()
        self.assertEqual(text, "Hi there")
        # Streamed strictly after the posted user message.
        self.assertEqual(fake.stream_params, {"after_seq": 10})

    def test_invoke_gateway_dotted_events(self):
        adapter, fake = self._prep()
        fake.responses["POST /sessions/cma_sess/events"] = {"data": [{"seq": 2}]}
        fake.stream_events = [
            {"type": "session.status_running"},
            {"type": "agent.message", "payload": {
                "content": [{"type": "text", "text": "wrapped reply"}]}},
            {"type": "session.status_idle"},
        ]
        chunks = list(adapter.invoke_agent("agent_1", "alias", "sess", "hello"))
        text = b"".join(c["chunk"]["bytes"] for c in chunks if "chunk" in c).decode()
        self.assertEqual(text, "wrapped reply")

    def test_invoke_emits_tool_trace(self):
        adapter, fake = self._prep()
        fake.responses["POST /sessions/cma_sess/events"] = {"data": [{"seq": 1}]}
        fake.stream_events = [
            {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
            {"type": "status_idle"},
        ]
        chunks = list(adapter.invoke_agent("agent_1", "alias", "sess", "go"))
        traces = [c for c in chunks if "trace" in c]
        self.assertEqual(len(traces), 1)

    def test_invoke_without_seq_waits_for_activity(self):
        # No seq in POST response -> after_seq is None -> idle is only honoured
        # after we've seen this turn's activity (guards against replayed history).
        adapter, fake = self._prep()
        fake.responses["POST /sessions/cma_sess/events"] = {}
        fake.stream_events = [
            {"type": "status_idle"},  # stale/replayed — must NOT terminate yet
            {"type": "status_running"},
            {"type": "agent", "content": [{"type": "text", "text": "real"}]},
            {"type": "status_idle"},
        ]
        chunks = list(adapter.invoke_agent("agent_1", "alias", "sess", "go"))
        text = b"".join(c["chunk"]["bytes"] for c in chunks if "chunk" in c).decode()
        self.assertEqual(text, "real")
        self.assertIsNone(fake.stream_params)


if __name__ == "__main__":
    unittest.main()
