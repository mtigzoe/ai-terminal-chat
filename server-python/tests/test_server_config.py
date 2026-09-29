"""Regression tests for Python server runtime configuration.

Every Flask entry point (``app.py``, ``app_original.py``, and
``secure_server.py``) used to bind its port with a bare
``int(os.getenv("PORT", "9000"))``. A malformed ``PORT`` therefore raised an
unhandled ``ValueError`` at startup, so the server could not boot at all
(and ``secure_server.py`` could not even be imported). The port is now
validated in ``server_config.py``, mirroring the TypeScript server's
``loadServerConfig()``.
"""

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


def test_get_server_port_preserves_a_valid_environment_value(monkeypatch):
    monkeypatch.setenv("PORT", "8080")

    assert get_server_port() == 8080


# Run an entry point in a subprocess with Flask.run() replaced, so the bound
# port is observable without actually starting a listening server.
WORKER = """
import runpy
import sys

from flask import Flask

Flask.run = lambda self, **kwargs: print(f"PORT={kwargs['port']}")
runpy.run_path(sys.argv[1], run_name="__main__")
"""


@pytest.mark.parametrize(
    ("raw_port", "expected_port"),
    [("not-a-number", "9000"), ("99999", "9000"), ("8080", "8080")],
)
@pytest.mark.parametrize(
    "entrypoint",
    ["app.py", "app_original.py", "secure_server.py"],
)
def test_server_entrypoints_bind_a_validated_port(
    entrypoint, raw_port, expected_port, tmp_path
):
    """A malformed PORT must not stop the server from starting."""

    env = os.environ.copy()
    env.update(
        {
            # Keep config reads/writes (and the project root) inside tmp_path.
            "HOME": str(tmp_path),
            "USERPROFILE": str(tmp_path),
            "HOST": "127.0.0.1",
            "PORT": raw_port,
            "PROVIDER": "ollama",
        }
    )

    result = subprocess.run(
        [sys.executable, "-c", WORKER, str(SERVER_DIR / entrypoint)],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert f"PORT={expected_port}" in result.stdout
