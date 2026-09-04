import subprocess
import sys
import time
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from agent import (  # noqa: E402
    run_agent_loop,
    _normalize_call_args,
    MAX_TOOL_ROUNDS,
    MAX_CONSECUTIVE_IDENTICAL_CALLS,
    HARD_ABORT_CONSECUTIVE_CALLS,
    MAX_CONSECUTIVE_ERRORS,
)
from base import Provider, ProviderResponse, ToolCall  # noqa: E402
from pending import clear_pending, get_pending  # noqa: E402
import agent  # noqa: E402
import security  # noqa: E402
import tools  # noqa: E402


class FakeProvider(Provider):
    def __init__(self, responses):
        self.responses = iter(responses)

    def build_contents(self, msg, history, user_instructions=None):
        return [{"role": "user", "content": msg}]

    def generate(self, contents):
        return next(self.responses)

    def append_model_turn(self, contents, response):
        return contents + [{"role": "assistant", "response": response}]

    def append_tool_results(self, contents, results):
        return contents + [{"role": "tool", "results": results}]


class FailingProvider(Provider):
    def build_contents(self, msg, history, user_instructions=None):
        return []

    def generate(self, contents):
        raise RuntimeError("provider offline")

    def append_model_turn(self, contents, response):
        return contents

    def append_tool_results(self, contents, results):
        return contents


def _events_of_type(events, event_type):
    return [e for e in events if e["type"] == event_type]


def test_agent_returns_final_text_without_tools():
    provider = FakeProvider([ProviderResponse(text="hello")])

    events = list(run_agent_loop(provider, []))

    assert events[0]["type"] == "progress"
    assert events[0]["phase"] == "plan"
    complete = [e for e in events if e.get("phase") == "complete"]
    assert complete
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
    progress_events = _events_of_type(events, "progress")
    assert len(progress_events) >= 1
    assert any(e["type"] == "tool_call" for e in events)
    assert any(
        e["type"] == "tool_result" and e["name"] == "fake_read"
        for e in events
    )
    assert events[-1] == {"type": "final", "text": "done"}
    assert any(e.get("phase") == "complete" for e in progress_events)


def test_multi_step_tool_execution(monkeypatch):
    order = []

    def inspect_tool(path="."):
        order.append(("inspect", path))
        return {"path": path, "entries": []}

    def run_tool(command=""):
        order.append(("run", command))
        return {"command": command, "returncode": 0, "stdout": "ok", "stderr": ""}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "list_files", inspect_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "list_files", 5)
    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "run_command", run_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "run_command", 5)

    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("list_files", {"path": "."})],
        ),
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("run_command", {"command": "pytest"})],
        ),
        ProviderResponse(text="tests passed"),
    ])

    events = list(run_agent_loop(provider, []))

    assert order == [("inspect", "."), ("run", "pytest")]
    phases = [e.get("phase") for e in events if e["type"] == "progress"]
    assert "plan" in phases
    assert "inspect" in phases
    assert "execute" in phases
    assert "complete" in phases
    assert events[-1] == {"type": "final", "text": "tests passed"}


def test_cancel_event_set_before_start_stops_before_any_provider_call():
    from threading import Event

    class ExplodingProvider(Provider):
        def build_contents(self, msg, history):
            return []

        def generate(self, contents):
            raise AssertionError("generate() must not be called once cancelled")

        def append_model_turn(self, contents, response):
            return contents

        def append_tool_results(self, contents, results):
            return contents

    cancel_event = Event()
    cancel_event.set()

    events = list(run_agent_loop(ExplodingProvider(), [], cancel_event=cancel_event))

    assert events[-1] == {"type": "cancelled"}
    cancelled_progress = [e for e in events if e.get("phase") == "cancelled"]
    assert cancelled_progress


