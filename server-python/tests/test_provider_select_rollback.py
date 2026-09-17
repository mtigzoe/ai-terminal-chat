"""Regression tests for atomic /providers/select behavior.

A failed persistence step must not leave the runtime provider or related
environment variables changed. Otherwise the UI reports an error while the
running server silently uses a provider different from persisted settings.
"""

import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402
import security  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    config_dir = tmp_path / "config"
    monkeypatch.setattr(security, "_CONFIG_DIR", config_dir)
    monkeypatch.setattr(security, "_CONFIG_FILE", config_dir / "config.json")

    original_provider = app.provider
    original_ollama_url = os.environ.get("OLLAMA_BASE_URL")
    original_gemini_key = os.environ.get("GOOGLE_API_KEY")

    app.app.testing = True
    with app.app.test_client() as client:
        yield client

    with app._provider_lock:
        app.provider = original_provider
    if original_ollama_url is None:
        os.environ.pop("OLLAMA_BASE_URL", None)
    else:
        os.environ["OLLAMA_BASE_URL"] = original_ollama_url
    if original_gemini_key is None:
        os.environ.pop("GOOGLE_API_KEY", None)
    else:
        os.environ["GOOGLE_API_KEY"] = original_gemini_key


def test_persistence_failure_rolls_back_provider_and_ollama_url(
    client, monkeypatch
):
    """A failed config write must leave the active provider unchanged."""

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://old-host:11434/v1")
    before_provider = app.provider
    before_url = os.environ["OLLAMA_BASE_URL"]

    def fail_persist(*args, **kwargs):
        raise ValueError("simulated config write failure")

    monkeypatch.setattr(app, "persist_provider_selection", fail_persist)

    response = client.post(
        "/providers/select",
        json={"provider": "gemini", "model": "gemini-test"},
    )

    assert response.status_code == 400
    assert app.provider is before_provider
    assert app.provider.name == before_provider.name
    assert os.environ.get("OLLAMA_BASE_URL") == before_url


def test_persistence_failure_rolls_back_api_key(client, monkeypatch):
    """A failed config write must restore a replaced API key too."""

    monkeypatch.setenv("GOOGLE_API_KEY", "old-key")
    before_provider = app.provider

    def fail_persist(*args, **kwargs):
        raise ValueError("simulated config write failure")

    monkeypatch.setattr(app, "persist_provider_selection", fail_persist)

    response = client.post(
        "/providers/select",
        json={
            "provider": "gemini",
            "model": "gemini-test",
            "api_key": "new-key",
        },
    )

    assert response.status_code == 400
    assert app.provider is before_provider
    assert os.environ.get("GOOGLE_API_KEY") == "old-key"
