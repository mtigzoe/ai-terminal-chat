"""In-memory confirmation store for model-requested file changes.

Write tools already provide preview/confirmation semantics. This module adds
an application-level gate so the agent cannot approve its own write operation.
A pending action is created from the model's original tool call and can only
be executed later through the explicit confirmation API.

For path-based write/delete tools and git mutating tools, fingerprints are
captured at preview time. If the target (file, index, HEAD, or remote config)
changes before the user Allows, pop_pending discards the action (TOCTOU
protection, mirrors TypeScript confirmation-state).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Optional
from uuid import uuid4

from security import get_project_root, safe_path

MAX_PENDING_ACTIONS = 100
MAX_FINGERPRINT_BYTES = 50 * 1024 * 1024

GIT_INDEX_MARKER = "__git_index__"
GIT_HEAD_MARKER = "__git_head__"
GIT_PUSH_HEAD_PREFIX = "__git_push_head__:"
GIT_REMOTE_PREFIX = "__git_remote__:"

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
    # Fingerprints captured at preview time. When present, confirmation is
    # rejected if any fingerprint no longer matches.
    confirmation_file_state: Optional[list] = None


_PENDING = {}
_LOCK = Lock()


def _resolve_git_dir(root: Path) -> Optional[Path]:
    """Return the git directory for the project, handling worktree .git files."""
    git_entry = root / ".git"
    try:
        if not git_entry.exists():
            return None
        if git_entry.is_file():
            text = git_entry.read_text(encoding="utf-8", errors="replace")
            match = re.search(r"^gitdir:\s*(.+)\s*$", text, re.IGNORECASE | re.MULTILINE)
            if not match:
                return None
            return (root / match.group(1).strip()).resolve()
        if git_entry.is_dir():
            return git_entry.resolve()
    except OSError:
        return None
    return None


def _fingerprint_path(rel_path: str) -> dict:
    """Capture a stable fingerprint of a project-relative path."""
    normalized = str(rel_path or "").strip()
    if not normalized:
        return {"path": normalized, "status": "unavailable", "sha256": None}
    try:
        resolved = safe_path(normalized)
    except ValueError:
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


def _fingerprint_git_index() -> dict:
    marker = GIT_INDEX_MARKER
    try:
        git_dir = _resolve_git_dir(get_project_root())
        if git_dir is None:
            return {"kind": "git_index", "path": marker, "status": "unavailable", "sha256": None}
        index_path = git_dir / "index"
        if not index_path.exists():
            return {"kind": "git_index", "path": marker, "status": "missing", "sha256": None}
        digest = hashlib.sha256(index_path.read_bytes()).hexdigest()
        return {"kind": "git_index", "path": marker, "status": "present", "sha256": digest}
    except OSError:
        return {"kind": "git_index", "path": marker, "status": "unavailable", "sha256": None}


def _fingerprint_git_head(branch: Optional[str] = None) -> dict:
    marker = f"{GIT_PUSH_HEAD_PREFIX}{branch}" if branch else GIT_HEAD_MARKER
    try:
        git_dir = _resolve_git_dir(get_project_root())
        if git_dir is None:
            return {"kind": "git_head", "path": marker, "status": "unavailable", "sha256": None}

        head_path = git_dir / "HEAD"
        if not head_path.exists():
            return {"kind": "git_head", "path": marker, "status": "missing", "sha256": None}
        head = head_path.read_text(encoding="utf-8", errors="replace").strip()

        ref_state = ""
        is_symbolic = head.startswith("ref:")
        if branch:
            ref = f"refs/heads/{branch}"
            ref_path = git_dir / ref
            if ref_path.is_file():
                ref_state = ref_path.read_text(encoding="utf-8", errors="replace").strip()
            else:
                # Fall back to packed-refs
                packed = git_dir / "packed-refs"
                ref_state = "<missing-ref>"
                if packed.is_file():
                    for line in packed.read_text(encoding="utf-8", errors="replace").splitlines():
                        if line.startswith("#") or not line.strip():
                            continue
                        parts = line.split()
                        if len(parts) >= 2 and parts[-1] == ref:
                            ref_state = parts[0]
                            break
            state = ref_state
        elif is_symbolic:
            ref = head[4:].strip()
            ref_path = git_dir / ref
            if ref_path.is_file():
                ref_state = ref_path.read_text(encoding="utf-8", errors="replace").strip()
            else:
                ref_state = "<missing-ref>"
            state = head + "\n" + ref_state
        else:
            state = head

        digest = hashlib.sha256(state.encode("utf-8")).hexdigest()
        return {"kind": "git_head", "path": marker, "status": "present", "sha256": digest}
    except OSError:
        return {"kind": "git_head", "path": marker, "status": "unavailable", "sha256": None}


def _fingerprint_git_remote(remote: str) -> dict:
    marker = f"{GIT_REMOTE_PREFIX}{remote}"
    try:
        if not remote or (remote != "<default>" and not re.fullmatch(r"[\w.-]+", remote)):
            return {"kind": "git_remote", "path": marker, "status": "unavailable", "sha256": None}

        git_dir = _resolve_git_dir(get_project_root())
        if git_dir is None:
            return {"kind": "git_remote", "path": marker, "status": "unavailable", "sha256": None}

        common_dir = git_dir
        commondir_path = git_dir / "commondir"
        if commondir_path.exists():
            common_ref = commondir_path.read_text(encoding="utf-8", errors="replace").strip()
            if not common_ref:
                return {"kind": "git_remote", "path": marker, "status": "unavailable", "sha256": None}
            common_dir = (git_dir / common_ref).resolve()

        config_parts: list[str] = []
        for config_path, tag in (
            (common_dir / "config", "\0config\0"),
            (git_dir / "config.worktree", "\0worktree\0"),
        ):
            if not config_path.exists():
                continue
            if config_path.is_symlink() or not config_path.is_file():
                return {"kind": "git_remote", "path": marker, "status": "unavailable", "sha256": None}
            config_parts.append(tag)
            config_parts.append(config_path.read_text(encoding="utf-8", errors="replace"))

        # Legacy file-based remotes
        for directory_name in ("remotes", "branches"):
            directory_path = git_dir / directory_name
            if not directory_path.exists():
                config_parts.append(f"\0{directory_name}:missing\0")
                continue
            if directory_path.is_symlink() or not directory_path.is_dir():
                return {"kind": "git_remote", "path": marker, "status": "unavailable", "sha256": None}
            entries = sorted(directory_path.iterdir(), key=lambda p: p.name)
            config_parts.append(f"\0{directory_name}:entries\0")
            for entry in entries:
                if entry.is_symlink() or not entry.is_file():
                    return {"kind": "git_remote", "path": marker, "status": "unavailable", "sha256": None}
                config_parts.append(f"\0{directory_name}:{entry.name}\0")
                config_parts.append(entry.read_text(encoding="utf-8", errors="replace"))

        payload = "".join(config_parts).encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        return {"kind": "git_remote", "path": marker, "status": "present", "sha256": digest}
    except OSError:
        return {"kind": "git_remote", "path": marker, "status": "unavailable", "sha256": None}


def _fingerprint_marker(marker: str) -> dict:
    if marker == GIT_INDEX_MARKER:
        return _fingerprint_git_index()
    if marker == GIT_HEAD_MARKER:
        return _fingerprint_git_head()
    if marker.startswith(GIT_PUSH_HEAD_PREFIX):
        return _fingerprint_git_head(marker[len(GIT_PUSH_HEAD_PREFIX) :])
    if marker.startswith(GIT_REMOTE_PREFIX):
        return _fingerprint_git_remote(marker[len(GIT_REMOTE_PREFIX) :])
    return _fingerprint_path(marker)


def _confirmation_paths_for_pending(tool_name: str, args: dict, preview: Optional[dict]) -> list[str]:
    """Return marker/path list to fingerprint for a pending tool (TS parity)."""
    if tool_name in ("create_file", "write_file", "delete_file"):
        target = args.get("path")
        return [target.strip()] if isinstance(target, str) and target.strip() else []

    if tool_name == "git_add":
        target = args.get("path")
        if not isinstance(target, str) or not target.strip():
            return []
        return [target.strip(), GIT_INDEX_MARKER]

    if tool_name == "git_restore":
        target = args.get("path")
        if args.get("staged") is True:
            return [GIT_HEAD_MARKER, GIT_INDEX_MARKER]
        if isinstance(target, str) and target.strip():
            return [target.strip(), GIT_INDEX_MARKER]
        return [GIT_INDEX_MARKER]

    if tool_name == "git_commit":
        return [GIT_INDEX_MARKER]

    if tool_name == "git_push":
        branch = args.get("branch") if isinstance(args.get("branch"), str) else ""
        branch = branch.strip()
        remote = args.get("remote") if isinstance(args.get("remote"), str) else ""
        remote = remote.strip()
        head_marker = (
            f"{GIT_PUSH_HEAD_PREFIX}{branch}"
            if branch and re.fullmatch(r"[A-Za-z0-9._/-]+", branch)
            else GIT_HEAD_MARKER
        )
        remote_marker = (
            f"{GIT_REMOTE_PREFIX}{remote}"
            if remote and re.fullmatch(r"[\w.-]+", remote)
            else f"{GIT_REMOTE_PREFIX}<default>"
        )
        return [head_marker, remote_marker]

    if tool_name == "git_pull":
        remote = args.get("remote") if isinstance(args.get("remote"), str) else ""
        remote = remote.strip()
        remote_marker = (
            f"{GIT_REMOTE_PREFIX}{remote}"
            if remote and re.fullmatch(r"[\w.-]+", remote)
            else f"{GIT_REMOTE_PREFIX}<default>"
        )
        return [GIT_HEAD_MARKER, GIT_INDEX_MARKER, remote_marker]

    if tool_name == "apply_patch" and isinstance(preview, dict):
        files = preview.get("files")
        if isinstance(files, list):
            return [str(p).strip() for p in files if isinstance(p, str) and str(p).strip()]
        return []

    return []


def _capture_file_state(tool_name: str, args: dict, preview: Optional[dict] = None) -> Optional[list]:
    """Return a list of fingerprints, or None if the tool is not bound."""
    paths = _confirmation_paths_for_pending(tool_name, args or {}, preview)
    if not paths:
        return None
    # Dedupe while preserving order
    seen = set()
    unique = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return [_fingerprint_marker(p) for p in unique]


def _file_state_matches(saved: Optional[list]) -> bool:
    if not saved:
        return True
    if not isinstance(saved, list):
        saved = [saved]
    for entry in saved:
        if not isinstance(entry, dict):
            return False
        if entry.get("status") == "unavailable":
            return False
        kind = entry.get("kind")
        path = entry.get("path") or ""
        if kind == "git_index":
            current = _fingerprint_git_index()
        elif kind == "git_head":
            branch = (
                path[len(GIT_PUSH_HEAD_PREFIX) :]
                if path.startswith(GIT_PUSH_HEAD_PREFIX)
                else None
            )
            current = _fingerprint_git_head(branch)
        elif kind == "git_remote":
            remote = path[len(GIT_REMOTE_PREFIX) :] if path.startswith(GIT_REMOTE_PREFIX) else ""
            current = _fingerprint_git_remote(remote)
        else:
            current = _fingerprint_path(path)
        if not (
            current.get("status") == entry.get("status")
            and current.get("sha256") == entry.get("sha256")
        ):
            return False
    return True


def create_pending(tool_name: str, args: dict, preview: dict, resume: Optional[dict] = None) -> PendingAction:
    """Store one model-requested write and return its opaque action id."""

    action = PendingAction(
        action_id=uuid4().hex,
        tool_name=tool_name,
        args=dict(args),
        preview=preview,
        resume=resume,
        confirmation_file_state=_capture_file_state(tool_name, args or {}, preview),
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

    Returns None if the action is missing, the project root changed since the
    action was created, or its confirmation file fingerprint no longer matches
    (target changed after the preview was shown).
    """

    with _LOCK:
        action = _PENDING.get(action_id)
        if action is None:
            return None
        resume = action.resume or {}
        saved_root = resume.get("project_root")
        if saved_root:
            try:
                if Path(str(saved_root)).resolve() != get_project_root().resolve():
                    del _PENDING[action_id]
                    return None
            except OSError:
                del _PENDING[action_id]
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
