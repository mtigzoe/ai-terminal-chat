"""In-memory confirmation store for model-requested file changes.

Write tools already provide preview/confirmation semantics. This module adds
an application-level gate so the agent cannot approve its own write operation.
A pending action is created from the model's original tool call and can only
be executed later through the explicit confirmation API.
"""

from dataclasses import dataclass, field
from threading import Lock
from typing import Optional
from uuid import uuid4


MAX_PENDING_ACTIONS = 100


@dataclass
class PendingAction:
    action_id: str
    tool_name: str
    args: dict
    preview: dict
    # Present when this action was created mid-agent-loop (as opposed to a
    # standalone/legacy pending action). Carries everything needed to
    # continue the loop once the user Allows or Declines, so a multi-step
    # request (e.g. "add, commit, and push") can proceed automatically
    # instead of stopping after a single confirmed action. See
    # agent.resume_agent_loop() for the shape of this dict.
    resume: Optional[dict] = None


_PENDING = {}
_LOCK = Lock()


def create_pending(tool_name: str, args: dict, preview: dict, resume: Optional[dict] = None) -> PendingAction:
    """Store one model-requested write and return its opaque action id."""

    action = PendingAction(
        action_id=uuid4().hex,
        tool_name=tool_name,
        args=dict(args),
        preview=preview,
        resume=resume,
    )

    with _LOCK:
        if len(_PENDING) >= MAX_PENDING_ACTIONS:
            oldest_id = next(iter(_PENDING))
            del _PENDING[oldest_id]
        _PENDING[action.action_id] = action

    return action


def get_pending(action_id: str):
    """Return a pending action without consuming it."""

    with _LOCK:
        return _PENDING.get(action_id)


def pop_pending(action_id: str):
    """Consume a pending action exactly once."""

    with _LOCK:
        return _PENDING.pop(action_id, None)


def clear_pending() -> None:
    """Clear all pending actions. Intended for tests."""

    with _LOCK:
        _PENDING.clear()
