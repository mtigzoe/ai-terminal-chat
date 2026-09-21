import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import security  # noqa: E402
from pending import (  # noqa: E402
    clear_pending,
    create_pending,
    get_pending,
    pop_pending,
    _confirmation_paths_for_pending,
    _resolve_git_dir,
)


def setup_function():
    clear_pending()


def teardown_function():
    clear_pending()


def test_pending_action_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    (tmp_path / "app.py").write_text("original\n", encoding="utf-8")

    action = create_pending(
        "write_file",
        {"path": "app.py"},
        {"requires_confirmation": True, "diff": "+change"},
    )

    stored = get_pending(action.action_id)
    assert stored is not None
    assert stored.tool_name == "write_file"
    assert stored.args == {"path": "app.py"}
    assert stored.preview["requires_confirmation"] is True

    consumed = pop_pending(action.action_id)
    assert consumed.action_id == action.action_id
    assert get_pending(action.action_id) is None
    assert pop_pending(action.action_id) is None


def test_pop_pending_rejects_when_target_file_changes(tmp_path, monkeypatch):
    """TOCTOU: a write confirmation must not apply if the file changed after preview."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    target = tmp_path / "example.txt"
    target.write_text("original\n", encoding="utf-8")

    action = create_pending(
        "write_file",
        {"path": "example.txt", "contents": "replacement\n"},
        {"requires_confirmation": True},
    )
    assert get_pending(action.action_id) is not None

    target.write_text("changed by another process\n", encoding="utf-8")

    assert pop_pending(action.action_id) is None
    assert get_pending(action.action_id) is None


def test_pop_pending_rejects_when_delete_target_disappears(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    target = tmp_path / "delete-me.txt"
    target.write_text("original\n", encoding="utf-8")

    action = create_pending(
        "delete_file",
        {"path": "delete-me.txt"},
        {"requires_confirmation": True},
    )
    target.unlink()

    assert pop_pending(action.action_id) is None


def test_pop_pending_allows_create_file_when_still_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)

    action = create_pending(
        "create_file",
        {"path": "new-file.txt", "contents": "hello\n"},
        {"requires_confirmation": True},
    )
    # Still missing — confirmation remains valid.
    consumed = pop_pending(action.action_id)
    assert consumed is not None
    assert consumed.tool_name == "create_file"


def test_pop_pending_rejects_when_project_root_changes(tmp_path, monkeypatch):
    """Pending actions must not confirm against a different project root."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    (tmp_path / "file.txt").write_text("original\n", encoding="utf-8")

    action = create_pending(
        "write_file",
        {"path": "file.txt", "contents": "new\n"},
        {"requires_confirmation": True},
        resume={"project_root": str(tmp_path.resolve()), "provider_fingerprint": "fake:model"},
    )
    assert get_pending(action.action_id) is not None

    other = tmp_path / "other-project"
    other.mkdir()
    monkeypatch.setattr(security, "PROJECT_ROOT", other)

    assert pop_pending(action.action_id) is None


def test_pop_pending_rejects_apply_patch_when_listed_file_changes(tmp_path, monkeypatch):
    """apply_patch confirmation binds to the files listed in the preview."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    target = tmp_path / "patched.txt"
    target.write_text("original\n", encoding="utf-8")

    action = create_pending(
        "apply_patch",
        {"patch": "--- a/patched.txt\n+++ b/patched.txt\n"},
        {"requires_confirmation": True, "files": ["patched.txt"]},
    )
    assert get_pending(action.action_id) is not None

    target.write_text("changed after preview\n", encoding="utf-8")

    assert pop_pending(action.action_id) is None


def test_pop_pending_rejects_git_commit_when_index_changes(tmp_path, monkeypatch):
    """git_commit confirmation is bound to the git index fingerprint."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    index = git_dir / "index"
    index.write_bytes(b"DIRC\x00\x00\x00\x02original-index")

    action = create_pending(
        "git_commit",
        {"message": "test"},
        {"requires_confirmation": True},
    )
    assert get_pending(action.action_id) is not None
    states = action.confirmation_file_state
    assert states is not None
    assert any(s.get("kind") == "git_index" for s in states)

    index.write_bytes(b"DIRC\x00\x00\x00\x02changed-index-bytes")

    assert pop_pending(action.action_id) is None


