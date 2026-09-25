"""Regression: generic run_command git must use the same isolation as _run_git."""

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import tools  # noqa: E402


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    return tmp_path


def test_run_command_git_routes_through_run_git(project_root, monkeypatch):
    """Allowed git subcommands must not use plain run_cancellable."""
    captured = {}

    def fake_run_git(args, timeout, input_text=None):
        captured["args"] = list(args)
        captured["timeout"] = timeout
        result = MagicMock()
        result.returncode = 0
        result.stdout = "ok\n"
        result.stderr = ""
        return result

    def boom(*a, **k):
        raise AssertionError("run_cancellable must not be used for git")

    monkeypatch.setattr(tools, "_run_git", fake_run_git)
    monkeypatch.setattr(tools, "run_cancellable", boom)
    monkeypatch.setattr(tools, "is_command_allowed", lambda c: True)

    result = tools.run_command("git status")

    assert "error" not in result
    assert result["returncode"] == 0
    assert captured["args"] == ["status"]
    assert captured["timeout"] == 60


def test_run_command_git_branch_show_current_uses_isolation(project_root, monkeypatch):
    captured = {}

    def fake_run_git(args, timeout, input_text=None):
        captured["args"] = list(args)
        result = MagicMock()
        result.returncode = 0
        result.stdout = "main\n"
        result.stderr = ""
        return result

    monkeypatch.setattr(tools, "_run_git", fake_run_git)
    monkeypatch.setattr(tools, "run_cancellable", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no")))
    monkeypatch.setattr(tools, "is_command_allowed", lambda c: True)

    result = tools.run_command("git branch --show-current")

    assert result["returncode"] == 0
    assert captured["args"] == ["branch", "--show-current"]
    assert "main" in result["stdout"]


def test_run_command_disallowed_git_subcommand_still_rejected(project_root, monkeypatch):
    monkeypatch.setattr(tools, "is_command_allowed", lambda c: True)
    called = []

    def track(*a, **k):
        called.append(True)
        raise AssertionError("should not run")

    monkeypatch.setattr(tools, "_run_git", track)
    monkeypatch.setattr(tools, "run_cancellable", track)

    result = tools.run_command("git config --list")

    assert "error" in result
    assert "not allowed" in result["error"].lower()
    assert not called


def test_run_command_non_git_still_uses_run_cancellable(project_root, monkeypatch):
    captured = {}

    def fake_run(args, cwd=None, timeout=None, **kwargs):
        captured["args"] = list(args)
        result = MagicMock()
        result.returncode = 0
        result.stdout = "/tmp\n"
        result.stderr = ""
        return result

    monkeypatch.setattr(tools, "run_cancellable", fake_run)
    monkeypatch.setattr(
        tools,
        "_run_git",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("git only")),
    )
    monkeypatch.setattr(tools, "is_command_allowed", lambda c: True)

    result = tools.run_command("pwd")

    assert result["returncode"] == 0
    assert captured["args"][0] in ("pwd", "cmd")  # Windows may rewrite
