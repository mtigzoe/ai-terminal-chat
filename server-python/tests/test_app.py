import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402
from pending import clear_pending, create_pending  # noqa: E402


@pytest.fixture
def client():
    app.app.testing = True
    with app.app.test_client() as client:
        yield client
    clear_pending()


def test_providers_endpoint_reports_current_and_supported(client):
    response = client.get("/providers")
    assert response.status_code == 200

    data = response.get_json()
    assert data["current"] == "gemini"
    assert data["providers"] == ["gemini", "ollama", "kilo"]
    assert data["current"] in data["providers"]
    assert "capabilities" in data
    assert "model" in data


def test_providers_endpoint_never_leaks_api_key(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "super-secret-key")

    response = client.get("/providers")
    assert response.status_code == 200
    assert "super-secret-key" not in response.get_data(as_text=True)


def test_providers_endpoint_skip_probe(client):
    response = client.get("/providers?probe=0")
    assert response.status_code == 200
    assert "available" not in response.get_json()


def test_providers_models_endpoint_rejects_unknown_provider(client):
    response = client.get("/providers/not-a-provider/models")
    assert response.status_code == 404
    assert "unknown provider" in response.get_json()["error"].lower()


def test_providers_models_endpoint_lists_ollama_models(client, monkeypatch):
    import providers as providers_module

    class FakeOllama:
        name = "ollama"
        capabilities = type(
            "Caps", (), {"model_listing": True, "to_dict": lambda self: {}}
        )()

        def list_models(self):
            return [{"id": "qwen3.5:9b"}, {"id": "llama3.1:8b"}]

    monkeypatch.setattr(
        providers_module, "get_provider", lambda name, model=None: FakeOllama()
    )
    monkeypatch.setattr(app, "get_provider", providers_module.get_provider)

    response = client.get("/providers/ollama/models")
    assert response.status_code == 200
    data = response.get_json()
    assert data["provider"] == "ollama"
    assert data["supports_listing"] is True
    assert [m["id"] for m in data["models"]] == ["qwen3.5:9b", "llama3.1:8b"]


def test_select_provider_rejects_unknown_name(client):
    response = client.post("/providers/select", json={"provider": "not-real"})
    assert response.status_code == 400
    assert "unknown provider" in response.get_json()["error"].lower()


def test_select_provider_requires_name(client):
    response = client.post("/providers/select", json={})
    assert response.status_code == 400
    assert "provider is required" in response.get_json()["error"].lower()


def test_select_provider_rejects_misconfigured_provider_without_switching(
    client, monkeypatch
):
    """Selecting Kilo with no KILO_API_KEY must fail cleanly and leave
    the previously active provider (gemini, from the test env) in place
    rather than leaving the app with no provider at all.
    """

    monkeypatch.delenv("KILO_API_KEY", raising=False)
    original_provider = app.provider

    response = client.post("/providers/select", json={"provider": "kilo"})

    assert response.status_code == 400
    assert "kilo" in response.get_json()["error"].lower()
    assert app.provider is original_provider


def test_select_provider_switches_active_provider(client, monkeypatch):
    monkeypatch.setenv("PROVIDER", "gemini")
    original_provider = app.provider

    try:
        response = client.post(
            "/providers/select",
            json={"provider": "gemini", "model": "gemini-3.6-pro"},
        )
        assert response.status_code == 200
        data = response.get_json()
        assert data["name"] == "gemini"
        assert data["model"] == "gemini-3.6-pro"
        assert app.provider.name == "gemini"
        assert app.provider.model == "gemini-3.6-pro"
    finally:
        with app._provider_lock:
            app.provider = original_provider


def test_cancel_endpoint_reports_unknown_request_id(client):
    response = client.post("/cancel/does-not-exist")
    assert response.status_code == 200
    assert response.get_json()["cancelled"] is False


def test_confirm_endpoint_requires_action_id(client):
    response = client.post("/confirm", json={"confirmed": True})
    assert response.status_code == 400
    assert "action_id" in response.get_json()["error"]


