"""HTTP-level tests for /chat and /stream.

Before this file, agent.run_agent_loop() had thorough unit coverage
(tests/test_agent.py) but the two HTTP endpoints that wrap it — /chat
and /stream in app.py — had no direct tests at all: nothing exercised
request parsing, status-code mapping, or the endpoints' own
exception handling. These tests fill that gap using the same
FakeProvider/FailingProvider pattern already used in test_agent.py,
substituted in for the module-level `app.provider`.
"""

import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import os  # noqa: E402

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402
import cancellation  # noqa: E402
from base import Provider, ProviderResponse, ToolCall  # noqa: E402
from pending import clear_pending  # noqa: E402


class FakeProvider(Provider):
    """Scripted provider: returns each response in `responses` in order."""

    def __init__(self, responses):
        self.responses = iter(responses)
        self.name = "fake"
        self.model = "fake-model"

    def build_contents(self, msg, history):
        return [{"role": "user", "content": msg}]

    def generate(self, contents):
        return next(self.responses)

    def append_model_turn(self, contents, response):
        return contents + [{"role": "assistant", "response": response}]

    def append_tool_results(self, contents, results):
        return contents + [{"role": "tool", "results": results}]


class FailingProvider(Provider):
    """Provider whose generate() always raises, simulating an outage."""

    name = "failing"
    model = "failing-model"

    def build_contents(self, msg, history):
        return []

    def generate(self, contents):
        raise RuntimeError("provider offline")

    def append_model_turn(self, contents, response):
        return contents

    def append_tool_results(self, contents, results):
        return contents


class BadHistoryProvider(FakeProvider):
    """build_contents() raises, simulating an unparseable history payload."""

    def build_contents(self, msg, history):
        raise ValueError("history entry missing 'role'")


@pytest.fixture
def client():
    app.app.testing = True
    with app.app.test_client() as client:
        yield client
    clear_pending()
    cancellation.clear()


def _set_provider(monkeypatch, provider):
    monkeypatch.setattr(app, "provider", provider)


# ---------------------------------------------------------
# /chat
# ---------------------------------------------------------


def test_chat_happy_path_returns_final_text(client, monkeypatch):
    _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="hello there")]))

    response = client.post("/chat", json={"chat": "hi", "history": []})

    assert response.status_code == 200
    data = response.get_json()
    assert data["text"] == "hello there"
    # No tool calls were made, so tool_activity should contain only
    # lifecycle progress events (e.g. "plan", "complete"), never a
    # tool_call or tool_result entry.
    assert all(event["type"] == "progress" for event in data["tool_activity"])
    assert "request_id" in data


def test_chat_reports_tool_activity(client, monkeypatch):
    _set_provider(
        monkeypatch,
        FakeProvider(
            [
                ProviderResponse(
                    text=None,
                    tool_calls=[ToolCall("list_files", {"path": "."})],
                ),
                ProviderResponse(text="done"),
            ]
        ),
    )

    response = client.post("/chat", json={"chat": "list files", "history": []})

    assert response.status_code == 200
    data = response.get_json()
    assert data["text"] == "done"
    tool_calls = [e for e in data["tool_activity"] if e["type"] == "tool_call"]
    tool_results = [e for e in data["tool_activity"] if e["type"] == "tool_result"]
    assert tool_calls and tool_calls[0]["name"] == "list_files"
    assert tool_results and tool_results[0]["name"] == "list_files"


def test_chat_rejects_empty_message(client):
    response = client.post("/chat", json={"chat": "   ", "history": []})

    assert response.status_code == 400
    data = response.get_json()
    assert data["text"] == ""
    assert "empty" in data["error"].lower()


def test_chat_rejects_missing_body(client):
    """No JSON body at all must not crash the server."""

    response = client.post("/chat", data="not json", content_type="text/plain")

    assert response.status_code == 400
    assert "empty" in response.get_json()["error"].lower()


