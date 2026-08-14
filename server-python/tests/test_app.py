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
