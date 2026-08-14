import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from pending import clear_pending, create_pending, get_pending, pop_pending  # noqa: E402


def setup_function():
    clear_pending()


def teardown_function():
    clear_pending()


def test_pending_action_round_trip():
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
