import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import cancellation  # noqa: E402


def teardown_function(_fn):
    cancellation.clear()


def test_register_returns_a_fresh_unset_event():
    event = cancellation.register("req-1")
    assert event.is_set() is False


def test_cancel_sets_the_registered_event():
    event = cancellation.register("req-1")
    result = cancellation.cancel("req-1")

    assert result is True
    assert event.is_set() is True


def test_cancel_unknown_request_id_returns_false():
    assert cancellation.cancel("never-registered") is False


def test_release_stops_tracking_a_request():
    cancellation.register("req-1")
    cancellation.release("req-1")

    assert cancellation.cancel("req-1") is False


def test_release_is_safe_for_unknown_or_empty_id():
    # Must not raise even if the request was never registered, or the
    # client never sent a request_id at all (empty string).
    cancellation.release("never-registered")
    cancellation.release("")
    cancellation.release(None)


def test_registering_the_same_id_twice_resets_the_event():
    first = cancellation.register("req-1")
    cancellation.cancel("req-1")
    assert first.is_set() is True

    second = cancellation.register("req-1")
    assert second.is_set() is False


def test_oldest_entry_is_evicted_once_capacity_is_reached(monkeypatch):
    monkeypatch.setattr(cancellation, "MAX_TRACKED_REQUESTS", 2)

    cancellation.register("req-1")
    cancellation.register("req-2")
    cancellation.register("req-3")

    assert cancellation.cancel("req-1") is False
    assert cancellation.cancel("req-3") is True
