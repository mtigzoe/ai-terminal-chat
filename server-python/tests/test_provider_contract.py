"""Provider interface contract tests using a fake provider.

These tests pin the normalized Provider contract that every concrete
backend must satisfy so the agent loop stays provider-agnostic. They
do not hit the network and do not exercise Gemini/Ollama/Kilo SDKs.
"""

import sys
from pathlib import Path
from threading import Event
from typing import Optional

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from agent import run_agent_loop  # noqa: E402
from base import Provider, ProviderCapabilities, ProviderResponse, ToolCall  # noqa: E402
from pending import clear_pending, get_pending  # noqa: E402
import agent  # noqa: E402


class ContractProvider(Provider):
    """Deterministic provider that records conversation mutations.

    Responses are consumed in order. ``append_model_turn`` and
    ``append_tool_results`` preserve structure so round-trips can be
    asserted, including optional tool-call ids.
    """

    def __init__(self, responses, *, fail_with: Optional[Exception] = None):
        self._responses = list(responses)
        self._fail_with = fail_with
        self.generate_calls = 0
        self.appended_turns = []
        self.appended_results = []
        self.name = "contract"
        self.model = "contract-model"
        self._capabilities = ProviderCapabilities(
            tools=True,
            streaming=False,
            model_listing=False,
            requires_api_key=False,
            local=True,
        )

    @property
    def capabilities(self) -> ProviderCapabilities:
        return self._capabilities

    def build_contents(self, msg, history, user_instructions=None):
        contents = [{"role": "user", "content": msg}]
        for item in history:
            role = item.get("role")
            parts = item.get("parts") or []
            text = "".join(
                part.get("text", "") for part in parts if isinstance(part, dict)
            )
            if role and text:
                contents.append({"role": role, "content": text})
        return contents

    def generate(self, contents) -> ProviderResponse:
        self.generate_calls += 1
        if self._fail_with is not None:
            raise self._fail_with
        if not self._responses:
            raise RuntimeError("ContractProvider has no more scripted responses")
        return self._responses.pop(0)

    def append_model_turn(self, contents, response: ProviderResponse):
        turn = {
            "role": "assistant",
            "content": response.text,
            "tool_calls": [
                {
                    "id": call.id or f"call-{index}",
                    "name": call.name,
                    "args": dict(call.args or {}),
                }
                for index, call in enumerate(response.tool_calls or [])
            ],
        }
        self.appended_turns.append(turn)
        return contents + [turn]

    def append_tool_results(self, contents, results):
        assistant = contents[-1] if contents else {}
        prior_calls = assistant.get("tool_calls") or []
        messages = []
        for index, item in enumerate(results):
            call_id = None
            if index < len(prior_calls):
                call_id = prior_calls[index].get("id")
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id or f"call-{index}",
                    "name": item["name"],
                    "result": item["result"],
                }
            )
        self.appended_results.extend(messages)
        return contents + messages


def _events_of_type(events, event_type):
    return [e for e in events if e["type"] == event_type]


def test_tool_call_id_defaults_to_none():
    call = ToolCall(name="list_files", args={"path": "."})
    assert call.name == "list_files"
    assert call.args == {"path": "."}
    assert call.id is None


def test_tool_call_id_can_be_set():
    call = ToolCall(name="read_file", args={"path": "a.py"}, id="call-abc")
    assert call.id == "call-abc"


def test_tool_call_positional_construction_remains_compatible():
    # Existing tests and providers use ToolCall(name, args).
    call = ToolCall("run_command", {"command": "ls"})
    assert call.name == "run_command"
    assert call.args == {"command": "ls"}
    assert call.id is None


def test_contract_normal_text_response():
    provider = ContractProvider([ProviderResponse(text="hello from contract")])
    events = list(run_agent_loop(provider, []))

    assert provider.generate_calls == 1
    assert events[-1] == {"type": "final", "text": "hello from contract"}
    assert any(e.get("phase") == "complete" for e in events if e["type"] == "progress")


def test_contract_single_tool_call_then_final(monkeypatch):
    calls = []

    def fake_read(path="."):
        calls.append(path)
        return {"path": path, "contents": "data"}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "read_file", fake_read)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "read_file", 5)

    provider = ContractProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[ToolCall("read_file", {"path": "app.py"}, id="call-1")],
            ),
            ProviderResponse(text="file inspected"),
        ]
    )

    events = list(run_agent_loop(provider, []))

    assert calls == ["app.py"]
    assert any(e["type"] == "tool_call" and e["name"] == "read_file" for e in events)
    assert any(e["type"] == "tool_result" and e["name"] == "read_file" for e in events)
    assert events[-1] == {"type": "final", "text": "file inspected"}
    assert provider.appended_turns[0]["tool_calls"][0]["id"] == "call-1"
    assert provider.appended_results[0]["tool_call_id"] == "call-1"


def test_contract_multiple_tool_calls_in_one_turn(monkeypatch):
    order = []

    def list_files(path="."):
        order.append(("list", path))
        return {"entries": []}

    def search_files(query=""):
        order.append(("search", query))
        return {"matches": []}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "list_files", list_files)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "list_files", 5)
    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "search_files", search_files)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "search_files", 5)

    provider = ContractProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[
                    ToolCall("list_files", {"path": "."}, id="call-a"),
                    ToolCall("search_files", {"query": "Provider"}, id="call-b"),
                ],
            ),
            ProviderResponse(text="done"),
        ]
    )

    events = list(run_agent_loop(provider, []))

    assert order == [("list", "."), ("search", "Provider")]
    tool_calls = _events_of_type(events, "tool_call")
    assert [c["name"] for c in tool_calls] == ["list_files", "search_files"]
    assert [r["tool_call_id"] for r in provider.appended_results] == [
        "call-a",
        "call-b",
    ]
    assert events[-1] == {"type": "final", "text": "done"}


