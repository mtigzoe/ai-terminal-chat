"""Tests for the confirm-gated write tools: create_file, write_file,
delete_file, and apply_patch.

Before this file, test_tools.py only exercised these tools' sensitive-
path rejection (test_create_file_refuses_sensitive_targets and
similar). The core preview/confirm lifecycle, success paths, and
failure paths (missing target, directory instead of file, patch that
doesn't apply cleanly, git not available, and so on) had no direct
coverage at all — despite these being exactly the tools whose
confirmation gate is the application's main security invariant
(see agent.py: "the model can never self-confirm").
"""

import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import os  # noqa: E402

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import security  # noqa: E402
import tools  # noqa: E402


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def git_repo(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True
    )
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    return tmp_path


# ---------------------------------------------------------
# create_file
# ---------------------------------------------------------


def test_create_file_preview_does_not_create_anything(project_root):
    result = tools.create_file("new.txt", "hello world", confirm=False)

    assert result["requires_confirmation"] is True
    assert result["preview"] == "hello world"
    assert not (project_root / "new.txt").exists()


def test_create_file_confirm_true_writes_the_file(project_root):
    result = tools.create_file("new.txt", "hello world", confirm=True)

    assert result["created"] is True
    assert result["bytes_written"] == len("hello world".encode("utf-8"))
    assert (project_root / "new.txt").read_text(encoding="utf-8") == "hello world"


def test_create_file_refuses_to_overwrite_existing_file(project_root):
    (project_root / "existing.txt").write_text("original")

    result = tools.create_file("existing.txt", "clobbered", confirm=True)

    assert "error" in result
    assert "already exists" in result["error"]
    assert (project_root / "existing.txt").read_text(encoding="utf-8") == "original"


def test_create_file_rejects_path_outside_project(project_root):
    result = tools.create_file("../outside.txt", "x", confirm=True)

    assert "error" in result
    assert not (project_root.parent / "outside.txt").exists()


def test_create_file_reports_filesystem_error_without_crashing(project_root, monkeypatch):
    """An OS-level failure (e.g. permission denied) must come back as
    an {"error": ...} dict, not propagate as an unhandled exception.
    """

    def boom(self, *args, **kwargs):
        raise OSError("Permission denied")

    monkeypatch.setattr(Path, "write_text", boom)

    result = tools.create_file("blocked.txt", "x", confirm=True)

    assert "error" in result
    assert "Permission denied" in result["error"]


# ---------------------------------------------------------
# write_file
# ---------------------------------------------------------


def test_write_file_preview_reports_diff_without_writing(project_root):
    (project_root / "doc.txt").write_text("line one\n")

    result = tools.write_file("doc.txt", "line one\nline two\n", confirm=False)

    assert result["requires_confirmation"] is True
    assert result["action"] == "overwrite"
    assert "+line two" in result["diff"]
    assert (project_root / "doc.txt").read_text(encoding="utf-8") == "line one\n"


def test_write_file_preview_reports_create_for_new_file(project_root):
    result = tools.write_file("brand-new.txt", "content", confirm=False)

    assert result["requires_confirmation"] is True
    assert result["action"] == "create"
    assert not (project_root / "brand-new.txt").exists()


def test_write_file_confirm_true_overwrites_existing_file(project_root):
    (project_root / "doc.txt").write_text("old")

    result = tools.write_file("doc.txt", "new", confirm=True)

    assert result["overwritten"] is True
    assert (project_root / "doc.txt").read_text(encoding="utf-8") == "new"


def test_write_file_confirm_true_creates_missing_file(project_root):
    result = tools.write_file("missing.txt", "created via write_file", confirm=True)

    assert result["overwritten"] is False
    assert (project_root / "missing.txt").read_text(encoding="utf-8") == (
        "created via write_file"
    )


def test_write_file_refuses_to_target_a_directory(project_root):
    (project_root / "adir").mkdir()

    result = tools.write_file("adir", "x", confirm=True)

    assert "error" in result
    assert "directory" in result["error"].lower()


def test_write_file_reports_filesystem_error_without_crashing(project_root, monkeypatch):
    def boom(self, *args, **kwargs):
        raise OSError("Disk full")

    monkeypatch.setattr(Path, "write_text", boom)

    result = tools.write_file("newfile.txt", "x", confirm=True)

    assert "error" in result
    assert "Disk full" in result["error"]


# ---------------------------------------------------------
# delete_file
# ---------------------------------------------------------


def test_delete_file_preview_does_not_delete(project_root):
    target = project_root / "gone.txt"
    target.write_text("bye")

    result = tools.delete_file("gone.txt", confirm=False)

    assert result["requires_confirmation"] is True
    assert target.exists()


