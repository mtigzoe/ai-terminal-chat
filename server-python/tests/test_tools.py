import os
import subprocess
import sys
from pathlib import Path

import pytest

# app.py is in the parent directory of this test package.
SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402
import security  # noqa: E402
import tools  # noqa: E402


@pytest.fixture
def git_repo(tmp_path, monkeypatch):
    """A throwaway git repository used as PROJECT_ROOT for a test.

    security.py and tools.py each import PROJECT_ROOT by value at
    module load time, so both module-level names have to be patched
    for safe_path()/is_sensitive_path() (in security.py) and the
    git_add subprocess calls (in tools.py) to agree on the same root.
    """

    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    return tmp_path


def _git_porcelain(repo_path):
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


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


# ---------------------------------------------------------
# git_add: unified confirmation architecture, git category
# ---------------------------------------------------------

def test_git_add_rejects_path_traversal(git_repo):
    result = tools.git_add("../outside.txt")
    assert "error" in result
    assert "outside" in result["error"].lower() or "not allowed" in result["error"].lower()


def test_git_add_rejects_absolute_path(git_repo):
    result = tools.git_add("/etc/passwd")
    assert "error" in result
    assert "not allowed" in result["error"].lower()


@pytest.mark.parametrize(
    "filename",
    [".env", "credentials.json", "id_rsa", "server.pem"],
)
def test_git_add_rejects_sensitive_files(git_repo, filename):
    target = git_repo / filename
    target.write_text("secret")

    result = tools.git_add(filename)

    assert "error" in result
    assert "sensitive" in result["error"].lower()
    # The refusal happens before anything reaches git — the file is
    # merely untracked ('??'), never staged ('A ').
    assert _git_porcelain(git_repo).strip().startswith("??")


def test_git_add_rejects_missing_file(git_repo):
    result = tools.git_add("does_not_exist.txt")
    assert "error" in result
    assert "does not exist" in result["error"].lower()


def test_git_add_requires_a_git_repository(tmp_path, monkeypatch):
    # Deliberately no `git init` here.
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    (tmp_path / "file.txt").write_text("hello")

    result = tools.git_add("file.txt")

    assert "error" in result
    assert "git repository" in result["error"].lower()


def test_git_add_preview_never_touches_the_index(git_repo):
    (git_repo / "file.txt").write_text("hello")

    result = tools.git_add("file.txt")

    assert result["requires_confirmation"] is True
    assert result["path"] == "file.txt"
    # Nothing was staged — the file should still show as untracked,
    # not added ('A' or '??' but never staged 'A ' in column 1).
    porcelain = _git_porcelain(git_repo)
    assert porcelain.strip().startswith("??")


def test_git_add_confirm_true_stages_the_file(git_repo):
    (git_repo / "file.txt").write_text("hello")

    preview = tools.git_add("file.txt")
    assert preview["requires_confirmation"] is True

    result = tools.git_add("file.txt", confirm=True)

    assert result == {"path": "file.txt", "staged": True}
    porcelain = _git_porcelain(git_repo)
    # Staged-but-not-committed shows as 'A ' (added) in porcelain output.
    assert porcelain.strip().startswith("A ")


def test_git_add_is_registered_consistently():
    assert "git_add" in tools.TOOL_FUNCTIONS
    assert "git_add" in tools.TOOL_SCHEMAS
    assert "git_add" in tools.GIT_CONFIRM_TOOL_NAMES
    # git_add is a state-changing git operation, not a plain filesystem
    # write — it must stay out of WRITE_TOOL_NAMES so the two
    # categories remain independently distinguishable.
    assert "git_add" not in tools.WRITE_TOOL_NAMES