def test_contract_tool_result_round_trip_preserves_order(monkeypatch):
    monkeypatch.setitem(
        agent.TOOL_FUNCTIONS,
        "list_files",
        lambda path=".": {"path": path},
    )
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "list_files", 5)
    monkeypatch.setitem(
        agent.TOOL_FUNCTIONS,
        "read_file",
        lambda path="": {"path": path, "contents": ""},
    )
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "read_file", 5)

    provider = ContractProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[
                    ToolCall("list_files", {"path": "src"}, id="id-1"),
                    ToolCall("read_file", {"path": "src/a.py"}, id="id-2"),
                ],
            ),
            ProviderResponse(text="ok"),
        ]
    )

    list(run_agent_loop(provider, []))

    assert [item["name"] for item in provider.appended_results] == [
        "list_files",
        "read_file",
    ]
    assert [item["tool_call_id"] for item in provider.appended_results] == [
        "id-1",
        "id-2",
    ]


def test_contract_tool_call_without_id_still_round_trips(monkeypatch):
    monkeypatch.setitem(
        agent.TOOL_FUNCTIONS,
        "list_files",
        lambda path=".": {"ok": True},
    )
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "list_files", 5)

    provider = ContractProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[ToolCall("list_files", {"path": "."})],
            ),
            ProviderResponse(text="ok"),
        ]
    )

    events = list(run_agent_loop(provider, []))

    assert events[-1]["type"] == "final"
    # Synthetic id assigned during append_model_turn.
    assert provider.appended_turns[0]["tool_calls"][0]["id"] == "call-0"
    assert provider.appended_results[0]["tool_call_id"] == "call-0"


def test_contract_final_response_after_tool_execution(monkeypatch):
    monkeypatch.setitem(
        agent.TOOL_FUNCTIONS,
        "git_status",
        lambda: {"clean": True},
    )
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "git_status", 5)

    provider = ContractProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[ToolCall("git_status", {}, id="gs-1")],
            ),
            ProviderResponse(text="Working tree clean."),
        ]
    )

    events = list(run_agent_loop(provider, []))
    finals = _events_of_type(events, "final")
    assert finals == [{"type": "final", "text": "Working tree clean."}]
    assert provider.generate_calls == 2


def test_contract_provider_error_handling():
    provider = ContractProvider([], fail_with=RuntimeError("upstream down"))
    events = list(run_agent_loop(provider, []))

    errors = _events_of_type(events, "error")
    assert len(errors) == 1
    assert "upstream down" in errors[0]["message"]
    assert not any(e["type"] == "final" for e in events)


def test_contract_cancellation_before_generate():
    provider = ContractProvider([ProviderResponse(text="should not run")])
    cancel = Event()
    cancel.set()

    events = list(run_agent_loop(provider, [], cancel_event=cancel))

    assert provider.generate_calls == 0
    assert events[-1] == {"type": "cancelled"}


def test_contract_cancellation_between_tool_calls(monkeypatch):
    calls = []

    def fake_tool(value=""):
        calls.append(value)
        return {"value": value}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_read", fake_tool)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_read", 5)

    cancel = Event()

    def cancel_after_first(value=""):
        calls.append(value)
        cancel.set()
        return {"value": value}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_read", cancel_after_first)

    provider = ContractProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[
                    ToolCall("fake_read", {"value": "one"}, id="c1"),
                    ToolCall("fake_read", {"value": "two"}, id="c2"),
                ],
            )
        ]
    )

    events = list(run_agent_loop(provider, [], cancel_event=cancel))

    assert calls == ["one"]
    assert events[-1] == {"type": "cancelled"}


def test_contract_confirmation_required_tool_flow(monkeypatch):
    clear_pending()
    confirms = []

    def fake_write(confirm=False, path="out.txt", **kwargs):
        confirms.append(confirm)
        if not confirm:
            return {
                "requires_confirmation": True,
                "path": path,
                "diff": "+line",
            }
        return {"written": True, "path": path}

    monkeypatch.setitem(agent.TOOL_FUNCTIONS, "fake_write", fake_write)
    monkeypatch.setitem(agent.TOOL_TIMEOUTS, "fake_write", 5)
    agent.WRITE_TOOL_NAMES.add("fake_write")

    try:
        provider = ContractProvider(
            [
                ProviderResponse(
                    text=None,
                    tool_calls=[
                        ToolCall("fake_write", {"path": "out.txt"}, id="w1")
                    ],
                )
            ]
        )
        events = list(run_agent_loop(provider, []))

        pending_events = _events_of_type(events, "pending_confirmation")
        assert len(pending_events) == 1
        action_id = pending_events[0]["action_id"]
        stored = get_pending(action_id)
        assert stored is not None
        assert stored.tool_name == "fake_write"
        assert stored.args["path"] == "out.txt"
        assert confirms == [False]
        assert not any(e["type"] == "final" for e in events)
    finally:
        agent.WRITE_TOOL_NAMES.discard("fake_write")
        clear_pending()


def test_contract_build_contents_accepts_frontend_history_shape():
    provider = ContractProvider([])
    contents = provider.build_contents(
        "follow up",
        [
            {"role": "user", "parts": [{"text": "hello"}]},
            {"role": "model", "parts": [{"text": "hi"}]},
        ],
    )
    assert contents[0] == {"role": "user", "content": "follow up"}
    assert any(item.get("content") == "hello" for item in contents)
    assert any(item.get("content") == "hi" for item in contents)
