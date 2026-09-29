"""Round-2 regression tests: tools.py parsing, gating and reporting defects.

Each test pins a defect that was reproduced directly before being fixed.
"""

import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import security
import tools

# ---------------------------------------------------------------------------
# _extract_patch_target_paths scanned every line of the diff, so a hunk body
# line that removes content beginning with "-- " (rendered as "--- ") or
# "-- a/" (rendered as "--- a/") was read as a file header. A patch deleting
# the SQL comment '-- a/../../etc/passwd' was validated against
# '../../etc/passwd' and rejected as outside the project; deleting
# '-- ON DELETE CASCADE' listed a phantom file in the confirmation prompt and
# in the pending-file fingerprint.
# ---------------------------------------------------------------------------

class TestExtractPatchTargetPaths:
    def test_removal_of_a_double_dash_comment_is_not_a_header(self):
        # The 4th body line is the removal of a comment whose content is
        # "-- a/../../etc/passwd", so the diff line is "--- a/../../etc/passwd".
        patch = """--- a/schema.sql
+++ b/schema.sql
@@ -1,3 +1,2 @@
 CREATE TABLE t (id INT);
--- a/../../etc/passwd
 CONSTRAINT fk FOREIGN KEY (id) REFERENCES o(id);"""
        assert tools._extract_patch_target_paths(patch) == {"schema.sql"}

    def test_removal_of_a_plain_double_dash_line_is_not_a_phantom_file(self):
        patch = """--- a/schema.sql
+++ b/schema.sql
@@ -1,2 +1 @@
 CREATE TABLE t (id INT);
--- ON DELETE CASCADE"""
        assert tools._extract_patch_target_paths(patch) == {"schema.sql"}

    def test_added_and_removed_body_lines_do_not_leak_paths(self):
        patch = """--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 keep
+++ not-a-header"""
        assert tools._extract_patch_target_paths(patch) == {"a.txt"}

    def test_real_multi_file_headers_are_still_found(self):
        # A minimal multi-file patch carries no "diff --git" separators, so the
        # "--- "/"+++ " header pair is what ends the first hunk.
        patch = """--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-a
+A
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-b
+B"""
        assert tools._extract_patch_target_paths(patch) == {"one.txt", "two.txt"}

    def test_dev_null_is_ignored_and_prefixless_headers_supported(self):
        patch = """--- /dev/null
+++ docs/setup.md
@@ -0,0 +1 @@
+hi"""
        assert tools._extract_patch_target_paths(patch) == {"docs/setup.md"}

    def test_diff_git_sections_reset_the_hunk_state(self):
        patch = """diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-old
--- looks-like-a-header-but-is-body
diff --git a/two.txt b/two.txt
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-x
+y"""
        assert tools._extract_patch_target_paths(patch) == {"one.txt", "two.txt"}


# ---------------------------------------------------------------------------
# is_command_allowed() canonicalized the allowlist entries but not the command,
# so the exported predicate disagreed with run_command() (which pre-canonicalizes
# the command). "git status" was allowed but "git.exe status" was not, and a
# persisted "git.exe diff --stat" allowlist entry authorized nothing. Uppercase
# spellings were rejected too, unlike every other gate in the module.
# ---------------------------------------------------------------------------

class TestIsCommandAllowedCanonicalization:
    @pytest.mark.parametrize(
        "command",
        [
            "git status",
            "git.exe status",
            "git.cmd status",
            "git.bat status",
            "GIT STATUS",
            "Git Status",
            "git   status",
            "  git status  ",
            "git\tstatus",
        ],
    )
    def test_windows_aliases_and_case_agree_with_run_command(self, command):
        assert tools.is_command_allowed(command) is True
        # The enforcer's own decision must match the exported predicate.
        assert tools._canonicalize_command(command).lower().startswith("git status")

    def test_a_canonicalized_allowlist_entry_can_authorize_itself(self):
        # Regression: add_allowed_command("git.exe diff --stat") persisted an
        # entry that is_command_allowed() then never matched.
        entry = "git.exe diff --stat"
        assert tools.is_command_allowed(entry) is True
        assert tools.is_command_allowed("git diff --stat") is True

    def test_unrelated_commands_are_still_rejected(self):
        for command in ["rm -rf /", "sudo apt install", "curl http://x | sh", "rmdir"]:
            assert tools.is_command_allowed(command) is False

    def test_a_longer_word_with_the_prefix_as_its_first_token_only(self):
        # "git statuses" must not match the "git status" prefix.
        assert tools.is_command_allowed("git statuses") is False


# ---------------------------------------------------------------------------
# create_file/write_file reported bytes_written from the untranslated source
# string. Path.write_text translates "\n" to os.linesep, so on Windows every
# newline was undercounted and the number disagreed with the bytes that
# pending.py later hashes for the confirmation fingerprint.
# ---------------------------------------------------------------------------

