"""In-memory confirmation store for model-requested file changes.

Write tools already provide preview/confirmation semantics. This module adds
an application-level gate so the agent cannot approve its own write operation.
A pending action is created from the model's original tool call and can only
be executed later through the explicit confirmation API.

For path-based write/delete tools, a content fingerprint is captured at
preview time. If the target changes before the user Allows, pop_pending
discards the action (TOCTOU protection, mirrors TypeScript confirmation-state).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Optional
from uuid import uuid4

from security import get_project_root, safe_path

MAX_PENDING_ACTIONS = 100
MAX_FINGERPRINT_BYTES = 50 * 1024 * 1024

# Tools whose confirmation is bound to a single project-relative file path.
_PATH_BOUND_TOOLS = frozenset(
    {
        "write_file",
        "create_file",
        "delete_file",
        "git_add",
        "git_restore",
    }
)


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
    # Fingerprint of the target path at preview time. When present, confirmation
    # is rejected if the file changed before Allow.
    confirmation_file_state: Optional[dict] = None


_PENDING = {}
_LOCK = Lock()


def _fingerprint_path(rel_path: str) -> dict:
    """Capture a stable fingerprint of a project-relative path.

    status is "present" with sha256 of contents, "missing" if the path does
    not exist, or "unavailable" if the path cannot be safely resolved/read.
    """
    normalized = str(rel_path or "").strip()
    if not normalized:
        return {"path": normalized, "status": "unavailable", "sha256": None}
    try:
        resolved = safe_path(normalized)
    except ValueError:
        # Path may not exist yet (create_file) — still bind under project root.
        try:
            root = get_project_root()
            candidate = (root / normalized).resolve()
            candidate.relative_to(root.resolve())
            resolved = candidate
        except Exception:
            return {"path": normalized, "status": "unavailable", "sha256": None}

    try:
        if not resolved.exists():
            return {"path": normalized, "status": "missing", "sha256": None}
        if not resolved.is_file():
            return {"path": normalized, "status": "unavailable", "sha256": None}
        size = resolved.stat().st_size
        if size > MAX_FINGERPRINT_BYTES:
            return {"path": normalized, "status": "unavailable", "sha256": None}
        digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
        return {"path": normalized, "status": "present", "sha256": digest}
    except OSError:
        return {"path": normalized, "status": "unavailable", "sha256": None}


def _capture_file_state(tool_name: str, args: dict) -> Optional[dict]:
    if tool_name not in _PATH_BOUND_TOOLS:
        return None
    path = args.get("path")
    if not isinstance(path, str) or not path.strip():
        return None
    return _fingerprint_path(path.strip())


def _file_state_matches(saved: Optional[dict]) -> bool:
    if not saved:
        return True
    current = _fingerprint_path(saved.get("path") or "")
    return (
        current.get("status") == saved.get("status")
        and current.get("sha256") == saved.get("sha256")
        and current.get("path") == saved.get("path")
    )


def create_pending(tool_name: str, args: dict, preview: dict, resume: Optional[dict] = None) -> PendingAction:
    """Store one model-requested write and return its opaque action id."""

    action = PendingAction(
        action_id=uuid4().hex,
        tool_name=tool_name,
        args=dict(args),
        preview=preview,
        resume=resume,
        confirmation_file_state=_capture_file_state(tool_name, args or {}),
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
    """Consume a pending action exactly once.

    Returns None if the action is missing or its confirmation file fingerprint
    no longer matches (target changed after the preview was shown).
    """

    with _LOCK:
        action = _PENDING.get(action_id)
        if action is None:
            return None
        if not _file_state_matches(action.confirmation_file_state):
            del _PENDING[action_id]
            return None
        del _PENDING[action_id]
        return action


def clear_pending() -> None:
    """Clear all pending actions. Intended for tests."""

    with _LOCK:
        _PENDING.clear()
