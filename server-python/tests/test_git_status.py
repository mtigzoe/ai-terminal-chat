"""Tests for tools.git_status()'s `git status --short --branch` parsing.

Before this file, git_status() had no direct tests at all: nothing
exercised how the two-column XY status codes are turned into the
structured (clean/staged/conflicts/...) fields and plain-language
summary that agent.py's system prompt tells the model to trust
verbatim when answering "am I safe to push?" style questions. In
particular, unresolved merge-conflict codes (DD, AU, UD, UA, DU, AA,
UU) were being silently folded into ordinary added/deleted/modified
staged-change classification, which would make the agent tell a user
their conflicted file was simply "staged for the next commit".
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


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def git_repo(tmp_path, monkeypatch):
    _git(["init", "-q", "-b", "main"], tmp_path)
    _git(["config", "user.email", "test@example.com"], tmp_path)
    _git(["config", "user.name", "Test"], tmp_path)
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def merge_conflict_repo(git_repo):
    """A repo with a genuine, unresolved merge conflict on file.txt."""

    (git_repo / "file.txt").write_text("base\n")
    _git(["add", "file.txt"], git_repo)
    _git(["commit", "-q", "-m", "base"], git_repo)

    _git(["checkout", "-q", "-b", "feature"], git_repo)
    (git_repo / "file.txt").write_text("feature change\n")
    _git(["commit", "-q", "-am", "feature change"], git_repo)

    _git(["checkout", "-q", "main"], git_repo)
    (git_repo / "file.txt").write_text("main change\n")
    _git(["commit", "-q", "-am", "main change"], git_repo)

    subprocess.run(
        ["git", "merge", "feature"], cwd=git_repo, capture_output=True
    )  # expected to fail with a conflict; ignore the non-zero exit
    return git_repo


# ---------------------------------------------------------
# Ordinary (non-conflict) status parsing
# ---------------------------------------------------------


def test_clean_repo_reports_clean(git_repo):
    (git_repo / "file.txt").write_text("hello\n")
    _git(["add", "file.txt"], git_repo)
    _git(["commit", "-q", "-m", "init"], git_repo)

    result = tools.git_status()

    assert result["clean"] is True
    assert result["changed"] == 0
    assert result["untracked"] == 0
    assert result["conflicts"] == 0
    assert "clean" in result["summary"].lower()


def test_untracked_and_staged_files_are_classified_correctly(git_repo):
    (git_repo / "tracked.txt").write_text("v1\n")
    _git(["add", "tracked.txt"], git_repo)
    _git(["commit", "-q", "-m", "init"], git_repo)

    (git_repo / "tracked.txt").write_text("v2\n")
    _git(["add", "tracked.txt"], git_repo)
    (git_repo / "new.txt").write_text("brand new\n")

    result = tools.git_status()

    assert result["clean"] is False
    assert result["staged"] == 1
    assert result["untracked"] == 1
    assert result["conflicts"] == 0
    assert any("new.txt" in d and "new file" in d for d in result["details"])
    assert any("tracked.txt" in d and "staged" in d for d in result["details"])


# ---------------------------------------------------------
# Merge-conflict classification (regression coverage)
# ---------------------------------------------------------


def test_unresolved_merge_conflict_is_reported_as_a_conflict_not_staged(
    merge_conflict_repo,
):
    result = tools.git_status()

    assert result["conflicts"] == 1
    # A conflicted path must never be counted as a ready-to-commit staged
    # change: the agent's system prompt tells it to answer "safe to
    # commit/push?" using exactly this field.
    assert result["staged"] == 0
    assert any("conflict" in d.lower() for d in result["details"])
    assert "conflict" in result["summary"].lower()
    assert "staged for the next commit" not in result["summary"]


@pytest.mark.parametrize(
    "code", ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]
)
def test_every_unmerged_porcelain_code_is_classified_as_conflict(
    git_repo, monkeypatch, code
):
    """Exercises all seven `git status --short` unmerged codes directly.

    "AA" (both added) and "DD" (both deleted) are the two codes that
    contain no "U", so a naive per-letter classifier (checking only for
    A/D/R/M) mis-files them as ordinary added/deleted changes instead of
    conflicts requiring manual resolution.
    """

    monkeypatch.setattr(
        tools,
        "_git_status_raw",
        lambda: {"status": f"## main\n{code} conflict.txt\n", "truncated": False},
    )

    result = tools.git_status()

    assert result["conflicts"] == 1
    assert result["staged"] == 0
    assert "conflict.txt — unresolved merge conflict" in result["details"][0]
