"""Regression: git remote output must not leak URL-embedded credentials."""

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import tools  # noqa: E402


def test_sanitize_strips_https_user_and_password():
    output = "origin\thttps://username:secret-token@example.com/owner/repo.git (fetch)"
    sanitized = tools.sanitize_git_remote_output(output)
    assert sanitized == "origin\thttps://example.com/owner/repo.git (fetch)"
    assert "username" not in sanitized
    assert "secret-token" not in sanitized


def test_sanitize_strips_password_with_encoded_at():
    output = "origin\thttps://user:p%40ssword@example.com/repo.git (push)"
    assert tools.sanitize_git_remote_output(output) == (
        "origin\thttps://example.com/repo.git (push)"
    )


def test_sanitize_username_only():
    output = "origin\thttps://user@example.com/repo.git (fetch)"
    assert tools.sanitize_git_remote_output(output) == (
        "origin\thttps://example.com/repo.git (fetch)"
    )


def test_sanitize_leaves_credential_free_urls():
    output = "origin\thttps://github.com/owner/repo.git (fetch)"
    assert tools.sanitize_git_remote_output(output) == output


def test_sanitize_ssh_url_userinfo_but_not_scp_style():
    output = "\n".join(
        [
            "origin\tssh://user:token@example.com/owner/repo.git (fetch)",
            "upstream\tgit@github.com:owner/repo.git (fetch)",
        ]
    )
    sanitized = tools.sanitize_git_remote_output(output)
    assert "origin\tssh://example.com/owner/repo.git (fetch)" in sanitized
    assert "upstream\tgit@github.com:owner/repo.git (fetch)" in sanitized
    assert "token" not in sanitized


def test_sanitize_applies_to_stderr_text():
    output = "fatal: https://user:pass@evil.com/x.git rejected"
    sanitized = tools.sanitize_git_remote_output(output)
    assert "user:pass" not in sanitized
    assert "https://evil.com/x.git" in sanitized


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    return tmp_path


def test_run_command_git_remote_sanitizes_stdout(project_root, monkeypatch):
    def fake_run(*a, **k):
        result = MagicMock()
        result.returncode = 0
        result.stdout = "origin\thttps://user:secret@example.com/repo.git (fetch)\n"
        result.stderr = ""
        return result

    # Cover both pre-isolation (run_cancellable) and post-isolation (_run_git) paths.
    monkeypatch.setattr(tools, "run_cancellable", fake_run)
    if hasattr(tools, "_run_git"):
        monkeypatch.setattr(tools, "_run_git", lambda args, timeout, input_text=None: fake_run())
    monkeypatch.setattr(tools, "is_command_allowed", lambda c: True)

    result = tools.run_command("git remote -v")
    assert "error" not in result
    assert "secret" not in result["stdout"]
    assert "user:secret" not in result["stdout"]
    assert "https://example.com/repo.git" in result["stdout"]


def test_run_command_git_remote_sanitizes_stderr(project_root, monkeypatch):
    def fake_run(*a, **k):
        result = MagicMock()
        result.returncode = 1
        result.stdout = ""
        result.stderr = "error: https://user:pass@evil.com/x.git\n"
        return result

    monkeypatch.setattr(tools, "run_cancellable", fake_run)
    if hasattr(tools, "_run_git"):
        monkeypatch.setattr(tools, "_run_git", lambda args, timeout, input_text=None: fake_run())
    monkeypatch.setattr(tools, "is_command_allowed", lambda c: True)

    result = tools.run_command("git remote -v")
    assert "user:pass" not in result.get("stderr", "")
    assert "https://evil.com/x.git" in result.get("stderr", "")


def test_run_command_non_remote_git_not_forced_through_remote_sanitize_only(
    project_root, monkeypatch
):
    """Non-remote git commands still return their stdout (sanitizer is remote-gated)."""

    def fake_run(*a, **k):
        result = MagicMock()
        result.returncode = 0
        result.stdout = "main\n"
        result.stderr = ""
        return result

    monkeypatch.setattr(tools, "run_cancellable", fake_run)
    if hasattr(tools, "_run_git"):
        monkeypatch.setattr(tools, "_run_git", lambda args, timeout, input_text=None: fake_run())
    monkeypatch.setattr(tools, "is_command_allowed", lambda c: True)

    result = tools.run_command("git branch --show-current")
    assert result["stdout"].startswith("main")
