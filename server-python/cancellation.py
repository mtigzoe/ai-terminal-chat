"""Cooperative cancellation registry for in-flight chat requests.

The agent loop can run for a long time — local models in particular
can take far longer than cloud models to generate a turn. A client
that wants to stop early assigns a request_id before starting a
/chat or /stream call, then POSTs that id to /cancel. run_agent_loop
checks the associated threading.Event between rounds and between
tool calls and stops cleanly instead of relying on the client simply
abandoning the HTTP connection while the backend keeps working.

This mirrors pending.py's in-memory, single-process store: no
persistence is needed since a cancellation only matters for the
lifetime of the request it belongs to.

A cancel can arrive before the request handler has registered its
request ID. Keep a bounded cancellation intent so that race is still
observed when register() runs.
"""

from collections import OrderedDict
from threading import Event, Lock

MAX_TRACKED_REQUESTS = 200

_EVENTS = OrderedDict()
_PENDING_CANCELLATIONS = OrderedDict()
_LOCK = Lock()


def register(request_id: str) -> Event:
    """Create (or reset) the cancellation event for a request id.

    If a cancel intent was recorded before registration, the returned
    event is already set. When the registry is at capacity the oldest
    tracked request is cancelled and evicted (mirrors TypeScript).
    """

    event = Event()
    with _LOCK:
        if request_id in _PENDING_CANCELLATIONS:
            del _PENDING_CANCELLATIONS[request_id]
            event.set()
        if request_id in _EVENTS:
            del _EVENTS[request_id]
        if len(_EVENTS) >= MAX_TRACKED_REQUESTS:
            _oldest_id, oldest_event = _EVENTS.popitem(last=False)
            oldest_event.set()
        _EVENTS[request_id] = event
    return event


def cancel(request_id: str) -> bool:
    """Signal cancellation for a request id.

    If the request is not yet registered, record a pending cancellation
    intent so register() will observe it. Always returns True so the
    client receives a consistent acknowledgment.
    """

    with _LOCK:
        event = _EVENTS.get(request_id)
        if event is not None:
            event.set()
            return True
        if request_id in _PENDING_CANCELLATIONS:
            return True
        if len(_PENDING_CANCELLATIONS) >= MAX_TRACKED_REQUESTS:
            _PENDING_CANCELLATIONS.popitem(last=False)
        _PENDING_CANCELLATIONS[request_id] = True
        return True


def release(request_id: str) -> None:
    """Stop tracking a request id once it has finished."""

    if not request_id:
        return
    with _LOCK:
        _EVENTS.pop(request_id, None)
        _PENDING_CANCELLATIONS.pop(request_id, None)


def clear() -> None:
    """Clear all tracked requests. Intended for tests."""

    with _LOCK:
        _EVENTS.clear()
        _PENDING_CANCELLATIONS.clear()
