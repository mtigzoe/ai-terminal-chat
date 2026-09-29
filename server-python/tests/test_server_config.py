"""Regression tests for Python server runtime configuration."""

import os
import subprocess
import sys
from importlib import import_module
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

server_config = import_module("server_config")
get_server_port = server_config.get_server_port
parse_server_port = server_config.parse_server_port


@pytest.mark.parametrize(
    ("raw_value", "expected"),
    [
        (None, 9000),
        ("", 9000),
        ("   ", 9000),
        ("not-a-number", 9000),
        ("9000suffix", 9000),
        ("-1", 9000),
        ("65536", 9000),
        ("0", 0),
        (" 8080 ", 8080),
        ("+443", 443),
        ("65535", 65535),
    ],
)
def test_parse_server_port(raw_value, expected):
    assert parse_server_port(raw_value) == expected


def test_get_server_port_reads_the_environment(monkeypatch):
    monkeypatch.setenv("PORT", "not-a-number")

    assert get_server_port() == 9000


@pytest.mark.parametrize(
    "entrypoint",
    ["app.py", "app_original.py", "secure_server.py"],
)
def test_server_entrypoint_uses_validated_port(entrypoint, tmp_path):
    runner = """
import runpy
import sys
from flask import Flask

Flask.run = lambda self, **kwargs: print(f"PORT={kwargs['port']}")
runpy.run_path(sys.argv[1], run_name="__main__")
"""
    env = os.environ.copy()
    env.update(
        {
            "HOME": str(tmp_path),
            "HOST": "127.0.0.1",
            "PORT": "not-a-number",
            "PROVIDER": "ollama",
            "USERPROFILE": str(tmp_path),
        }
    )

    result = subprocess.run(
        [sys.executable, "-c", runner, str(SERVER_DIR / entrypoint)],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "PORT=9000" in result.stdout