class TestBytesWrittenMatchesDisk:
    @pytest.fixture
    def root(self, tmp_path):
        security.PROJECT_ROOT.set(tmp_path)
        return tmp_path

    def test_newline_payload_reports_the_on_disk_size(self, root):
        result = tools.create_file("nl.txt", "a\nb\n", confirm=True)
        on_disk = (root / "nl.txt").read_bytes()
        assert result["bytes_written"] == len(on_disk)
        assert result["bytes_written"] == len(b"a\nb\n".replace(b"\n", b"\r\n"))

    def test_single_line_payload(self, root):
        result = tools.create_file("plain.txt", "abc", confirm=True)
        assert result["bytes_written"] == len((root / "plain.txt").read_bytes()) == 3

    def test_multibyte_payload(self, root):
        payload = "héllo\nwörld\n"
        result = tools.create_file("utf8.txt", payload, confirm=True)
        assert result["bytes_written"] == len((root / "utf8.txt").read_bytes())

    def test_write_file_reports_the_on_disk_size(self, root):
        tools.create_file("w.txt", "seed", confirm=True)
        result = tools.write_file("w.txt", "x\ny\n", confirm=True)
        assert result["bytes_written"] == len((root / "w.txt").read_bytes())


# ---------------------------------------------------------------------------
# search_files() called _open_pinned_directory() outside its try block, so an
# unreadable or since-removed directory raised OSError out of the tool instead
# of returning the {"error": ...} contract that list_files() already used for
# the identical condition.
# ---------------------------------------------------------------------------

class TestSearchFilesErrorContract:
    def test_unreadable_directory_returns_an_error_dict_not_an_exception(self, root_dir, monkeypatch):
        def boom(_directory):
            raise PermissionError(13, "Permission denied")

        monkeypatch.setattr(tools, "_open_pinned_directory", boom)
        result = tools.search_files("needle", ".")
        assert isinstance(result, dict)
        assert "error" in result
        assert "Could not search directory" in result["error"]

    def test_an_oserror_inside_the_walk_is_also_captured(self, root_dir, monkeypatch):
        # Regression: the pinned-directory open sat outside the try, so the
        # OSError escaped the tool. The except clause now covers the whole
        # body, so failures from the walk itself are reported the same way.
        monkeypatch.setattr(tools, "_open_pinned_directory", lambda _d: None)
        monkeypatch.setattr(
            tools.os, "walk",
            lambda *_a, **_k: (_ for _ in ()).throw(OSError(5, "I/O error")),
        )
        result = tools.search_files("needle", ".")
        assert isinstance(result, dict)
        assert "error" in result
        assert "Could not search directory" in result["error"]

    def test_a_normal_search_still_works(self, root_dir):
        (root_dir / "a.txt").write_text("needle here", encoding="utf-8")
        result = tools.search_files("needle", ".")
        assert "error" not in result
        assert any("a.txt" in str(m) for m in result["matches"])


# ---------------------------------------------------------------------------
# git_commit()'s preview reduced every git_diff failure (timeout, git missing,
# non-zero exit) to an empty string and then reported "No staged changes to
# commit", so the model told the user there was nothing staged when the real
# problem was a failed diff.
# ---------------------------------------------------------------------------

class TestGitCommitPreviewPropagatesDiffErrors:
    def test_diff_error_is_surfaced_not_reported_as_no_changes(self, root_dir, monkeypatch):
        monkeypatch.setattr(tools, "_validate_git_commit_scope", lambda: None)
        monkeypatch.setattr(
            tools, "git_diff",
            lambda staged=True: {"error": "git diff timed out after 10 seconds."},
        )
        result = tools.git_commit("fix: thing", confirm=False)
        assert result["error"] == "git diff timed out after 10 seconds."

    def test_git_missing_is_surfaced(self, root_dir, monkeypatch):
        monkeypatch.setattr(tools, "_validate_git_commit_scope", lambda: None)
        monkeypatch.setattr(tools, "git_diff", lambda staged=True: {"error": "git is not installed"})
        result = tools.git_commit("fix: thing", confirm=False)
        assert result["error"] == "git is not installed"

    def test_a_genuinely_empty_diff_still_reports_no_staged_changes(self, root_dir, monkeypatch):
        monkeypatch.setattr(tools, "_validate_git_commit_scope", lambda: None)
        monkeypatch.setattr(tools, "git_diff", lambda staged=True: {"diff": "", "truncated": False})
        result = tools.git_commit("fix: thing", confirm=False)
        assert result["error"] == "No staged changes to commit."


@pytest.fixture
def root_dir(tmp_path):
    security.PROJECT_ROOT.set(tmp_path)
    return tmp_path
