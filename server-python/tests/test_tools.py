import os
import sys
from pathlib import Path

import pytest

# tools.py / security.py live in the parent directory of this test package.
SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

from security import (  # noqa: E402
    PROJECT_ROOT,
    is_sensitive_filename,
    is_sensitive_path,
    safe_path,
)
from tools import (  # noqa: E402
    GIT_DIFF_MAX_CHARS,
    git_branch,
    git_diff,
    git_log,
    git_status,
    is_command_allowed,
    run_command,
)


# ---------------------------------------------------------------------------
# Path and sensitive-file guards
# ---------------------------------------------------------------------------


def test_safe_path_rejects_absolute_and_traversal_paths():
    with pytest.raises(ValueError):
        safe_path("C:\\Users\\test\\secret.txt")

    with pytest.raises(ValueError):
        safe_path("/etc/passwd")

    with pytest.raises(ValueError):
        safe_path("../../outside.txt")


def test_safe_path_accepts_project_relative_path():
    path = safe_path("server-python")
    assert path == (PROJECT_ROOT / "server-python").resolve()


@pytest.mark.parametrize(
    "filename",
    [".env", ".env.local", "credentials.json", "private.key", "server.pem"],
)
def test_sensitive_filenames_are_blocked(filename):
    assert is_sensitive_filename(filename)


def test_sensitive_path_blocks_git_internals():
    git_object = PROJECT_ROOT / ".git" / "config"
    assert is_sensitive_path(git_object)


# ---------------------------------------------------------------------------
# Command allowlist and blocking
# ---------------------------------------------------------------------------


def test_command_allowlist_accepts_safe_development_commands():
    assert is_command_allowed("git status")
    assert is_command_allowed("git log -n 5")
    assert is_command_allowed("git diff --stat")
    assert is_command_allowed("pytest -q")
    assert is_command_allowed("npm run build")
    assert is_command_allowed("pip list")


def test_command_allowlist_rejects_unknown_commands():
    assert not is_command_allowed("whoami")
    assert not is_command_allowed("rm -rf .")
    assert not is_command_allowed("git push")
    assert not is_command_allowed("git commit -m 'x'")
    assert not is_command_allowed("git checkout main")
    assert not is_command_allowed("git add .")
    assert not is_command_allowed("git reset --hard")


@pytest.mark.parametrize(
    "command",
    [
        "git status && whoami",
        "git status; whoami",
        "git status | cat",
        "git status > /tmp/out",
        "git status < /tmp/in",
        "echo `whoami`",
        "echo $(whoami)",
        "git status\nwhoami",
    ],
)
def test_run_command_rejects_chaining_piping_and_redirection(command):
    result = run_command(command)
    assert "error" in result
    error = result["error"].lower()
    assert (
        "not allowed" in error
        or "chaining" in error
        or "piping" in error
        or "redirection" in error
        or "substitution" in error
    )


@pytest.mark.parametrize(
    "command",
    [
        "cat .env",
        "printenv",
        "sudo ls",
        "rm -rf /",
        "chmod 777 secrets",
    ],
)
def test_run_command_rejects_blocked_and_secret_access(command):
    result = run_command(command)
    assert "error" in result
    error = result["error"].lower()
    assert "blocked" in error or "not allowed" in error


def test_run_command_executes_pwd():
    result = run_command("pwd")
    assert result["returncode"] == 0
    assert result["stdout"].strip()
    assert result.get("truncated") is False


def test_run_command_reports_truncation(monkeypatch):
    large = "x" * 25_000

    class FakeResult:
        returncode = 0
        stdout = large
        stderr = ""

    monkeypatch.setattr(
        "tools.subprocess.run",
        lambda *args, **kwargs: FakeResult(),
    )

    result = run_command("pwd")
    assert result["truncated"] is True
    assert len(result["stdout"]) == 20_000
    assert "truncation_note" in result


# ---------------------------------------------------------------------------
# Git inspection tools (read-only)
# ---------------------------------------------------------------------------


def test_git_status_returns_status_key():
    result = git_status()
    if "error" in result:
        pytest.skip(result["error"])
    assert "status" in result
    assert "truncated" in result


def test_git_branch_returns_branches_key():
    result = git_branch()
    if "error" in result:
        pytest.skip(result["error"])
    assert "branches" in result
    assert "truncated" in result


def test_git_log_returns_log_key():
    result = git_log(max_count=5)
    if "error" in result:
        pytest.skip(result["error"])
    assert "log" in result
    assert "truncated" in result


def test_git_log_clamps_max_count():
    result_zero = git_log(max_count=0)
    if "error" in result_zero and "whole number" in result_zero["error"]:
        pytest.fail("max_count=0 should clamp, not fail validation")
    if "error" not in result_zero:
        assert "log" in result_zero

    bad = git_log(max_count="not-a-number")
    assert "error" in bad
    assert "whole number" in bad["error"]

    high = git_log(max_count=500)
    if "error" not in high:
        assert "log" in high


def test_git_diff_rejects_path_traversal():
    result = git_diff(path="../../outside.txt")
    assert "error" in result


def test_git_diff_rejects_absolute_path():
    result = git_diff(path="/etc/passwd")
    assert "error" in result


def test_git_diff_happy_path():
    result = git_diff()
    if "error" in result:
        pytest.skip(result["error"])
    assert "diff" in result
    assert "truncated" in result


def test_git_diff_reports_truncation(monkeypatch):
    large = "d" * (GIT_DIFF_MAX_CHARS + 100)

    class FakeResult:
        returncode = 0
        stdout = large
        stderr = ""

    monkeypatch.setattr(
        "tools.subprocess.run",
        lambda *args, **kwargs: FakeResult(),
    )

    result = git_diff()
    assert result["truncated"] is True
    assert len(result["diff"]) == GIT_DIFF_MAX_CHARS
    assert "truncation_note" in result


def test_git_status_reports_truncation(monkeypatch):
    large = "s" * 25_000

    class FakeResult:
        returncode = 0
        stdout = large
        stderr = ""

    monkeypatch.setattr(
        "tools.subprocess.run",
        lambda *args, **kwargs: FakeResult(),
    )

    result = git_status()
    assert result["truncated"] is True
    assert len(result["status"]) == 20_000
    assert "truncation_note" in result