def test_cancel_event_set_mid_loop_stops_before_next_round(monkeypatch):
    from threading import Event

    def slow_tool(value="ok"):
        return {"value": value}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_read", slow_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_read", 5)

    cancel_event = Event()

    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("fake_read", {"value": "first"})],
        ),
        ProviderResponse(text="should never be reached"),
    ])

    # Cancel between round 1's tool call and round 2's provider.generate().
    original_append_tool_results = provider.append_tool_results

    def cancel_then_append(contents, results):
        cancel_event.set()
        return original_append_tool_results(contents, results)

    provider.append_tool_results = cancel_then_append

    events = list(run_agent_loop(provider, [], cancel_event=cancel_event))

    assert events[-1] == {"type": "cancelled"}
    assert {"type": "final", "text": "should never be reached"} not in events


def test_cancel_event_checked_before_each_tool_call(monkeypatch):
    from threading import Event

    calls = []

    def fake_tool(value="ok"):
        calls.append(value)
        return {"value": value}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_read", fake_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_read", 5)

    cancel_event = Event()

    def cancel_after_first_call(value="ok"):
        calls.append(value)
        cancel_event.set()
        return {"value": value}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_read", cancel_after_first_call)

    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[
                ToolCall("fake_read", {"value": "one"}),
                ToolCall("fake_read", {"value": "two"}),
            ],
        ),
    ])

    events = list(run_agent_loop(provider, [], cancel_event=cancel_event))

    # Only the first of the two tool calls in this round should have run.
    assert calls == ["one"]
    assert events[-1] == {"type": "cancelled"}


def test_no_cancel_event_behaves_exactly_as_before():
    provider = FakeProvider([ProviderResponse(text="hello")])
    events = list(run_agent_loop(provider, []))
    assert events[-1] == {"type": "final", "text": "hello"}


def test_progress_messages_are_meaningful(monkeypatch):
    def read_tool(path):
        return {"path": path, "contents": "x"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "read_file", read_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "read_file", 5)

    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("read_file", {"path": "app.py"})],
        ),
        ProviderResponse(text="done"),
    ])

    events = list(run_agent_loop(provider, []))
    progress = _events_of_type(events, "progress")
    messages = [e["message"] for e in progress]

    assert any("Planning" in m for m in messages)
    assert any("Inspecting app.py" in m for m in messages)
    assert any("Task completed" in m for m in messages)
    assert not all("requesting next model turn" in m for m in messages)


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

        pending = next(e for e in events if e["type"] == "pending_confirmation")
        stored = get_pending(pending["action_id"])

        assert calls == [False]
        assert stored is not None
        assert stored.args == {"path": "example.txt"}
        assert pending["preview"]["requires_confirmation"] is True

        confirm_progress = [
            e for e in events
            if e["type"] == "progress" and e.get("phase") == "confirm"
        ]
        assert confirm_progress
        assert any("Waiting for confirmation" in e["message"] for e in confirm_progress)
    finally:
        agent.WRITE_TOOL_NAMES.discard("fake_write")
        clear_pending()


def test_write_confirmation_stores_exact_requested_operation(monkeypatch):
    clear_pending()

    def fake_write(path, contents="", confirm=False):
        if not confirm:
            return {
                "requires_confirmation": True,
                "path": path,
                "preview": contents,
            }
        return {"path": path, "created": True, "bytes_written": len(contents)}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "write_file", fake_write)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "write_file", 5)

    requested = {"path": "src/main.py", "contents": "print(1)\n", "confirm": True}

    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("write_file", requested)],
        )
    ])

    events = list(run_agent_loop(provider, []))
    pending = next(e for e in events if e["type"] == "pending_confirmation")
    stored = get_pending(pending["action_id"])

    assert stored.args["path"] == "src/main.py"
    assert stored.args["contents"] == "print(1)\n"
    assert pending["args"] == requested
    clear_pending()


