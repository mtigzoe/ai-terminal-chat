import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import security  # noqa: E402
from pending import clear_pending, create_pending, get_pending, pop_pending  # noqa: E402


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
