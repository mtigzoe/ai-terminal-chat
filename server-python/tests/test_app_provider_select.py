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
