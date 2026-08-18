"""Unit tests for offline/local Ollama reliability improvements.

These tests mock the network and focus on actionable status messages when
Ollama is unreachable or the configured model is missing — the common
failure modes for local development.
"""

import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from ollama import (  # noqa: E402
    OllamaProvider,
    model_ids_match,
    native_and_openai_urls,
)


def test_model_ids_match_accepts_latest_tag_variants():
    assert model_ids_match("llama3.1", "llama3.1")
    assert model_ids_match("llama3.1", "llama3.1:latest")
    assert model_ids_match("llama3.1:latest", "llama3.1")
    assert not model_ids_match("llama3.1", "qwen3.5:9b")
    assert not model_ids_match("", "llama3.1")


def test_ollama_refresh_capabilities_notes_unreachable_server():
    provider = OllamaProvider(
        base_url="http://localhost:11434/v1",
        model="llama3.1",
    )

    with patch(
        "ollama.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        caps = provider.refresh_capabilities()

    assert "Could not reach Ollama" in caps.notes
    assert "ollama serve" in caps.notes.lower() or "localhost" in caps.notes


def test_ollama_refresh_capabilities_notes_empty_model_catalog():
    provider = OllamaProvider(
        base_url="http://localhost:11434/v1",
        model="llama3.1",
    )
    empty_tags = Mock(status_code=200)
    empty_tags.json.return_value = {"models": []}

    with patch("ollama.requests.request", return_value=empty_tags):
        caps = provider.refresh_capabilities()

    assert "no models are installed" in caps.notes
    assert "ollama pull" in caps.notes


def test_ollama_refresh_capabilities_notes_missing_configured_model():
    provider = OllamaProvider(
        base_url="http://localhost:11434/v1",
        model="missing-model",
    )
    tags = Mock(status_code=200)
    tags.json.return_value = {
        "models": [{"name": "llama3.1:latest", "size": 1}],
    }

    with patch("ollama.requests.request", return_value=tags):
        caps = provider.refresh_capabilities()

    assert "is not installed" in caps.notes
    assert "missing-model" in caps.notes
    assert "ollama pull missing-model" in caps.notes


def test_ollama_has_model_matches_latest_tag():
    provider = OllamaProvider(
        base_url="http://localhost:11434/v1",
        model="llama3.1",
    )
    tags = Mock(status_code=200)
    tags.json.return_value = {
        "models": [{"name": "llama3.1:latest"}],
    }

    with patch("ollama.requests.request", return_value=tags):
        assert provider.has_model("llama3.1") is True
        assert provider.has_model("other") is False


def test_ollama_generate_raises_clear_error_when_model_missing():
    provider = OllamaProvider(
        base_url="http://localhost:11434/v1",
        model="gone",
    )
    tags = Mock(status_code=200)
    tags.json.return_value = {"models": [{"name": "llama3.1"}]}

    with patch("ollama.requests.request", return_value=tags):
        provider.refresh_capabilities()
        with pytest.raises(RuntimeError, match="is not installed"):
            provider.generate([{"role": "user", "content": "hi"}])


def test_native_and_openai_urls_defaults():
    native, openai = native_and_openai_urls("")
    assert native == "http://localhost:11434"
    assert openai == "http://localhost:11434/v1"


def test_ollama_refresh_capabilities_clears_notes_when_model_available():
    """Configured model present and advertising tools → empty notes."""
    provider = OllamaProvider(
        base_url="http://localhost:11434/v1",
        model="llama3.1",
    )
    tags = Mock(status_code=200)
    tags.json.return_value = {"models": [{"name": "llama3.1:latest"}]}
    show = Mock(status_code=200)
    show.json.return_value = {"capabilities": ["completion", "tools"]}

    def request_side_effect(method, url, **kwargs):
        if str(url).endswith("/api/tags"):
            return tags
        if str(url).endswith("/api/show"):
            return show
        raise AssertionError(url)

    with patch("ollama.requests.request", side_effect=request_side_effect):
        caps = provider.refresh_capabilities()
        assert provider.has_model("llama3.1") is True

    assert caps.notes == ""
    assert caps.tools is True
