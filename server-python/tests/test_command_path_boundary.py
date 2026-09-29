"""Regression tests for command path containment."""

import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import security  # noqa: E402
import tools  # noqa: E402


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    (tmp_path / "inside.txt").write_text("inside", encoding="utf-8")
    return tmp_path


def test_ls_cannot_enumerate_an_absolute_directory(project_root, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")

    result = tools.run_command(f"ls {outside}")

    assert "error" in result
    assert "outside the project" in result["error"].lower() or "path" in result["error"].lower()


def test_dir_cannot_enumerate_an_absolute_directory(project_root, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")

    result = tools.run_command(f"dir {outside}")

    assert "error" in result


def test_directory_listing_allows_project_relative_paths(project_root):
    subdir = project_root / "subdir"
    subdir.mkdir()
    (subdir / "inside.txt").write_text("inside", encoding="utf-8")

    result = tools.run_command("ls subdir")

    assert result.get("returncode") == 0
    assert "inside.txt" in result.get("stdout", "")


def test_directory_listing_rejects_parent_traversal(project_root):
    result = tools.run_command("ls ../")

    assert "error" in result


def test_pwd_rejects_extra_path_arguments(project_root):
    result = tools.run_command("pwd ..")

    assert "error" in result


def test_quoted_parent_traversal_is_rejected(project_root):
    # shlex.split(posix=False) keeps the quote characters, so this reached the
    # boundary check as '".."'. safe_path() could not see the escape through
    # the quotes and the command listed the parent directory.
    result = tools.run_command('ls ".."')

    assert "error" in result


def test_quoted_absolute_path_is_rejected(project_root, tmp_path):
    outside = tmp_path / "outside-quoted"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")

    result = tools.run_command(f'dir "{outside}"')

    assert "error" in result


def test_directory_listing_rejects_shell_expansion(project_root):
    # On Windows the listing runs as `cmd /c dir <arg>`, so cmd.exe expands
    # %VAR% after the boundary check. `ls %TEMP%` passed the check as a
    # relative path and then listed the real %TEMP% directory.
    for command in ("ls %TEMP%", "dir %CD%", "ls %USERPROFILE%"):
        result = tools.run_command(command)

        assert "error" in result, command


def test_quoted_project_relative_path_still_lists(project_root):
    subdir = project_root / "sub dir"
    subdir.mkdir()
    (subdir / "inside.txt").write_text("inside", encoding="utf-8")

    result = tools.run_command('ls "sub dir"')

    assert "error" not in result
    assert "inside.txt" in result.get("stdout", "")