def test_pop_pending_rejects_git_push_when_head_changes(tmp_path, monkeypatch):
    """git_push confirmation is bound to HEAD/branch and remote config."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    refs = git_dir / "refs" / "heads"
    refs.mkdir(parents=True)
    (refs / "main").write_text("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", encoding="utf-8")
    (git_dir / "config").write_text(
        "[remote \"origin\"]\n\turl = https://example.com/repo.git\n",
        encoding="utf-8",
    )

    action = create_pending(
        "git_push",
        {"remote": "origin", "branch": "main"},
        {"requires_confirmation": True},
    )
    assert get_pending(action.action_id) is not None
    kinds = {s.get("kind") for s in (action.confirmation_file_state or [])}
    assert "git_head" in kinds
    assert "git_remote" in kinds

    (refs / "main").write_text("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", encoding="utf-8")

    assert pop_pending(action.action_id) is None


def test_pop_pending_allows_git_commit_when_index_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (git_dir / "index").write_bytes(b"DIRCstable-index")

    action = create_pending(
        "git_commit",
        {"message": "ok"},
        {"requires_confirmation": True},
    )
    consumed = pop_pending(action.action_id)
    assert consumed is not None
    assert consumed.tool_name == "git_commit"


def test_pop_pending_rejects_when_symlink_retargeted_to_identical_content(tmp_path, monkeypatch):
    """A confirmation must bind the symlink entry itself, not just target
    bytes: retargeting to a different in-project file with identical
    content must still invalidate the pending action (TS parity)."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    original = tmp_path / "original.txt"
    original.write_text("same bytes\n", encoding="utf-8")
    decoy = tmp_path / "decoy.txt"
    decoy.write_text("same bytes\n", encoding="utf-8")
    link = tmp_path / "link.txt"
    link.symlink_to(original)

    action = create_pending(
        "write_file",
        {"path": "link.txt", "contents": "new\n"},
        {"requires_confirmation": True},
    )
    assert get_pending(action.action_id) is not None

    link.unlink()
    link.symlink_to(decoy)

    assert pop_pending(action.action_id) is None


def test_pop_pending_allows_symlink_write_when_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    original = tmp_path / "original.txt"
    original.write_text("same bytes\n", encoding="utf-8")
    link = tmp_path / "link.txt"
    link.symlink_to(original)

    action = create_pending(
        "write_file",
        {"path": "link.txt", "contents": "new\n"},
        {"requires_confirmation": True},
    )
    consumed = pop_pending(action.action_id)
    assert consumed is not None


