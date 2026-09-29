"""Round-3 regression tests: `git diff --no-index` sandbox escape.

`git diff --no-index <A> <B>` compares two arbitrary paths while ignoring the
repository entirely and prints the full contents of both files. Nothing in
run_command stopped it: the directory guard only covers ls/dir/pwd, and the
read-permission check only runs when the user has selected files on the
Project page. So a single model-issued command could exfiltrate any readable
file on the machine verbatim into the conversation.
"""

import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import security
import tools

MARKER = "PERSONAL_FINANCIAL_DATA_LEAK"


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(root), *args],
        check=False, capture_output=True, text=True,
    )


@pytest.fixture
def sandbox(tmp_path):
    """A project root that IS the git repo, plus a secret file outside it.

    The repository must live at the project root: tools.py deliberately
    rejects a .git above PROJECT_ROOT ("object storage points outside the
    project root"), so initializing the repo in the parent would make the
    git-backed assertions fail for an unrelated reason.
    """
    root = tmp_path / "project"
    (root / "src").mkdir(parents=True)
    _git(root, "init", "-q")
    (root / "src" / "notes.txt").write_text("project notes\n", encoding="utf-8")

    # Lives outside PROJECT_ROOT.
    outside = tmp_path / "salary_data.txt"
    outside.write_text(f"{MARKER}\nline2\n", encoding="utf-8")

    security.PROJECT_ROOT.set(root)
    yield {"root": root, "outside": outside, "inside": root / "src" / "notes.txt"}
    security.PROJECT_ROOT.set(SERVER_DIR)


class TestNoIndexIsBlocked:
    @pytest.mark.parametrize(
        "template",
        [
            # absolute out-of-root path
            'git diff --no-index {outside} {inside}',
            # relative traversal out of the project
            'git diff --no-index ../salary_data.txt src/notes.txt',
            # repeated flag
            'git diff --no-index --no-index ../salary_data.txt src/notes.txt',
            # --no-index=... form
            'git diff --no-index={outside} src/notes.txt',
            # --ita-invisible-in-index implies --no-index in Git, so blocking
            # only the literal --no-index would leave an equivalent escape.
            'git diff --no-index --ita-invisible-in-index {outside} {inside}',
        ],
    )
    def test_escape_variants_are_refused(self, sandbox, template):
        command = template.format(outside=sandbox["outside"], inside=sandbox["inside"])
        error = tools._git_output_file_option_error(command)

        assert error is not None, f"not blocked: {command}"
        assert "--no-index" in error["error"]
        assert "outside the project" in error["error"]

    def test_end_to_end_run_command_never_returns_the_contents(self, sandbox):
        command = (
            f'git diff --no-index {sandbox["outside"]} {sandbox["inside"]}'
        )
        result = tools.run_command(command, confirm=True)

        assert "error" in result
        assert MARKER not in (result.get("stdout") or "")
        assert MARKER not in (result.get("stderr") or "")

    def test_relative_traversal_end_to_end(self, sandbox):
        result = tools.run_command(
            "git diff --no-index ../salary_data.txt src/notes.txt", confirm=True
        )
        assert "error" in result
        assert MARKER not in (result.get("stdout") or "")

    def test_canonicalized_git_alias_is_also_blocked(self, sandbox):
        # run_command canonicalizes git.exe/git.cmd/git.bat before the guards
        # run, so the Windows spellings must be refused too.
        for prefix in ("git.exe", "git.cmd", "git.bat", "GIT"):
            command = f'{prefix} diff --no-index ../salary_data.txt src/notes.txt'
            result = tools.run_command(command, confirm=True)
            assert "error" in result, f"{prefix} was not blocked"
            assert MARKER not in (result.get("stdout") or "")

    def test_ordinary_git_diff_is_untouched(self, sandbox):
        _git(sandbox["root"], "add", "-A")
        _git(sandbox["root"], "-c", "user.email=t@e.com", "-c", "user.name=T",
             "commit", "-qm", "init")
        (sandbox["inside"]).write_text("project notes\nedited\n", encoding="utf-8")

        assert tools._git_output_file_option_error("git diff") is None

        result = tools.run_command("git diff", confirm=True)
        assert "error" not in result, result.get("error")
        assert "diff --git" in (result.get("stdout") or "")
        assert "+edited" in (result.get("stdout") or "")

    def test_the_output_redirection_guard_still_works(self, sandbox):
        error = tools._git_output_file_option_error("git diff -o out.patch")
        assert error is not None
        assert "cannot be redirected" in error["error"]

    def test_only_diff_is_restricted_not_every_git_command(self, sandbox):
        for command in ("git status", "git log", "git show", "git add ."):
            error = tools._git_output_file_option_error(command)
            assert error is None, f"{command} unexpectedly blocked: {error}"


class TestGitDiffStillFunctions:
    """Guard against a regression that silently breaks diffing outright."""

    def test_git_diff_renders_patch_content(self, sandbox):
        _git(sandbox["root"], "add", "-A")
        _git(sandbox["root"], "-c", "user.email=t@e.com", "-c", "user.name=T",
             "commit", "-qm", "init")
        (sandbox["inside"]).write_text("project notes\nsecond line\n", encoding="utf-8")

        result = tools.run_command("git diff", confirm=True)

        assert result.get("returncode") == 0, result
        assert "diff --git" in (result.get("stdout") or "")
        assert "+second line" in (result.get("stdout") or "")

    def test_git_diff_tool_still_works(self, sandbox):
        _git(sandbox["root"], "add", "-A")
        _git(sandbox["root"], "-c", "user.email=t@e.com", "-c", "user.name=T",
             "commit", "-qm", "init")
        (sandbox["inside"]).write_text("project notes\nsecond line\n", encoding="utf-8")

        result = tools.git_diff()
        assert "error" not in result, result.get("error")
        assert "diff --git" in result.get("diff", "")