def test_agent_emits_recovery_hint_after_consecutive_errors(monkeypatch):
    def failing_tool(**kwargs):
        return {"error": "simulated failure"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_fail", failing_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_fail", 5)

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

    tool_results = _events_of_type(events, "tool_result")
    assert len(tool_results) == 3
    assert "recovery_hint" not in tool_results[0]["result"]
    assert "recovery_hint" not in tool_results[1]["result"]
    assert "recovery_hint" in tool_results[2]["result"]
    recover_progress = [
        e for e in events if e["type"] == "progress" and e.get("phase") == "recover"
    ]
    assert recover_progress
    assert events[-1] == {"type": "final", "text": "stopped after failures"}


def test_consecutive_errors_hard_stop(monkeypatch):
    def failing_tool(**kwargs):
        return {"error": "always fails"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_fail", failing_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_fail", 5)

    calls = [
        ToolCall("fake_fail", {"n": i}) for i in range(1, MAX_CONSECUTIVE_ERRORS + 1)
    ]
    provider = FakeProvider([
        ProviderResponse(text=None, tool_calls=calls),
    ])

    events = list(run_agent_loop(provider, []))

    errors = _events_of_type(events, "error")
    assert errors
    assert "consecutive tool failures" in errors[-1]["message"]
    assert not any(e["type"] == "final" for e in events)


def test_repeated_identical_calls_soft_block(monkeypatch):
    def ok_tool(path="x"):
        return {"path": path, "contents": "data"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "read_file", ok_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "read_file", 5)

    n = MAX_CONSECUTIVE_IDENTICAL_CALLS + 1
    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("read_file", {"path": "a.py"})] * n,
        ),
        ProviderResponse(text="recovered"),
    ])

    events = list(run_agent_loop(provider, []))
    tool_results = _events_of_type(events, "tool_result")
    assert any("already been called" in r["result"].get("error", "") for r in tool_results)
    assert events[-1]["type"] == "final"


def test_repeated_identical_calls_hard_abort(monkeypatch):
    def ok_tool(path="x"):
        return {"path": path, "contents": "data"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "read_file", ok_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "read_file", 5)

    n = HARD_ABORT_CONSECUTIVE_CALLS + 1
    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("read_file", {"path": "a.py"})] * n,
        ),
    ])

    events = list(run_agent_loop(provider, []))
    errors = _events_of_type(events, "error")
    assert errors
    assert "times in a row" in errors[-1]["message"]
    assert not any(e["type"] == "final" for e in events)


def test_path_normalization_for_identical_calls(monkeypatch):
    calls = []

    def ok_tool(path="x"):
        calls.append(path)
        return {"path": path, "contents": "data"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "read_file", ok_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "read_file", 5)

    n = MAX_CONSECUTIVE_IDENTICAL_CALLS + 1
    tool_calls = []
    for i in range(n):
        path = "./a.py" if i % 2 == 0 else "a.py"
        tool_calls.append(ToolCall("read_file", {"path": path}))

    provider = FakeProvider([
        ProviderResponse(text=None, tool_calls=tool_calls),
        ProviderResponse(text="done"),
    ])

    events = list(run_agent_loop(provider, []))
    tool_results = _events_of_type(events, "tool_result")
    assert any("already been called" in r["result"].get("error", "") for r in tool_results)


def test_normalize_call_args_strips_dot_slash():
    assert _normalize_call_args({"path": "./src/app.py"}) == (
        ("path", "src/app.py"),
    )
    assert _normalize_call_args({"path": "src/app.py"}) == (
        ("path", "src/app.py"),
    )
    assert _normalize_call_args({"path": "./src/app.py"}) == _normalize_call_args(
        {"path": "src/app.py"}
    )


def test_tool_timeout(monkeypatch):
    def slow_tool(**kwargs):
        time.sleep(2)
        return {"ok": True}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_slow", slow_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_slow", 0.1)

    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("fake_slow", {})],
        ),
        ProviderResponse(text="after timeout"),
    ])

    events = list(run_agent_loop(provider, []))
    tool_results = _events_of_type(events, "tool_result")
    assert tool_results
    assert "exceeded its" in tool_results[0]["result"]["error"]
    assert events[-1] == {"type": "final", "text": "after timeout"}


