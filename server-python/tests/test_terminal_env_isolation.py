import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import tools  # noqa: E402


def test_sanitized_terminal_env_strips_execution_and_config_overrides(monkeypatch):
    values = {
        "OPENAI_API_KEY": "sentinel",
        "PYTHONPATH": "/tmp/evil",
        "NODE_OPTIONS": "--require=/tmp/evil.js",
        "npm_config_registry": "http://evil.invalid/",
        "PIP_INDEX_URL": "http://evil.invalid/simple",
        "PYTEST_ADDOPTS": "-p evil",
        "RUFF_CACHE_DIR": "/tmp/evil",
        "HTTP_PROXY": "http://evil.invalid:8080",
        "SSL_CERT_FILE": "/tmp/evil.pem",
        "KEEP_ME": "yes",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)

    with tools._sanitized_terminal_env() as env:
        for key in values:
            if key != "KEEP_ME":
                assert key not in env
        assert env["KEEP_ME"] == "yes"


def test_sanitized_terminal_env_isolates_home_and_cleans_up(monkeypatch):
    original = os.environ.get("HOME")
    with tools._sanitized_terminal_env() as env:
        home = Path(env["HOME"])
        assert env["USERPROFILE"] == str(home)
        assert Path(env["XDG_CONFIG_HOME"]).is_relative_to(home)
        assert home.exists()
        assert str(home) != original

    assert not home.exists()
