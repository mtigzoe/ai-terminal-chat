import sys
import time
import threading
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from agent import run_agent_loop  # noqa: E402
from base import Provider, ProviderResponse, ToolCall  # noqa: E402
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


def test_timed_out_tool_worker_is_daemon(monkeypatch):
    """A timed-out tool must not leave a non-daemon worker that blocks shutdown."""

    def hung_tool(**kwargs):
        time.sleep(2)
        return {"ok": True}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_hung", hung_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_hung", 0.01)

    provider = FakeProvider([
        ProviderResponse(text=None, tool_calls=[ToolCall("fake_hung", {})]),
        ProviderResponse(text="recovered"),
    ])

    events = list(run_agent_loop(provider, []))

    results = [event for event in events if event["type"] == "tool_result"]
    assert results
    assert "exceeded its" in results[0]["result"]["error"]
    assert events[-1] == {"type": "final", "text": "recovered"}

    workers = [
        thread
        for thread in threading.enumerate()
        if thread.name.startswith("ai-terminal-tool:fake_hung")
    ]
    assert workers
    assert all(thread.daemon for thread in workers)
