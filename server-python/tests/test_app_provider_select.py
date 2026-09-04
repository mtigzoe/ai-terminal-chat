"""Regression tests for providers.get_provider()'s project_path handling.

Settings Save (POST /providers/select) can carry an optional
project_path alongside the provider switch. providers.get_provider()
validates that path, but must only persist and activate it *after*
the requested provider is constructed successfully — otherwise a
rejected provider switch (e.g. a missing API key) could still leave
the filesystem root pointed at the new path while every other part of
the request failed. This was fixed once already (see git history:
"Validate project path before applying provider settings") but had no
direct test coverage, so a future refactor could silently reintroduce
the ordering bug.
"""

import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import os  # noqa: E402

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402
import security  # noqa: E402
from pending import clear_pending  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Isolate the persisted-config file so these tests never touch the
    # developer's real ~/.ai-terminal-chat/config.json.
    config_dir = tmp_path / "config"
    monkeypatch.setattr(security, "_CONFIG_DIR", config_dir)
    monkeypatch.setattr(security, "_CONFIG_FILE", config_dir / "config.json")

    original_root = security.get_project_root()
    original_provider = app.provider

    app.app.testing = True
    with app.app.test_client() as client:
        yield client

    clear_pending()
    security.PROJECT_ROOT.set(Path(original_root))
    with app._provider_lock:
        app.provider = original_provider


def test_rejected_provider_switch_does_not_move_project_root(client, monkeypatch, tmp_path):
    """Selecting a misconfigured provider (Kilo, no API key) together
    with a valid project_path must fail the whole request and leave
    the project root exactly as it was before.
    """

    monkeypatch.delenv("KILO_API_KEY", raising=False)
    new_root = tmp_path / "new-project"
    new_root.mkdir()
    root_before = security.get_project_root()

    response = client.post(
        "/providers/select",
        json={"provider": "kilo", "project_path": str(new_root)},
    )

    assert response.status_code == 400
    assert security.get_project_root() == root_before
    assert security.get_project_root() != new_root.resolve()


def test_successful_provider_switch_applies_project_path(client, tmp_path, monkeypatch):
    """The companion positive case: when the provider switch succeeds,
    a valid project_path in the same request is applied.
    """

    monkeypatch.setenv("PROVIDER", "gemini")
    new_root = tmp_path / "applied-project"
    new_root.mkdir()

    response = client.post(
        "/providers/select",
        json={"provider": "gemini", "project_path": str(new_root)},
    )

    assert response.status_code == 200
    assert security.get_project_root() == new_root.resolve()


def test_nonexistent_project_path_rejected_without_changing_root(client):
    """A project_path that doesn't exist on disk must fail cleanly
    (not raise an unhandled exception) and must not change the root.
    """

    root_before = security.get_project_root()

    response = client.post(
        "/providers/select",
        json={"provider": "gemini", "project_path": "/does/not/exist/anywhere"},
    )

    assert response.status_code == 400
    assert security.get_project_root() == root_before


def test_blank_project_path_rejected_without_changing_root(client):
    root_before = security.get_project_root()

    response = client.post(
        "/providers/select",
        json={"provider": "gemini", "project_path": "   "},
    )

    assert response.status_code == 400
    assert security.get_project_root() == root_before


def test_provider_switch_without_project_path_leaves_root_untouched(client):
    """Omitting project_path entirely (the common case) must not touch
    the project root at all, successful switch or not.
    """

    root_before = security.get_project_root()

    response = client.post("/providers/select", json={"provider": "gemini"})

    assert response.status_code == 200
    assert security.get_project_root() == root_before


