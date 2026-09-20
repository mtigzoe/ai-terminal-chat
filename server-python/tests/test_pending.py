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