def test_pop_pending_allows_dangling_symlink_delete_when_unchanged(tmp_path, monkeypatch):
    """Dangling in-project symlinks are valid delete targets."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    link = tmp_path / "dangling.txt"
    link.symlink_to(tmp_path / "does-not-exist.txt")

    action = create_pending(
        "delete_file",
        {"path": "dangling.txt"},
        {"requires_confirmation": True},
    )
    consumed = pop_pending(action.action_id)
    assert consumed is not None


def test_pop_pending_rejects_when_dangling_symlink_retargeted(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    link = tmp_path / "dangling.txt"
    link.symlink_to(tmp_path / "does-not-exist.txt")

    action = create_pending(
        "delete_file",
        {"path": "dangling.txt"},
        {"requires_confirmation": True},
    )

    link.unlink()
    link.symlink_to(tmp_path / "somewhere-else.txt")

    assert pop_pending(action.action_id) is None


def test_pop_pending_rejects_create_file_when_parent_symlink_retargeted(tmp_path, monkeypatch):
    """A still-missing create target must bind its resolved parent so
    retargeting an in-project symlinked parent directory cannot move a
    confirmed write to a different location."""
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    real_dir_a = tmp_path / "real-a"
    real_dir_a.mkdir()
    real_dir_b = tmp_path / "real-b"
    real_dir_b.mkdir()
    link_dir = tmp_path / "linked"
    link_dir.symlink_to(real_dir_a)

    action = create_pending(
        "create_file",
        {"path": "linked/new-file.txt", "contents": "hello\n"},
        {"requires_confirmation": True},
    )

    link_dir.unlink()
    link_dir.symlink_to(real_dir_b)

    assert pop_pending(action.action_id) is None


def test_pop_pending_allows_create_file_under_unchanged_symlinked_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    link_dir = tmp_path / "linked"
    link_dir.symlink_to(real_dir)

    action = create_pending(
        "create_file",
        {"path": "linked/new-file.txt", "contents": "hello\n"},
        {"requires_confirmation": True},
    )
    consumed = pop_pending(action.action_id)
    assert consumed is not None


def test_pop_pending_finds_git_dir_when_project_root_is_a_subdirectory(tmp_path, monkeypatch):
    """PROJECT_ROOT may be a subdirectory of the actual git repository —
    the real git binary discovers the repo by walking upward from cwd
    (see tools._run_git, and apply_patch's own comment about this exact
    scenario), so git-index/HEAD/remote fingerprinting must do the same
    or every git_add/git_commit/git_push/etc. confirmation would
    silently and permanently fail as 'unavailable'."""
    repo_root = tmp_path
    git_dir = repo_root / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    index = git_dir / "index"
    index.write_bytes(b"DIRC\x00\x00\x00\x02original-index")

    project_root = repo_root / "subproject"
    project_root.mkdir()
    monkeypatch.setattr(security, "PROJECT_ROOT", project_root)

    action = create_pending(
        "git_commit",
        {"message": "test"},
        {"requires_confirmation": True},
    )
    states = action.confirmation_file_state
    assert states is not None
    git_state = next(s for s in states if s.get("kind") == "git_index")
    assert git_state["status"] == "present"
    assert pop_pending(action.action_id) is not None

    # And a real change to the index (found via the walk-up) is still caught.
    action2 = create_pending(
        "git_commit",
        {"message": "test"},
        {"requires_confirmation": True},
    )
    index.write_bytes(b"DIRC\x00\x00\x00\x02changed-index-bytes")
    assert pop_pending(action2.action_id) is None


def test_pop_pending_rejects_git_commit_when_no_repo_found_anywhere(tmp_path, monkeypatch):
    project_root = tmp_path / "no-repo-here"
    project_root.mkdir()
    monkeypatch.setattr(security, "PROJECT_ROOT", project_root)

    action = create_pending(
        "git_commit",
        {"message": "test"},
        {"requires_confirmation": True},
    )
    states = action.confirmation_file_state
    git_state = next(s for s in states if s.get("kind") == "git_index")
    assert git_state["status"] == "unavailable"
    assert pop_pending(action.action_id) is None


def test_resolve_git_dir_stops_at_malformed_git_entry_instead_of_walking_further(tmp_path):
    """A .git entry that exists but is neither a worktree pointer file
    nor a directory must not be skipped in favor of a real repo further
    up the tree — git itself would refuse rather than keep searching
    ancestors, and neither should we."""
    outer_git = tmp_path / ".git"
    outer_git.mkdir()
    (outer_git / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (outer_git / "index").write_bytes(b"DIRC")

    project_root = tmp_path / "sub"
    project_root.mkdir()
    (project_root / ".git").write_text("not a valid worktree pointer\n", encoding="utf-8")

    assert _resolve_git_dir(project_root) is None


def test_confirmation_paths_for_git_restore_falls_back_to_index_when_path_missing():
    """git_restore's JSON schema requires "path", but a malformed/
    hallucinated model call could still omit or blank it. Unlike
    create_file/write_file/delete_file/git_add (where an empty path
    correctly means "nothing to fingerprint"), git_restore must still
    fall back to binding the git index -- otherwise the pending action
    would get zero fingerprint protection and become unconditionally
    confirmable regardless of what changed in the meantime. staged=True
    is also checked ahead of path so "unstage everything" isn't skipped
    by the same fallback (TS parity: confirmation-state.ts's
    confirmationPathsForPending)."""
    assert _confirmation_paths_for_pending("git_restore", {"staged": True}, None) == [
        "__git_head__",
        "__git_index__",
    ]
    assert _confirmation_paths_for_pending("git_restore", {}, None) == ["__git_index__"]
    assert _confirmation_paths_for_pending(
        "git_restore", {"path": "   ", "staged": False}, None
    ) == ["__git_index__"]
