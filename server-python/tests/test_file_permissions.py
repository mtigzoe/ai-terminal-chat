"""Agent selected-file read permissions.

Selected paths from the Project page are enforced in the Python backend
for read_file, search_files, list_files, and file-reading shell commands.
"""

import os
import sys
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


def test_selected_file_can_be_read(project_root):
    security.set_allowed_read_paths(["README.md", "src/main.py"])
    result = tools.read_file("README.md")
    assert "error" not in result
    assert "readme content" in result["contents"]


def test_unselected_file_read_denied(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.read_file("other.md")
    assert "error" in result
    assert "denied" in result["error"].lower() or "not in the set" in result["error"].lower()


def test_search_files_skips_unselected(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.search_files("other")
    assert "error" not in result
    paths = [m["path"] for m in result.get("matches", [])]
    assert not any("other.md" in p for p in paths)


def test_search_files_finds_selected(project_root):
    security.set_allowed_read_paths(["README.md"])
    result = tools.search_files("readme")
    assert "error" not in result
    paths = [m["path"] for m in result.get("matches", [])]
    assert any(p.endswith("README.md") for p in paths)


def test_shell_file_reader_blocked_when_restricted(project_root):
    security.set_allowed_read_paths(["README.md"])
    tools.add_allowed_command("cat")
    try:
        result = tools.run_command("cat other.md")
        assert "error" in result
        assert "blocked" in result["error"].lower() or "read_file" in result["error"].lower()
    finally:
        try:
            tools.remove_allowed_command("cat")
        except ValueError:
            pass


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


def test_unrestricted_when_no_selection(project_root):
    security.clear_allowed_read_paths()
    result = tools.read_file("other.md")
    assert "error" not in result
    assert "other content" in result["contents"]


def test_list_files_filters_to_allowed(project_root):
    security.set_allowed_read_paths(["README.md", "src/main.py"])
    result = tools.list_files(".")
    assert "error" not in result
    names = {e["name"] for e in result["entries"]}
    assert "README.md" in names
    assert "other.md" not in names
    assert "src" in names


def test_context_manager_isolates_permission(project_root):
    with security.allowed_read_paths_context(["README.md"]):
        assert "error" not in tools.read_file("README.md")
        assert "error" in tools.read_file("other.md")
    assert "error" not in tools.read_file("other.md")
