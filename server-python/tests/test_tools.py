import os
import sys
from pathlib import Path

import pytest

# app.py is in the parent directory of this test package.
SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402


def test_safe_path_rejects_absolute_and_traversal_paths():
    with pytest.raises(ValueError):
        app.safe_path("C:\\Users\\test\\secret.txt")

    with pytest.raises(ValueError):
        app.safe_path("../../outside.txt")


def test_safe_path_accepts_project_relative_path():
    path = app.safe_path("server-python")
    assert path == (app.PROJECT_ROOT / "server-python").resolve()


@pytest.mark.parametrize(
    "filename",
    [".env", ".env.local", "credentials.json", "private.key", "server.pem"],
)
def test_sensitive_filenames_are_blocked(filename):
    assert app.is_sensitive_filename(filename)


def test_command_allowlist_accepts_safe_development_commands():
    assert app.is_command_allowed("git status")
    assert app.is_command_allowed("pytest -q")
    assert app.is_command_allowed("npm run build")


def test_command_allowlist_rejects_unknown_commands():
    assert not app.is_command_allowed("whoami")
    assert not app.is_command_allowed("rm -rf .")


def test_run_command_rejects_command_chaining():
    result = app.run_command("git status && whoami")
    assert "not allowed" in result["error"].lower() or "chaining" in result["error"].lower()


def test_run_command_rejects_secret_access():
    result = app.run_command("cat .env")
    assert "blocked" in result["error"].lower() or "not allowed" in result["error"].lower()


def test_run_command_executes_pwd():
    result = app.run_command("pwd")
    assert result["returncode"] == 0
    assert result["stdout"].strip()