def test_provider_failure():
    provider = FailingProvider()
    events = list(run_agent_loop(provider, []))

    errors = _events_of_type(events, "error")
    assert errors
    assert "provider offline" in errors[-1]["message"]
    progress_errors = [
        e for e in events if e["type"] == "progress" and e.get("phase") == "error"
    ]
    assert progress_errors


def test_unknown_tool():
    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("does_not_exist", {"x": 1})],
        ),
        ProviderResponse(text="handled unknown tool"),
    ])

    events = list(run_agent_loop(provider, []))
    tool_results = _events_of_type(events, "tool_result")
    assert "Unknown tool" in tool_results[0]["result"]["error"]
    assert events[-1]["type"] == "final"


def test_maximum_tool_rounds(monkeypatch):
    def ok_tool(n=0):
        return {"n": n}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_read", ok_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_read", 5)

    responses = [
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("fake_read", {"n": i})],
        )
        for i in range(MAX_TOOL_ROUNDS)
    ]
    provider = FakeProvider(responses)

    events = list(run_agent_loop(provider, []))
    errors = _events_of_type(events, "error")
    assert errors
    assert "maximum number of tool-calling rounds" in errors[-1]["message"]
    assert not any(e["type"] == "final" for e in events)


def test_verification_hint_after_successful_write_result(monkeypatch):
    """If a write success result is observed in-loop, emit verify progress + hint."""

    def success_write(path, contents="", confirm=False):
        return {
            "path": path,
            "created": True,
            "bytes_written": len(contents or ""),
        }

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "create_file", success_write)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "create_file", 5)

    agent.WRITE_TOOL_NAMES.discard("create_file")
    try:
        provider = FakeProvider([
            ProviderResponse(
                text=None,
                tool_calls=[
                    ToolCall("create_file", {"path": "new.txt", "contents": "hi"})
                ],
            ),
            ProviderResponse(text="verified"),
        ])
        events = list(run_agent_loop(provider, []))
        verify = [
            e for e in events
            if e["type"] == "progress" and e.get("phase") == "verify"
        ]
        assert verify
        results = _events_of_type(events, "tool_result")
        assert "verification_hint" in results[0]["result"]
    finally:
        agent.WRITE_TOOL_NAMES.add("create_file")


def test_git_add_never_self_confirms_through_agent_loop(tmp_path, monkeypatch):
    """The real git_add tool (not a fake) must go through the same
    generic preview/pending gate as the filesystem write tools, even
    though it isn't in WRITE_TOOL_NAMES.
    """

    clear_pending()
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    (tmp_path / "file.txt").write_text("hello")

    # The model tries to skip the preview and self-confirm directly.
    provider = FakeProvider([
        ProviderResponse(
            text=None,
            tool_calls=[ToolCall("git_add", {"path": "file.txt", "confirm": True})],
        )
    ])

    events = list(run_agent_loop(provider, []))

    pending = next(e for e in events if e["type"] == "pending_confirmation")
    stored = get_pending(pending["action_id"])

    # Nothing was staged despite the model requesting confirm=True.
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout.strip().startswith("??")
    assert stored.tool_name == "git_add"
    assert pending["preview"]["requires_confirmation"] is True

    confirm_progress = [
        e for e in events
        if e["type"] == "progress" and e.get("phase") == "confirm"
    ]
    assert any("stage" in e["message"].lower() for e in confirm_progress)
    clear_pending()


def test_final_completion_progress():
    provider = FakeProvider([ProviderResponse(text="all done")])
    events = list(run_agent_loop(provider, []))
    assert any(
        e["type"] == "progress" and e.get("phase") == "complete"
        for e in events
    )
    assert events[-1] == {"type": "final", "text": "all done"}