def test_confirm_endpoint_executes_stored_write_once(client, monkeypatch):
    calls = []

    def fake_write(path, confirm=False):
        calls.append((path, confirm))
        return {"written": True, "path": path}

    monkeypatch.setitem(app.TOOL_FUNCTIONS, "fake_write", fake_write)
    app.WRITE_TOOL_NAMES.add("fake_write")

    try:
        action = create_pending(
            "fake_write",
            {"path": "example.txt"},
            {"requires_confirmation": True},
        )

        response = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )

        assert response.status_code == 200
        assert response.get_json()["confirmed"] is True
        assert response.get_json()["result"]["written"] is True
        assert calls == [("example.txt", True)]

        second = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )
        assert second.status_code == 404
    finally:
        app.WRITE_TOOL_NAMES.discard("fake_write")


def test_confirm_endpoint_accepts_git_category_actions(client, monkeypatch):
    """/confirm must authorize git_add even though it's not in
    WRITE_TOOL_NAMES — it's gated via GIT_CONFIRM_TOOL_NAMES instead.
    """

    calls = []

    def fake_git_add(path, confirm=False):
        calls.append((path, confirm))
        return {"path": path, "staged": True}

    monkeypatch.setitem(app.TOOL_FUNCTIONS, "git_add", fake_git_add)

    action = create_pending(
        "git_add",
        {"path": "example.txt"},
        {"requires_confirmation": True, "path": "example.txt"},
    )

    response = client.post(
        "/confirm",
        json={"action_id": action.action_id, "confirmed": True},
    )

    assert response.status_code == 200
    assert response.get_json()["result"]["staged"] is True
    assert calls == [("example.txt", True)]


def test_confirm_endpoint_rejects_actions_outside_both_categories(client):
    """A pending action for a tool that is neither a write tool nor a
    git-confirm tool must still be refused — expanding the gate to
    cover git must not accidentally widen it to everything.
    """

    action = create_pending(
        "run_command",
        {"command": "pytest"},
        {"requires_confirmation": True},
    )

    response = client.post(
        "/confirm",
        json={"action_id": action.action_id, "confirmed": True},
    )

    assert response.status_code == 400
    assert "only pending write actions" in response.get_json()["error"].lower()


# ---------------------------------------------------------
# /confirm lifecycle: one-time authorization, no replay
# ---------------------------------------------------------

def test_confirm_endpoint_forged_action_id_fails(client):
    """An action_id the server never issued must never execute anything."""

    response = client.post(
        "/confirm",
        json={"action_id": "not-a-real-action-id", "confirmed": True},
    )

    assert response.status_code == 404
    assert "not found" in response.get_json()["error"].lower()


def test_confirm_endpoint_cancellation_consumes_the_action(client):
    """Declining (confirmed=false) must consume the action just like a
    successful execution — a cancelled action can't later be approved.
    """

    action = create_pending(
        "delete_file",
        {"path": "example.txt"},
        {"requires_confirmation": True},
    )

    cancel = client.post(
        "/confirm",
        json={"action_id": action.action_id, "confirmed": False},
    )
    assert cancel.status_code == 200
    body = cancel.get_json()
    assert body["confirmed"] is False
    assert body["cancelled"] is True

    replay = client.post(
        "/confirm",
        json={"action_id": action.action_id, "confirmed": True},
    )
    assert replay.status_code == 404


def test_confirm_endpoint_failed_execution_consumes_the_action(client, monkeypatch):
    """A tool that reports an error on confirm=True must still consume
    the one-time action id. If it didn't, a client could keep retrying
    an errored (but possibly partially-applied) action indefinitely.
    """

    def failing_write(path, confirm=False):
        return {"error": "disk full"}

    monkeypatch.setitem(app.TOOL_FUNCTIONS, "fake_write", failing_write)
    app.WRITE_TOOL_NAMES.add("fake_write")

    try:
        action = create_pending(
            "fake_write",
            {"path": "example.txt"},
            {"requires_confirmation": True},
        )

        response = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )
        assert response.status_code == 400
        assert response.get_json()["result"]["error"] == "disk full"

        retry = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )
        assert retry.status_code == 404
    finally:
        app.WRITE_TOOL_NAMES.discard("fake_write")


