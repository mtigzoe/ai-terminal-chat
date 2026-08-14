import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from agent import run_agent_loop  # noqa: E402
from base import Provider, ProviderResponse, ToolCall  # noqa: E402
from pending import clear_pending, get_pending  # noqa: E402
import agent  # noqa: E402


class FakeProvider(Provider):
    def __init__(self, responses):
        self.responses = iter(responses)

    def build_contents(self, msg, history):
        return [{"role": "user", "content": msg}]

    def generate(self, contents):
        return next(self.responses)

    def append_model_turn(self, contents, response):
        return contents + [{"role": "assistant", "response": response}]

    def append_tool_results(self, contents, results):
        return contents + [{"role": "tool", "results": results}]


def test_agent_returns_final_text_without_tools():
    provider = FakeProvider([ProviderResponse(text="hello")])

    events = list(run_agent_loop(provider, []))

    assert events == [{"type": "final", "text": "hello"}]


def test_agent_executes_read_only_tool_and_continues(monkeypatch):
    calls = []

    def fake_tool(value="ok"):
        calls.append(value)
        return {"value": value}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_read", fake_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_read", 5)

    provider = FakeProvider([
        ProviderResponse(text=None, tool_calls=[ToolCall("fake_read", {"value": "worked"})]),
        ProviderResponse(text="done"),
    ])

    events = list(run_agent_loop(provider, []))

    assert calls == ["worked"]
    assert events[0]["type"] == "tool_call"
    assert events[1] == {
        "type": "tool_result",
        "name": "fake_read",
        "result": {"value": "worked"},
    }
    assert events[-1] == {"type": "final", "text": "done"}


def test_agent_never_self_confirms_write(monkeypatch):
    clear_pending()
    calls = []

    def fake_write(confirm=False, **kwargs):
        calls.append(confirm)
        if not confirm:
            return {
                "requires_confirmation": True,
                "path": "example.txt",
                "diff": "+new line",
            }
        return {"written": True}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_write", fake_write)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_write", 5)
    monkeypatch.addfinalizer(clear_pending) if hasattr(monkeypatch, "addfinalizer") else None
    agent.WRITE_TOOL_NAMES.add("fake_write")

    try:
        provider = FakeProvider([
            ProviderResponse(
                text=None,
                tool_calls=[ToolCall("fake_write", {"path": "example.txt"})],
            )
        ])

        events = list(run_agent_loop(provider, []))

        pending = next(event for event in events if event["type"] == "pending_confirmation")
        stored = get_pending(pending["action_id"])

        assert calls == [False]
        assert stored is not None
        assert stored.args == {"path": "example.txt"}
        assert pending["preview"]["requires_confirmation"] is True
    finally:
        agent.WRITE_TOOL_NAMES.discard("fake_write")
        clear_pending()