def test_delete_file_confirm_true_deletes_the_file(project_root):
    target = project_root / "gone.txt"
    target.write_text("bye")

    result = tools.delete_file("gone.txt", confirm=True)

    assert result["deleted"] is True
    assert not target.exists()


def test_delete_file_reports_missing_file(project_root):
    result = tools.delete_file("does-not-exist.txt", confirm=True)

    assert "error" in result
    assert "does not exist" in result["error"]


def test_delete_file_refuses_a_directory(project_root):
    (project_root / "adir").mkdir()

    result = tools.delete_file("adir", confirm=True)

    assert "error" in result
    assert "directory" in result["error"].lower()


def test_delete_file_refuses_the_project_root_itself(project_root):
    result = tools.delete_file(".", confirm=True)

    assert "error" in result
    assert project_root.exists()


# ---------------------------------------------------------
# apply_patch
# ---------------------------------------------------------


_SAMPLE_PATCH = """--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-hello
+hello world
"""


def test_apply_patch_requires_a_git_repository(project_root):
    """No .git directory anywhere above PROJECT_ROOT: apply_patch must
    fail cleanly rather than trying to shell out to a nonexistent repo.
    """

    (project_root / "greeting.txt").write_text("hello\n")

    result = tools.apply_patch(_SAMPLE_PATCH, confirm=False)

    assert "error" in result
    assert "git repository" in result["error"].lower()


def test_apply_patch_rejects_empty_patch(git_repo):
    result = tools.apply_patch("", confirm=False)
    assert "error" in result
    assert "no patch" in result["error"].lower()


def test_apply_patch_rejects_patch_without_headers(git_repo):
    result = tools.apply_patch("not a real diff", confirm=False)
    assert "error" in result
    assert "headers" in result["error"].lower()


def test_apply_patch_preview_validates_without_changing_the_file(git_repo):
    (git_repo / "greeting.txt").write_text("hello\n")
    subprocess.run(["git", "add", "greeting.txt"], cwd=git_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=git_repo, check=True
    )

    result = tools.apply_patch(_SAMPLE_PATCH, confirm=False)

    assert result["requires_confirmation"] is True
    assert result["files"] == ["greeting.txt"]
    assert (git_repo / "greeting.txt").read_text(encoding="utf-8") == "hello\n"


def test_apply_patch_confirm_true_applies_the_change(git_repo):
    (git_repo / "greeting.txt").write_text("hello\n")
    subprocess.run(["git", "add", "greeting.txt"], cwd=git_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=git_repo, check=True
    )

    result = tools.apply_patch(_SAMPLE_PATCH, confirm=True)

    assert result["applied"] is True
    assert result["files"] == ["greeting.txt"]
    assert (
        git_repo / "greeting.txt"
    ).read_text(encoding="utf-8") == "hello world\n"


def test_apply_patch_reports_failure_when_it_does_not_apply_cleanly(git_repo):
    (git_repo / "greeting.txt").write_text("something completely different\n")
    subprocess.run(["git", "add", "greeting.txt"], cwd=git_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=git_repo, check=True
    )

    result = tools.apply_patch(_SAMPLE_PATCH, confirm=False)

    assert "error" in result
    assert "does not apply cleanly" in result["error"].lower()


def test_apply_patch_rejects_sensitive_target_file(git_repo):
    (git_repo / ".env").write_text("SECRET=1\n")
    subprocess.run(["git", "add", ".env"], cwd=git_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=git_repo, check=True
    )

    sensitive_patch = (
        "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-SECRET=1\n+SECRET=2\n"
    )

    result = tools.apply_patch(sensitive_patch, confirm=False)

    assert "error" in result
    assert "sensitive" in result["error"].lower()


def test_apply_patch_rejects_target_path_outside_project(git_repo):
    escaping_patch = (
        "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-a\n+b\n"
    )

    result = tools.apply_patch(escaping_patch, confirm=False)

    assert "error" in result
    assert "invalid path" in result["error"].lower()


def test_apply_patch_too_large_is_rejected(git_repo, monkeypatch):
    monkeypatch.setattr(tools, "PROJECT_ROOT", git_repo)
    oversized = _SAMPLE_PATCH + ("x" * 200_100)

    result = tools.apply_patch(oversized, confirm=False)

    assert "error" in result
    assert "too large" in result["error"].lower()


def test_apply_patch_git_not_installed_reports_clear_error(git_repo, monkeypatch):
    def fake_run(args, **kwargs):
        raise FileNotFoundError("git not found")

    monkeypatch.setattr(tools.subprocess, "run", fake_run)

    result = tools.apply_patch(_SAMPLE_PATCH, confirm=False)

    assert "error" in result
    assert "git is not installed" in result["error"].lower()
