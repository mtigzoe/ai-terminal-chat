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


def test_cancel_unknown_request_id_records_pending_intent():
    # Cancel before register must succeed and be observed later.
    assert cancellation.cancel("never-registered") is True
    event = cancellation.register("never-registered")
    assert event.is_set() is True


def test_release_stops_tracking_a_request():
    cancellation.register("req-1")
    cancellation.release("req-1")

    # After release, cancel records a fresh pending intent rather than
    # operating on a live registration.
    assert cancellation.cancel("req-1") is True
    event = cancellation.register("req-1")
    assert event.is_set() is True


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

    # req-1 was evicted; cancel now records a pending intent.
    assert cancellation.cancel("req-1") is True
    event = cancellation.register("req-1")
    assert event.is_set() is True
    assert cancellation.cancel("req-3") is True


def test_cancel_before_register_is_observed_on_register():
    """Cancel that arrives before register must still abort the request."""
    result = cancellation.cancel("early-cancel")
    assert result is True

    event = cancellation.register("early-cancel")
    assert event.is_set() is True


def test_cancel_before_register_is_consumed_only_once():
    cancellation.cancel("once")
    first = cancellation.register("once")
    assert first.is_set() is True

    second = cancellation.register("once")
    assert second.is_set() is False


def test_release_clears_pending_cancellation_intent():
    cancellation.cancel("pending-only")
    cancellation.release("pending-only")
    event = cancellation.register("pending-only")
    assert event.is_set() is False


def test_pending_cancellation_capacity_evicts_oldest(monkeypatch):
    monkeypatch.setattr(cancellation, "MAX_TRACKED_REQUESTS", 2)
    cancellation.cancel("p1")
    cancellation.cancel("p2")
    cancellation.cancel("p3")
    # p1 should have been evicted from the pending set
    event1 = cancellation.register("p1")
    assert event1.is_set() is False
    event3 = cancellation.register("p3")
    assert event3.is_set() is True
