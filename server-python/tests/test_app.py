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
            json={
                "provider": "gemini",
                "model": "gemini-3.6-pro",
            },
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
    WRITE_TOOL_NAMES.
    """
    calls = []

    def fake_git_add(path=".", confirm=False):
        calls.append((path, confirm))
        return {"staged": True, "path": path}

    monkeypatch.setitem(app.TOOL_FUNCTIONS, "git_add", fake_git_add)

    action = create_pending(
        "git_add",
        {"path": "."},
        {"requires_confirmation": True},
    )

    response = client.post(
        "/confirm",
        json={"action_id": action.action_id, "confirmed": True},
    )

    assert response.status_code == 200
    assert response.get_json()["confirmed"] is True
    assert response.get_json()["result"]["staged"] is True
    assert calls == [(".", True)]