def test_chat_reports_build_contents_failure_as_400(client, monkeypatch):
    _set_provider(monkeypatch, BadHistoryProvider([ProviderResponse(text="unused")]))

    response = client.post(
        "/chat", json={"chat": "hi", "history": [{"broken": True}]}
    )

    assert response.status_code == 400
    data = response.get_json()
    assert data["text"] == ""
    assert "could not process conversation history" in data["error"].lower()


def test_chat_reports_provider_failure_as_502(client, monkeypatch):
    _set_provider(monkeypatch, FailingProvider())

    response = client.post("/chat", json={"chat": "hi", "history": []})

    assert response.status_code == 502
    data = response.get_json()
    assert data["text"] == ""
    assert "provider offline" in data["error"]


def test_chat_reports_cancellation(client, monkeypatch):
    """A request cancelled mid-flight must return cancelled=True, not an error."""

    def fake_register(request_id):
        from threading import Event

        event = Event()
        event.set()
        return event

    monkeypatch.setattr(cancellation, "register", fake_register)
    _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="unused")]))

    response = client.post(
        "/chat", json={"chat": "hi", "history": [], "request_id": "abc123"}
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["cancelled"] is True
    assert data["request_id"] == "abc123"


def test_chat_unexpected_internal_error_does_not_crash_server(client, monkeypatch):
    """Even a bug in run_agent_loop itself must surface as JSON, not a raw 500."""

    def boom(*args, **kwargs):
        raise RuntimeError("unexpected internal failure")
        yield  # pragma: no cover - makes this a generator function

    monkeypatch.setattr(app, "run_agent_loop", boom)
    _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="unused")]))

    response = client.post("/chat", json={"chat": "hi", "history": []})

    assert response.status_code == 502
    data = response.get_json()
    assert data["text"] == ""
    assert "unexpected server error" in data["error"].lower()
    assert "unexpected internal failure" in data["error"]


def test_chat_releases_cancellation_tracking_after_completion(client, monkeypatch):
    """A finished request's id must not remain tracked as cancellable."""

    _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="done")]))

    response = client.post(
        "/chat", json={"chat": "hi", "history": [], "request_id": "track-me"}
    )
    assert response.status_code == 200

    cancel_response = client.post("/cancel/track-me")
    assert cancel_response.get_json()["cancelled"] is False


# ---------------------------------------------------------
# /stream
# ---------------------------------------------------------


def test_stream_happy_path_yields_final_text(client, monkeypatch):
    _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="streamed hello")]))

    response = client.post("/stream", json={"chat": "hi", "history": []})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "streamed hello" in body


def test_stream_rejects_empty_message(client):
    response = client.post("/stream", json={"chat": "", "history": []})

    assert response.status_code == 200
    assert "Please enter a message." in response.get_data(as_text=True)


def test_stream_reports_build_contents_failure_inline(client, monkeypatch):
    _set_provider(monkeypatch, BadHistoryProvider([ProviderResponse(text="unused")]))

    response = client.post(
        "/stream", json={"chat": "hi", "history": [{"broken": True}]}
    )

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "Error building request" in body


def test_stream_reports_provider_failure_inline(client, monkeypatch):
    _set_provider(monkeypatch, FailingProvider())

    response = client.post("/stream", json={"chat": "hi", "history": []})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "[Error:" in body
    assert "provider offline" in body


def test_stream_reports_cancellation_inline(client, monkeypatch):
    def fake_register(request_id):
        from threading import Event

        event = Event()
        event.set()
        return event

    monkeypatch.setattr(cancellation, "register", fake_register)
    _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="unused")]))

    response = client.post(
        "/stream", json={"chat": "hi", "history": [], "request_id": "abc123"}
    )

    assert response.status_code == 200
    assert "[cancelled]" in response.get_data(as_text=True)


