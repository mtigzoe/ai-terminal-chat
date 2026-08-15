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
"""

from threading import Event, Lock

MAX_TRACKED_REQUESTS = 200

_EVENTS = {}
_LOCK = Lock()


def register(request_id: str) -> Event:
    """Create (or reset) the cancellation event for a request id."""

    event = Event()
    with _LOCK:
        if len(_EVENTS) >= MAX_TRACKED_REQUESTS:
            oldest_id = next(iter(_EVENTS))
            del _EVENTS[oldest_id]
        _EVENTS[request_id] = event
    return event


def cancel(request_id: str) -> bool:
    """Signal cancellation for a request id. Returns False if unknown."""

    with _LOCK:
        event = _EVENTS.get(request_id)
    if event is None:
        return False
    event.set()
    return True


def release(request_id: str) -> None:
    """Stop tracking a request id once it has finished."""

    if not request_id:
        return
    with _LOCK:
        _EVENTS.pop(request_id, None)


def clear() -> None:
    """Clear all tracked requests. Intended for tests."""

    with _LOCK:
        _EVENTS.clear()
