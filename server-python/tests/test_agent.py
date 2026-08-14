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

    assert events[0]["type"] == "progress"
    assert events[-1] == {"type": "final", "text": "hello"}


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
    progress_events = [e for e in events if e["type"] == "progress"]
    assert len(progress_events) >= 1
    assert any(e["type"] == "tool_call" for e in events)
    assert any(
        e["type"] == "tool_result" and e["name"] == "fake_read"
        for e in events
    )
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


def test_agent_emits_recovery_hint_after_consecutive_errors(monkeypatch):
    def failing_tool(**kwargs):
        return {"error": "simulated failure"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_fail", failing_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_fail", 5)

    # Three failing calls in one model turn should attach a recovery hint
    # on the third result.
    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[
                ToolCall("fake_fail", {"n": 1}),
                ToolCall("fake_fail", {"n": 2}),
                ToolCall("fake_fail", {"n": 3}),
            ],
        ),
        ProviderResponse(text="stopped after failures"),
    ])

    events = list(run_agent_loop(provider, []))

    tool_results = [e for e in events if e["type"] == "tool_result"]
    assert len(tool_results) == 3
    assert "recovery_hint" not in tool_results[0]["result"]
    assert "recovery_hint" not in tool_results[1]["result"]
    assert "recovery_hint" in tool_results[2]["result"]
    assert events[-1] == {"type": "final", "text": "stopped after failures"}