def test_confirm_endpoint_timeout_consumes_the_action(client, monkeypatch):
    """A tool that exceeds its timeout on confirm=True must still
    consume the action id, even though the underlying thread keeps
    running in the background (ThreadPoolExecutor futures aren't
    cancelled by a client-side timeout). Not consuming it here would
    let a retry trigger a second, concurrent execution of the same
    mutating tool while the first is still in flight.
    """

    import time

    def slow_write(path, confirm=False):
        time.sleep(1)
        return {"written": True, "path": path}

    monkeypatch.setitem(app.TOOL_FUNCTIONS, "fake_write", slow_write)
    monkeypatch.setitem(app.TOOL_TIMEOUTS, "fake_write", 0.05)
    app.WRITE_TOOL_NAMES.add("fake_write")

    try:
        action = create_pending(
            "fake_write",
            {"path": "example.txt"},
            {"requires_confirmation": True},
        )

        response = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )
        assert response.status_code == 504
        assert "exceeded its" in response.get_json()["error"]

        retry = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )
        assert retry.status_code == 404
    finally:
        app.WRITE_TOOL_NAMES.discard("fake_write")


def test_confirm_endpoint_double_confirmation_rejected(client, monkeypatch):
    """A successfully executed action cannot be confirmed a second
    time — the one-time token is gone even though it succeeded.
    """

    def fake_write(path, confirm=False):
        return {"written": True, "path": path}

    monkeypatch.setitem(app.TOOL_FUNCTIONS, "fake_write", fake_write)
    app.WRITE_TOOL_NAMES.add("fake_write")

    try:
        action = create_pending(
            "fake_write",
            {"path": "example.txt"},
            {"requires_confirmation": True},
        )

        first = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )
        assert first.status_code == 200

        second = client.post(
            "/confirm",
            json={"action_id": action.action_id, "confirmed": True},
        )
        assert second.status_code == 404
    finally:
        app.WRITE_TOOL_NAMES.discard("fake_write")


def test_confirm_endpoint_ignores_client_supplied_tool_and_args(client, monkeypatch):
    """The stored tool_name/args from the model's original request are
    authoritative. A client cannot redirect a confirmation to a
    different tool or different arguments by adding extra fields to
    the /confirm request body — /confirm only ever reads action_id and
    confirmed from the request.
    """

    calls = []

    def real_write(path, confirm=False):
        calls.append((path, confirm))
        return {"written": True, "path": path}

    def other_write(path, confirm=False):
        calls.append(("OTHER-TOOL-CALLED", path, confirm))
        return {"written": True, "path": path}

    monkeypatch.setitem(app.TOOL_FUNCTIONS, "fake_write", real_write)
    monkeypatch.setitem(app.TOOL_FUNCTIONS, "other_tool", other_write)
    app.WRITE_TOOL_NAMES.add("fake_write")
    app.WRITE_TOOL_NAMES.add("other_tool")

    try:
        action = create_pending(
            "fake_write",
            {"path": "safe.txt"},
            {"requires_confirmation": True},
        )

        response = client.post(
            "/confirm",
            json={
                "action_id": action.action_id,
                "confirmed": True,
                # An attacker-controlled client tries to redirect the
                # confirmation to a different tool/target. Must be
                # silently ignored in favor of the stored action.
                "tool_name": "other_tool",
                "args": {"path": "../../etc/passwd"},
            },
        )

        assert response.status_code == 200
        assert response.get_json()["tool"] == "fake_write"
        assert calls == [("safe.txt", True)]
    finally:
        app.WRITE_TOOL_NAMES.discard("fake_write")
        app.WRITE_TOOL_NAMES.discard("other_tool")