def test_ollama_selection_persists_custom_base_url(client, monkeypatch, tmp_path):
    """POST /providers/select with ollama_base_url stores it in config."""

    monkeypatch.setenv("OLLAMA_BASE_URL", "")

    response = client.post(
        "/providers/select",
        json={
            "provider": "ollama",
            "model": "llama3.1",
            "ollama_base_url": "cyber.local:11434",
        },
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["name"] == "ollama"
    assert data["model"] == "llama3.1"

    saved = security.load_provider_selection()
    assert saved["provider"] == "ollama"
    assert saved["model"] == "llama3.1"
    assert saved["ollama_base_url"] == "http://cyber.local:11434"


def test_ollama_url_restored_on_startup(monkeypatch, tmp_path):
    """Simulate a server restart: after selecting Ollama with a custom URL
    and then restarting (re-loading the provider from config), the active
    provider must use the persisted URL, not the default localhost."""

    # Isolate config.
    config_dir = tmp_path / "config"
    monkeypatch.setattr(security, "_CONFIG_DIR", config_dir)
    monkeypatch.setattr(security, "_CONFIG_FILE", config_dir / "config.json")

    # Step 1: persist the Ollama selection.
    security.persist_provider_selection(
        "ollama", model="llama3.1", ollama_base_url="cyber.local:11434"
    )
    assert security.load_provider_selection()["ollama_base_url"] == (
        "http://cyber.local:11434"
    )

    # Step 2: simulate server startup by clearing the in-memory provider
    # and the env var, then re-running the startup restore block.
    with app._provider_lock:
        app.provider = app.get_provider()

    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)

    # Re-execute the startup restore logic (mirrors the module-level block
    # in app.py).
    try:
        _saved = security.load_provider_selection()
    except Exception:
        _saved = {}

    if _saved.get("provider") == "ollama" and _saved.get("ollama_base_url"):
        os.environ["OLLAMA_BASE_URL"] = _saved["ollama_base_url"].strip()

    with app._provider_lock:
        app.provider = app.get_provider(
            _saved["provider"], model=_saved.get("model")
        )

    # Step 3: verify the active provider uses the restored URL.
    assert app.provider.name == "ollama"
    assert app.provider.model == "llama3.1"
    assert os.environ.get("OLLAMA_BASE_URL") == "http://cyber.local:11434"


def test_switching_from_ollama_clears_ollama_url(monkeypatch, tmp_path, client):
    """Switching from Ollama to a non-Ollama provider must not leave a
    stale OLLAMA_BASE_URL in the environment."""

    # Set up: Ollama with a custom URL is the active selection.
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://cyber.local:11434/v1")
    response = client.post(
        "/providers/select",
        json={"provider": "ollama", "model": "llama3.1"},
    )
    assert response.status_code == 200
    assert os.environ.get("OLLAMA_BASE_URL") == "http://cyber.local:11434/v1"

    # Act: switch to Gemini.
    response = client.post(
        "/providers/select",
        json={"provider": "gemini", "model": "gemini-2.0-flash"},
    )
    assert response.status_code == 200

    # Assert: OLLAMA_BASE_URL is cleared.
    assert "OLLAMA_BASE_URL" not in os.environ
    saved = security.load_provider_selection()
    assert saved.get("provider") == "gemini"
    assert "ollama_base_url" not in saved


def test_restart_after_switching_away_from_ollama_does_not_use_stale_url(
    monkeypatch, tmp_path
):
    """After switching from Ollama to Gemini, a simulated restart must not
    re-apply the old Ollama URL."""

    # Isolate config.
    config_dir = tmp_path / "config"
    monkeypatch.setattr(security, "_CONFIG_DIR", config_dir)
    monkeypatch.setattr(security, "_CONFIG_FILE", config_dir / "config.json")

    # Step 1: select Ollama with custom URL.
    security.persist_provider_selection(
        "ollama", model="llama3.1", ollama_base_url="cyber.local:11434"
    )

    # Step 2: switch to Gemini (which clears ollama_base_url from config).
    security.persist_provider_selection("gemini", model="gemini-2.0-flash")
    saved = security.load_provider_selection()
    assert saved["provider"] == "gemini"
    assert "ollama_base_url" not in saved

    # Step 3: simulate restart.
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    try:
        _saved = security.load_provider_selection()
    except Exception:
        _saved = {}

    if _saved.get("provider") == "ollama" and _saved.get("ollama_base_url"):
        os.environ["OLLAMA_BASE_URL"] = _saved["ollama_base_url"].strip()

    with app._provider_lock:
        app.provider = app.get_provider(
            _saved["provider"], model=_saved.get("model")
        )

    # Assert: Gemini is active and no Ollama URL is in the environment.
    assert app.provider.name == "gemini"
    assert "OLLAMA_BASE_URL" not in os.environ
