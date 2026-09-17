"""Regression tests for provider timeout environment parsing."""

import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from providers import load_provider_config  # noqa: E402


@pytest.mark.parametrize(
    ("provider", "env_name"),
    [
        ("ollama", "OLLAMA_TIMEOUT"),
        ("kilo", "KILO_TIMEOUT"),
        ("openai", "OPENAI_TIMEOUT"),
        ("xai", "XAI_TIMEOUT"),
        ("openrouter", "OPENROUTER_TIMEOUT"),
        ("anthropic", "ANTHROPIC_TIMEOUT"),
        ("nvidia", "NVIDIA_TIMEOUT"),
    ],
)
def test_malformed_timeout_does_not_break_provider_config(
    provider, env_name, monkeypatch
):
    monkeypatch.setenv(env_name, "not-a-number")

    config = load_provider_config(provider)

    assert config.timeout == 120


@pytest.mark.parametrize("raw_value", ["0", "-1", "-120"])
def test_non_positive_timeout_uses_safe_default(raw_value, monkeypatch):
    monkeypatch.setenv("NVIDIA_TIMEOUT", raw_value)

    config = load_provider_config("nvidia")

    assert config.timeout == 120


def test_valid_timeout_is_preserved(monkeypatch):
    monkeypatch.setenv("NVIDIA_TIMEOUT", "45")

    config = load_provider_config("nvidia")

    assert config.timeout == 45


def test_whitespace_around_timeout_is_accepted(monkeypatch):
    monkeypatch.setenv("NVIDIA_TIMEOUT", " 45 ")

    config = load_provider_config("nvidia")

    assert config.timeout == 45
