"""Smoke tests for the server-python application.

These are fast, deterministic, high-level checks that the server is not
fundamentally broken. They deliberately avoid duplicating the detailed
assertions already covered by test_app.py, test_app_chat_endpoints.py,
and the other focused test files.
"""

import json
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


# ---------------------------------------------------------------------------
# Minimal test doubles
# ---------------------------------------------------------------------------

class FakeProvider(Provider):
    """Scripted provider: returns each response in `responses` in order."""

    def __init__(self, responses):
        self.responses = iter(responses)
        self.name = "fake"
        self.model = "fake-model"

    def build_contents(self, msg, history, user_instructions=None):
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

    def build_contents(self, msg, history, user_instructions=None):
        return []

    def generate(self, contents):
        raise RuntimeError("provider offline")

    def append_model_turn(self, contents, response):
        return contents

    def append_tool_results(self, contents, results):
        return contents


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    app.app.testing = True
    with app.app.test_client() as client:
        yield client
    clear_pending()
    cancellation.clear()


def _set_provider(monkeypatch, provider):
    monkeypatch.setattr(app, "provider", provider)


# ---------------------------------------------------------------------------
# Smoke tests
# ---------------------------------------------------------------------------

class TestServerInitialization:
    """The application must start and expose its critical endpoints."""

    def test_app_has_expected_routes(self):
        """A freshly imported app module exposes the routes the client
        depends on."""
        rules = [rule.rule for rule in app.app.url_map.iter_rules()]
        for path in ["/chat", "/stream", "/providers", "/providers/select"]:
            assert path in rules, f"Missing route: {path}"

    def test_providers_endpoint_returns_current_provider(self, client):
        response = client.get("/providers")
        assert response.status_code == 200
        data = response.get_json()
        assert "name" in data
        assert "model" in data
        assert "providers" in data


class TestChatEndpoint:
    """Minimal valid /chat requests succeed and malformed ones fail cleanly."""

    def test_chat_minimal_request_returns_200(self, client, monkeypatch):
        _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="smoke ok")]))

        response = client.post("/chat", json={"chat": "hi", "history": []})
        assert response.status_code == 200
        data = response.get_json()
        assert data["text"] == "smoke ok"
        assert "request_id" in data

    def test_chat_rejects_empty_message(self, client):
        response = client.post("/chat", json={"chat": "   ", "history": []})
        assert response.status_code == 400
        assert "error" in response.get_json()

    def test_chat_handles_provider_failure_gracefully(self, client, monkeypatch):
        _set_provider(monkeypatch, FailingProvider())

        response = client.post("/chat", json={"chat": "hi", "history": []})
        # The endpoint catches provider exceptions and returns 502.
        assert response.status_code == 502
        data = response.get_json()
        assert "error" in data


class TestStreamEndpoint:
    """/stream must return events for a valid request."""

    def test_stream_minimal_request_returns_events(self, client, monkeypatch):
        _set_provider(monkeypatch, FakeProvider([ProviderResponse(text="streamed ok")]))

        response = client.post("/stream", json={"chat": "hi", "history": []})
        assert response.status_code == 200
        text = response.get_data(as_text=True)
        events = [json.loads(line) for line in text.strip().split("\n") if line.strip()]
        assert any(e.get("type") == "final" for e in events)
        assert any(e.get("text") == "streamed ok" for e in events)


class TestProviderSelection:
    """The Settings/Provider path must allow switching providers."""

    def test_select_provider_switches_and_reports_status(self, client, monkeypatch):
        # This follows the same pattern as the existing
        # test_select_provider_switches_active_provider in test_app.py:
        # the real /providers/select endpoint is exercised, but the
        # provider factory is not mocked away. In practice this does
        # not make a real external API call because GeminiProvider.probe()
        # handles auth/network failures gracefully and returns a status
        # dict rather than raising.
        original = app.provider
        try:
            response = client.post(
                "/providers/select",
                json={"provider": "gemini", "model": "gemini-3.6-flash"},
            )
            assert response.status_code == 200
            data = response.get_json()
            assert data["name"] == "gemini"
            assert data["model"] == "gemini-3.6-flash"
        finally:
            with app._provider_lock:
                app.provider = original

    def test_select_unknown_provider_returns_400(self, client):
        response = client.post("/providers/select", json={"provider": "not-real"})
        assert response.status_code == 400
        assert "unknown" in response.get_json()["error"].lower()


class TestUserInstructionsPath:
    """user_instructions must reach the provider without breaking the endpoint."""

    def test_chat_forwards_user_instructions(self, client, monkeypatch):
        captured = {}

        class CapturingProvider(FakeProvider):
            def build_contents(self, msg, history, user_instructions=None):
                captured["user_instructions"] = user_instructions
                return super().build_contents(msg, history, user_instructions=user_instructions)

        _set_provider(monkeypatch, CapturingProvider([ProviderResponse(text="ok")]))

        response = client.post(
            "/chat",
            json={"chat": "hi", "history": [], "user_instructions": "Be concise."},
        )
        assert response.status_code == 200
        assert captured["user_instructions"] == "Be concise."

    def test_chat_treats_whitespace_instructions_as_none(self, client, monkeypatch):
        captured = {}

        class CapturingProvider(FakeProvider):
            def build_contents(self, msg, history, user_instructions=None):
                captured["user_instructions"] = user_instructions
                return super().build_contents(msg, history, user_instructions=user_instructions)

        # Provide three responses because the loop sends three requests.
        _set_provider(monkeypatch, CapturingProvider([ProviderResponse(text="ok")] * 3))

        for payload in [{}, {"user_instructions": ""}, {"user_instructions": "   "}]:
            captured.clear()
            response = client.post("/chat", json={"chat": "hi", "history": [], **payload})
            assert response.status_code == 200
            assert captured["user_instructions"] is None


class TestToolAgentPath:
    """A basic tool-calling round trip must flow through /chat end to end."""

    def test_chat_reports_tool_activity(self, client, monkeypatch):
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
