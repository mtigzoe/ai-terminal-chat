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
def isolated_project(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    security.clear_allowed_read_paths()
    yield tmp_path
    security.clear_allowed_read_paths()


def test_readme_not_selected_cannot_be_read(isolated_project):
    (isolated_project / "README.md").write_text("README secret contents")
    (isolated_project / "selected.txt").write_text("selected contents")
    security.set_allowed_read_paths(["selected.txt"])

    result = tools.read_file("README.md")

    assert "error" in result
    assert "contents" not in result


def test_readme_not_selected_cannot_be_exposed_by_search(isolated_project):
    (isolated_project / "README.md").write_text("README secret contents")
    (isolated_project / "selected.txt").write_text("selected contents")
    security.set_allowed_read_paths(["selected.txt"])

    result = tools.search_files("README secret")

    assert result["matches"] == []


@pytest.mark.parametrize("command", [
    "cat README.md",
    "head README.md",
    "tail README.md",
    "git show HEAD:README.md",
    "git diff -- README.md",
])
def test_readme_not_selected_cannot_be_read_by_content_commands(
    isolated_project, command
):
    (isolated_project / "README.md").write_text("README secret contents")
    (isolated_project / "selected.txt").write_text("selected contents")
    security.set_allowed_read_paths(["selected.txt"])

    result = tools._run_command_respects_read_permissions(command)

    assert result is not None
    assert "error" in result
    assert "README.md" in result["error"]
