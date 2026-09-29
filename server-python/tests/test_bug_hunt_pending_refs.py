"""Round-3 regression tests: the git_head fingerprint must track HEAD.

_pending.py resolved a ref in two places: the branch path had a packed-refs
fallback and the symbolic-HEAD path did not. After `git pack-refs` / `git gc` /
a fresh clone the loose ref is gone, so the symbolic path hashed the constant
"<missing-ref>" and the fingerprint stopped changing when the branch tip
moved. git_pull and git_push record GIT_HEAD_MARKER precisely so a
confirmation is invalidated when the repository changes underneath it, so a
frozen fingerprint silently defeated that guard.
"""

import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import pending
import security


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=False, capture_output=True)


def _repo(tmp_path: Path, pack: bool) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "config", "user.email", "t@e.com")
    _git(tmp_path, "config", "user.name", "T")
    (tmp_path / "a.txt").write_text("one\n", encoding="utf-8")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "first")
    if pack:
        _git(tmp_path, "pack-refs", "--all")
    return tmp_path


@pytest.fixture(autouse=True)
def _restore_root():
    yield
    security.PROJECT_ROOT.set(SERVER_DIR)


class TestGitHeadFingerprintTracksHead:
    def test_symbolic_head_fingerprint_changes_when_the_tip_moves_with_packed_refs(self, tmp_path):
        root = _repo(tmp_path, pack=True)
        security.PROJECT_ROOT.set(root)

        assert (root / ".git" / "refs" / "heads" / "main").is_file() is False
        assert (root / ".git" / "packed-refs").is_file() is True

        before = pending._fingerprint_git_head()
        assert before["status"] == "present"

        (root / "b.txt").write_text("two\n", encoding="utf-8")
        _git(root, "add", "-A")
        _git(root, "commit", "-qm", "second")
        _git(root, "pack-refs", "--all")

        after = pending._fingerprint_git_head()
        assert after["sha256"] != before["sha256"], (
            "the git_head fingerprint was frozen for packed refs"
        )

    def test_same_works_with_loose_refs(self, tmp_path):
        root = _repo(tmp_path, pack=False)
        security.PROJECT_ROOT.set(root)

        before = pending._fingerprint_git_head()
        (root / "b.txt").write_text("two\n", encoding="utf-8")
        _git(root, "add", "-A")
        _git(root, "commit", "-qm", "second")

        assert pending._fingerprint_git_head()["sha256"] != before["sha256"]

    def test_branch_path_and_symbolic_path_agree(self, tmp_path):
        """The two paths used to drift apart; they must read the same ref."""
        root = _repo(tmp_path, pack=True)
        security.PROJECT_ROOT.set(root)

        branch_fp = pending._fingerprint_git_head("main")
        symbolic_fp = pending._fingerprint_git_head()
        assert branch_fp["sha256"] and symbolic_fp["sha256"]
        # The branch path hashes the raw sha; the symbolic path hashes
        # "ref: refs/heads/main\n<sha>". Both must embed the real object id,
        # so neither can be the frozen "<missing-ref>".
        assert "<missing-ref>" not in str(symbolic_fp["sha256"])

    def test_pull_state_is_invalidated_when_head_moves(self, tmp_path):
        root = _repo(tmp_path, pack=True)
        security.PROJECT_ROOT.set(root)

        saved = pending._capture_file_state("git_pull", {}, {"requires_confirmation": True})
        assert saved, "git_pull must capture file state"
        kinds = {entry["path"] for entry in saved}
        assert pending.GIT_HEAD_MARKER in kinds

        head_entry = next(e for e in saved if e["path"] == pending.GIT_HEAD_MARKER)
        assert head_entry["sha256"]

        # Move HEAD only: commit from another worktree-free path and then put
        # the index back so the git_index fingerprint is not what fires.
        (root / "b.txt").write_text("two\n", encoding="utf-8")
        _git(root, "add", "-A")
        _git(root, "commit", "-qm", "second")
        _git(root, "pack-refs", "--all")
        _git(root, "read-tree", "HEAD~1")

        # The git_head entry alone must now differ.
        assert pending._fingerprint_git_head()["sha256"] != head_entry["sha256"]


class TestReadGitRefState:
    def test_loose_ref_wins_over_packed(self, tmp_path):
        root = _repo(tmp_path, pack=True)
        loose = root / ".git" / "refs" / "heads" / "main"
        loose.parent.mkdir(parents=True, exist_ok=True)
        loose.write_text("deadbeef\n", encoding="utf-8")

        assert pending._read_git_ref_state(root / ".git", "refs/heads/main") == "deadbeef"

    def test_falls_back_to_packed_refs(self, tmp_path):
        root = _repo(tmp_path, pack=True)
        sha = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "main"],
            check=False, capture_output=True, text=True,
        ).stdout.strip()
        assert pending._read_git_ref_state(root / ".git", "refs/heads/main") == sha

    def test_unknown_ref_is_the_missing_sentinel(self, tmp_path):
        root = _repo(tmp_path, pack=True)
        assert pending._read_git_ref_state(root / ".git", "refs/heads/nope") == "<missing-ref>"

    def test_packed_refs_comments_and_blank_lines_are_skipped(self, tmp_path):
        root = _repo(tmp_path, pack=False)
        # Remove the loose ref so the packed-refs file is actually consulted.
        (root / ".git" / "refs" / "heads" / "main").unlink()
        (root / ".git" / "packed-refs").write_text(
            "# pack-refs with: peeled fully-peeled sorted \n"
            "\n"
            "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee refs/heads/main\n",
            encoding="utf-8",
        )
        assert (
            pending._read_git_ref_state(root / ".git", "refs/heads/main")
            == "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee"
        )

    def test_unreadable_packed_refs_does_not_raise(self, tmp_path):
        root = _repo(tmp_path, pack=False)
        (root / ".git" / "refs" / "heads" / "main").unlink()
        (root / ".git" / "packed-refs").mkdir()  # a directory, not a file
        assert (
            pending._read_git_ref_state(root / ".git", "refs/heads/main") == "<missing-ref>"
        )