def test_stream_tool_result_errors_are_surfaced_inline(client, monkeypatch):
    _set_provider(
        monkeypatch,
        FakeProvider(
            [
                ProviderResponse(
                    text=None,
                    tool_calls=[ToolCall("read_file", {"path": "missing.txt"})],
                ),
                ProviderResponse(text="handled the missing file"),
            ]
        ),
    )

    response = client.post("/stream", json={"chat": "read missing.txt", "history": []})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "read_file" in body
    assert "handled the missing file" in body


def test_stream_tool_call_and_error_markers_are_correctly_encoded(client, monkeypatch):
    """The plain-text /stream format prefixes tool calls and tool errors
    with emoji markers (gear for tool_call, warning for a failed
    tool_result). These must round-trip as the real ⚙️/⚠️ codepoints —
    not as mojibake produced by a stray non-UTF-8 encode/decode
    somewhere in the file's history, which previous substring-only
    assertions (checking for "read_file" alone) failed to catch.
    """
    _set_provider(
        monkeypatch,
        FakeProvider(
            [
                ProviderResponse(
                    text=None,
                    tool_calls=[ToolCall("read_file", {"path": "missing.txt"})],
                ),
                ProviderResponse(text="handled the missing file"),
            ]
        ),
    )

    response = client.post("/stream", json={"chat": "read missing.txt", "history": []})

    assert response.status_code == 200
    body = response.get_data(as_text=True)

    assert "⚙️ read_file(" in body
    assert "⚠️ read_file:" in body

    # Guard against regressing back into the specific mojibake this
    # replaced (UTF-8 emoji bytes misread as CP437 and re-saved as UTF-8).
    assert "\u0393\u00dc\u00d6" not in body  # mangled gear emoji ("ΓÜÖ")
    assert "\u0393\u00dc\u00e1" not in body  # mangled warning emoji ("ΓÜá")


def test_stream_git_status_no_arg_call_renders_without_extra_bracket(client, monkeypatch):
    _set_provider(
        monkeypatch,
        FakeProvider(
            [
                ProviderResponse(
                    text=None,
                    tool_calls=[ToolCall("git_status", {})],
                ),
                ProviderResponse(text="working tree clean"),
            ]
        ),
    )

    response = client.post("/stream", json={"chat": "git status", "history": []})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "⚙️ git_status()" in body
    assert "git_status()]" not in body


def test_stream_git_push_origin_branch_routes_to_git_push_tool(client, monkeypatch):
    _set_provider(
        monkeypatch,
        FakeProvider(
            [
                ProviderResponse(
                    text=None,
                    tool_calls=[ToolCall("git_push", {"remote": "origin", "branch": "fix-git-command-routing"})],
                ),
                ProviderResponse(text="pushed"),
            ]
        ),
    )

    response = client.post("/stream", json={"chat": "git push origin fix-git-command-routing", "history": []})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "git_push" in body
    assert "fix-git-command-routing" in body


def test_stream_git_commit_with_message_routes_to_git_commit_tool(client, monkeypatch):
    _set_provider(
        monkeypatch,
        FakeProvider(
            [
                ProviderResponse(
                    text=None,
                    tool_calls=[ToolCall("git_commit", {"message": "add feature"})],
                ),
                ProviderResponse(text="committed"),
            ]
        ),
    )

    response = client.post("/stream", json={"chat": 'git commit -m "add feature"', "history": []})

    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "git_commit" in body
    assert "add feature" in body


# ---------------------------------------------------------
# Global error handler (app.handle_unexpected_error)
# ---------------------------------------------------------


def test_unhandled_exception_on_any_route_returns_json_500(client, monkeypatch):
    """A bug in a route that isn't already caught locally must still
    come back as structured JSON via the catch-all error handler,
    rather than crashing the process or returning Flask's default
    HTML error page.
    """

    def boom():
        raise RuntimeError("boom from project-root")

    monkeypatch.setattr(app, "get_project_root", boom)

    response = client.get("/project-root")

    assert response.status_code == 500
    data = response.get_json()
    assert data["text"] == ""
    assert "unexpected server error" in data["error"].lower()
    assert "boom from project-root" in data["error"]
