"""Agent selected-file read permissions.

Selected paths from the Project page are enforced in the Python backend
for read_file, search_files, list_files, and file-reading shell commands.

``allowed_paths`` omitted or [] => restriction active, no files readable.
``allowed_paths: ["README.md"]`` => only those paths readable.
``set_allowed_read_paths(None)`` remains available for unrestricted
internal/test use only; chat requests never pass None.
"""

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import security  # noqa: E402
import tools  # noqa: E402


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    (tmp_path / "README.md").write_text("readme content\n")
    (tmp_path / "other.md").write_text("other content\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hi')\n")
    (tmp_path / ".env").write_text("SECRET=1\n")
    return tmp_path


@pytest.fixture(autouse=True)
def _clear_permissions():
    security.clear_allowed_read_paths()
    yield
    security.clear_allowed_read_paths()


# --- representation: None vs [] vs non-empty ---

def test_allowed_paths_none_still_unrestricted_for_internal_use(project_root):
    """Explicit None remains unrestricted (internal/tests only)."""
    security.set_allowed_read_paths(None)
    assert security.get_allowed_read_paths() is None
    result = tools.read_file("other.md")
    assert "error" not in result
    assert "other content" in result["contents"]


def test_allowed_paths_empty_list_denies_all_reads(project_root):
    """Explicit empty list => restriction active, nothing readable."""
    stored = security.set_allowed_read_paths([])
    assert stored == frozenset()
    assert security.get_allowed_read_paths() == frozenset()
    result = tools.read_file("README.md")
    assert "error" in result
    assert "denied" in result["error"].lower() or "not in the set" in result["error"].lower()


def test_allowed_paths_single_file(project_root):
    security.set_allowed_read_paths(["README.md"])
    assert security.get_allowed_read_paths() == frozenset({"README.md"})
    ok = tools.read_file("README.md")
    assert "error" not in ok
    denied = tools.read_file("other.md")
    assert "error" in denied


# --- read_file ---

def test_read_file_selected(project_root):
    security.set_allowed_read_paths(["README.md", "src/main.py"])
    result = tools.read_file("README.md")
    assert "error" not in result
    assert "readme content" in result["contents"]


def test_read_file_unselected_denied(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.read_file("other.md")
    assert "error" in result
    assert "denied" in result["error"].lower() or "not in the set" in result["error"].lower()


# --- search_files / list_files with zero selection ---

def test_search_files_with_zero_selected_files(project_root):
    security.set_allowed_read_paths([])
    result = tools.search_files("readme")
    assert "error" not in result
    assert result.get("matches", []) == []


def test_list_files_with_zero_selected_files(project_root):
    security.set_allowed_read_paths([])
    result = tools.list_files(".")
    assert "error" not in result
    assert result.get("entries", []) == []


def test_search_files_skips_unselected(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.search_files("other")
    assert "error" not in result
    paths = [m["path"] for m in result.get("matches", [])]
    assert not any("other.md" in p for p in paths)


# --- shell file-content commands ---

@pytest.mark.parametrize(
    "command",
    [
        "cat other.md",
        "type other.md",
        "Get-Content other.md",
        "head other.md",
        "tail other.md",
        "less other.md",
        "more other.md",
        "bat other.md",
        "nl other.md",
    ],
)
def test_shell_file_content_commands_blocked_when_restricted(project_root, command):
    security.set_allowed_read_paths(["README.md"])
    prefix = command.split()[0]
    tools.add_allowed_command(prefix)
    try:
        result = tools.run_command(command)
        assert "error" in result
        err = result["error"].lower()
        assert "blocked" in err or "read_file" in err or "not allowed" in err
    finally:
        try:
            tools.remove_allowed_command(prefix)
        except ValueError:
            pass


def test_shell_file_reader_blocked_with_empty_selection(project_root):
    security.set_allowed_read_paths([])
    tools.add_allowed_command("cat")
    try:
        result = tools.run_command("cat README.md")
        assert "error" in result
    finally:
        try:
            tools.remove_allowed_command("cat")
        except ValueError:
            pass


# --- concurrent isolation ---

def test_concurrent_requests_different_allowed_paths(project_root):
    """ContextVar keeps concurrent allowed sets isolated."""

    def worker(paths, target, expect_ok):
        security.set_allowed_read_paths(paths)
        try:
            result = tools.read_file(target)
            if expect_ok:
                assert "error" not in result, result
            else:
                assert "error" in result, result
            return True
        finally:
            security.clear_allowed_read_paths()

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [
            pool.submit(worker, ["README.md"], "README.md", True),
            pool.submit(worker, ["README.md"], "other.md", False),
            pool.submit(worker, [], "README.md", False),
            pool.submit(worker, None, "other.md", True),
            pool.submit(worker, ["other.md"], "other.md", True),
            pool.submit(worker, ["other.md"], "README.md", False),
        ]
        for f in futures:
            assert f.result() is True


# --- existing protections still work ---

def test_project_root_traversal_still_blocked(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.read_file("../outside.txt")
    assert "error" in result
    assert "outside" in result["error"].lower() or "not allowed" in result["error"].lower()


def test_sensitive_still_blocked_even_if_selected(project_root):
    security.set_allowed_read_paths([".env", "README.md"])
    result = tools.read_file(".env")
    assert "error" in result
    assert "secret" in result["error"].lower() or "credential" in result["error"].lower()


def test_context_manager_isolates_permission(project_root):
    # Default is deny-all; temporarily unrestricted for outer state.
    security.set_allowed_read_paths(None)
    with security.allowed_read_paths_context(["README.md"]):
        assert "error" not in tools.read_file("README.md")
        assert "error" in tools.read_file("other.md")
    # Previous unrestricted state restored.
    assert "error" not in tools.read_file("other.md")


def test_context_manager_empty_list_is_restrictive(project_root):
    security.set_allowed_read_paths(None)
    with security.allowed_read_paths_context([]):
        assert security.get_allowed_read_paths() == frozenset()
        assert "error" in tools.read_file("README.md")
    # Previous unrestricted state restored.
    assert security.get_allowed_read_paths() is None


# --- git content tools under restriction ---

def test_git_diff_requires_allowed_path_when_restricted(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.git_diff(path="")
    assert "error" in result
    assert "path" in result["error"].lower() or "allowed" in result["error"].lower()


def test_git_diff_denies_unselected_path(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.git_diff(path="other.md")
    assert "error" in result
    assert "denied" in result["error"].lower() or "not in the set" in result["error"].lower()


def test_git_diff_staged_allowed_with_no_path_even_when_restricted(project_root):
    """Unlike an unstaged diff, a staged diff is scoped to files that
    already passed their own git_add confirmation, so it isn't gated by
    file selection — this is what lets git_commit's preview work at all
    when no files have been explicitly selected (the default for anyone
    not using that feature)."""
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=project_root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=project_root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=project_root, check=True)
    subprocess.run(["git", "add", "README.md"], cwd=project_root, check=True)
    security.set_allowed_read_paths([])
    result = tools.git_diff(staged=True)
    assert "error" not in result
    assert "diff" in result


def test_read_file_nonexistent_returns_file_missing_not_permission_error(project_root):
    """A file that doesn't exist must report 'File does not exist', not an access-denied error."""
    security.set_allowed_read_paths(["README.md"])
    result = tools.read_file("no-such-file.txt")
    assert "error" in result
    assert "file does not exist" in result["error"].lower()
    assert "denied" not in result["error"].lower()
    assert "not in the set" not in result["error"].lower()


def test_read_file_existing_but_unselected_triggers_access_denied(project_root):
    """An existing but unselected file must return 'Access denied:' so the
    agent layer can pause and trigger the read_file_permission confirmation."""
    security.set_allowed_read_paths(["README.md"])
    result = tools.read_file("other.md")
    assert "error" in result
    assert "access denied" in result["error"].lower() or "not in the set" in result["error"].lower()


def test_git_show_shell_blocked_when_restricted(project_root):
    security.set_allowed_read_paths(["README.md"])
    # git show is already on the default allowlist
    result = tools.run_command("git show HEAD:other.md")
    assert "error" in result
    err = result["error"].lower()
    assert "access denied" in err


def test_git_show_head_denied_when_restricted(project_root):
    """git show HEAD exposes the full commit diff and must be denied when
    no files are selected."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show HEAD")
    assert "error" in result
    err = result["error"].lower()
    assert "access denied" in err


def test_git_show_stat_allowed_when_restricted(project_root):
    """git show --stat HEAD shows only change statistics, no file contents."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --stat HEAD")
    assert "error" not in result


def test_git_show_no_patch_allowed_when_restricted(project_root):
    """git show --no-patch HEAD shows only commit metadata, no file contents."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --no-patch HEAD")
    assert "error" not in result


def test_git_show_colon_path_allowed_for_selected_file(project_root):
    """git show HEAD:README.md must be allowed when README.md is selected."""
    security.set_allowed_read_paths(["README.md"])
    result = tools.run_command("git show HEAD:README.md")
    assert "error" not in result


def test_git_show_colon_path_denied_for_unselected_file(project_root):
    """git show HEAD:other.md must be denied when other.md is not selected."""
    security.set_allowed_read_paths(["README.md"])
    result = tools.run_command("git show HEAD:other.md")
    assert "error" in result
    err = result["error"].lower()
    assert "access denied" in err


def test_git_show_dash_path_allowed_for_selected_file(project_root):
    """git show HEAD -- README.md must be allowed when README.md is selected."""
    security.set_allowed_read_paths(["README.md"])
    result = tools.run_command("git show HEAD -- README.md")
    assert "error" not in result


def test_git_show_dash_path_denied_for_unselected_file(project_root):
    """git show HEAD -- other.md must be denied when other.md is not selected."""
    security.set_allowed_read_paths(["README.md"])
    result = tools.run_command("git show HEAD -- other.md")
    assert "error" in result
    err = result["error"].lower()
    assert "access denied" in err


def test_git_show_oneline_denied(project_root):
    """--oneline does not suppress patch output and must be denied."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --oneline HEAD")
    assert "error" in result
    err = result["error"].lower()
    assert "access denied" in err


def test_git_show_stat_patch_denied(project_root):
    """--stat --patch still shows the patch and must be denied."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --stat --patch HEAD")
    assert "error" in result


def test_git_show_no_patch_patch_denied(project_root):
    """--no-patch --patch shows the patch (--patch wins) and must be denied."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --no-patch --patch HEAD")
    assert "error" in result


def test_git_show_format_denied(project_root):
    """--format=<spec> shows the patch by default and must be denied."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --format=oneline HEAD")
    assert "error" in result


def test_git_show_name_only_patch_allowed(project_root):
    """--name-only overrides --patch and is safe."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --name-only --patch HEAD")
    assert "error" not in result


def test_git_show_name_status_patch_allowed(project_root):
    """--name-status overrides --patch and is safe."""
    security.set_allowed_read_paths([])
    result = tools.run_command("git show --name-status --patch HEAD")
    assert "error" not in result
