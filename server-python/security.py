"""Filesystem access control, shared by every tool regardless of which
AI provider requested it.

Nothing here talks to any AI provider — it's pure path/filename logic,
so it doesn't move when providers change.
"""

import json
import os
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path, PurePosixPath, PureWindowsPath
from threading import Lock
from typing import Iterable, Optional


_CONFIG_DIR = Path.home() / ".ai-terminal-chat"
_CONFIG_FILE = _CONFIG_DIR / "config.json"
CHOOSE_PROJECT_ROOT = "__CHOOSE_PROJECT_ROOT__"
# Lock protecting the load-modify-write sequence against concurrent
# mutations from multiple threads (e.g. Flask threaded=True or a
# multi-threaded WSGI server). Without this, two threads can read the
# same config, mutate different keys, and write back in either order,
# silently dropping the other thread's changes.
_CONFIG_LOCK = Lock()


def _default_project_root() -> Path:
    return Path.cwd().resolve()


def _load_project_root() -> Path:
    """Load a saved project root, falling back safely to the cwd."""

    configured = os.environ.get("AI_TERMINAL_PROJECT_ROOT", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.exists() and candidate.is_dir():
            return candidate

    try:
        data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        configured = str(data.get("project_root", "")).strip()
        if configured:
            candidate = Path(configured).expanduser().resolve()
            if candidate.exists() and candidate.is_dir():
                return candidate
    except (OSError, ValueError, TypeError):
        pass

    return _default_project_root()


class _ProjectRootProxy:
    """Mutable Path-like object shared by all imported tool modules.

    Existing modules import ``PROJECT_ROOT`` directly. Keeping one stable
    object means changing the configured root updates those imports without
    requiring every module to be reloaded.
    """

    def __init__(self, path: Path):
        self._path = Path(path).resolve()

    def set(self, path: Path) -> None:
        self._path = Path(path).resolve()

    def resolve(self) -> Path:
        return self._path.resolve()

    def relative_to(self, other):
        other_path = other.resolve() if hasattr(other, "resolve") else Path(other).resolve()
        return self._path.relative_to(other_path)

    def __truediv__(self, other):
        return self._path / other

    def __fspath__(self):
        return os.fspath(self._path)

    def __str__(self):
        return str(self._path)

    def __repr__(self):
        return repr(self._path)

    def __getattr__(self, name):
        return getattr(self._path, name)

    def __eq__(self, other):
        return self._path == Path(other)

    def __hash__(self):
        return hash(self._path)


PROJECT_ROOT = _ProjectRootProxy(_load_project_root())


def get_project_root() -> Path:
    """Return the currently configured absolute project root."""

    return PROJECT_ROOT.resolve()


def _load_config() -> dict:
    """Load the full application configuration file, or an empty dict."""

    try:
        data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, ValueError, TypeError):
        pass
    return {}


def _persist_config(payload: dict) -> None:
    """Persist the full configuration dict atomically outside the project."""

    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    fd, temp_name = tempfile.mkstemp(
        prefix="config-",
        suffix=".tmp",
        dir=_CONFIG_DIR,
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, _CONFIG_FILE)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _persist_project_root(root: Path) -> None:
    """Persist the selected project root atomically outside the project.

    Merges into any existing configuration so other keys (for example
    allowed_commands) are preserved.
    """

    with _CONFIG_LOCK:
        payload = _load_config()
        payload["project_root"] = str(root)
        _persist_config(payload)


def load_provider_selection() -> dict:
    """Return the persisted provider selection from the config file.

    Returns a dict that may contain ``provider``, ``model``, and
    ``ollama_base_url``. Missing or empty values are omitted so callers
    can distinguish "not set" from an empty string.
    """

    data = _load_config()
    out = {}
    provider = data.get("provider")
    if isinstance(provider, str) and provider.strip():
        out["provider"] = provider.strip().lower()
    model = data.get("model")
    if isinstance(model, str) and model.strip():
        out["model"] = model.strip()
    ollama_base_url = data.get("ollama_base_url")
    if isinstance(ollama_base_url, str) and ollama_base_url.strip():
        out["ollama_base_url"] = ollama_base_url.strip()
    return out


def persist_provider_selection(
    provider: str,
    model: str | None = None,
    ollama_base_url: str | None = None,
) -> None:
    """Persist the active provider selection to the config file.

    Merges into any existing configuration. When ``ollama_base_url`` is
    provided it is normalised to include a scheme; when the active provider
    is not Ollama the stored URL is removed so stale values do not leak
    across provider switches.
    """

    with _CONFIG_LOCK:
        payload = _load_config()
        payload["provider"] = str(provider).strip().lower()
        if model is not None:
            model_s = str(model).strip()
            if model_s:
                payload["model"] = model_s
            else:
                payload.pop("model", None)
        if ollama_base_url is not None:
            url = str(ollama_base_url).strip()
            if url:
                if "://" not in url:
                    url = f"http://{url}"
                payload["ollama_base_url"] = url
            else:
                payload.pop("ollama_base_url", None)
        elif payload.get("provider") != "ollama":
            payload.pop("ollama_base_url", None)
        _persist_config(payload)


def _choose_project_root() -> Path:
    """Open the local operating-system folder picker and return its selection."""

    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise OSError("The native folder picker is unavailable on this system.") from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    root.update()
    try:
        selected = filedialog.askdirectory(
            parent=root,
            title="Choose project folder",
            mustexist=True,
        )
    finally:
        root.destroy()

    if not selected:
        raise ValueError("Folder selection was cancelled.")

    return Path(selected).expanduser().resolve()


def set_project_root(path: str) -> Path:
    """Validate, persist, and activate a new project root.

    Passing CHOOSE_PROJECT_ROOT opens the native operating-system folder
    picker. The selected path must exist and be a directory. The
    configuration file is stored under the user's home directory, outside
    the project, so the AI's filesystem tools cannot expose it.
    """

    if str(path).strip() == CHOOSE_PROJECT_ROOT:
        candidate = _choose_project_root()
    else:
        if not path or not str(path).strip():
            raise ValueError("A project path is required.")
        candidate = Path(str(path).strip()).expanduser().resolve()

    if not candidate.exists():
        raise ValueError(f"Project path does not exist: {candidate}")
    if not candidate.is_dir():
        raise ValueError(f"Project path is not a directory: {candidate}")

    _persist_project_root(candidate)
    PROJECT_ROOT.set(candidate)
    return candidate


def safe_path(path: str) -> Path:
    """Resolve a path while keeping it inside the configured project.

    Rejects absolute paths (POSIX or Windows-style, e.g. "/etc/passwd" or
    "C:\\Users\\...") and any traversal (e.g. "../../") that would escape
    PROJECT_ROOT. Joining an absolute path onto PROJECT_ROOT would normally
    just replace it outright in pathlib, so we check for that explicitly
    before ever resolving the path, in addition to the containment check
    below which catches "../" traversal.
    """

    if not path or not str(path).strip():
        raise ValueError("A path is required.")

    if PurePosixPath(path).is_absolute() or PureWindowsPath(path).is_absolute():
        raise ValueError(
            "Absolute paths are not allowed. Use a path relative to the "
            "project root."
        )

    root = get_project_root()
    requested = (root / path).resolve()

    try:
        requested.relative_to(root)
    except ValueError:
        raise ValueError("Access outside the project directory is not allowed.")

    return requested


SENSITIVE_EXACT_NAMES = {
    ".git-credentials",
    "credentials.json",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
}
SENSITIVE_SUFFIXES = (".pem", ".key")
ENV_TEMPLATE_NAMES = {
    ".env.example",
    ".env.sample",
    ".env.template",
}


def is_sensitive_filename(name: str) -> bool:
    """True if a filename looks like it holds secrets/credentials."""

    lower = name.lower()

    if lower in ENV_TEMPLATE_NAMES:
        return False
    if lower.startswith(".env"):
        return True
    if lower in SENSITIVE_EXACT_NAMES:
        return True
    if lower.endswith(SENSITIVE_SUFFIXES):
        return True
    if "secret" in lower or "credential" in lower:
        return True

    return False


def is_sensitive_path(file_path: Path) -> bool:
    """True if a resolved path is a secret file or lives inside .git."""

    try:
        rel_parts = file_path.relative_to(get_project_root()).parts
    except ValueError:
        return True

    if ".git" in rel_parts:
        return True

    return is_sensitive_filename(file_path.name)


# ---------------------------------------------------------------------------
# Agent read-permission set (selected Project files)
# ---------------------------------------------------------------------------
# When the user selects files on the Project page, those relative paths become
# the only files the agent may read through filesystem tools. The set is
# request-scoped via a context variable so concurrent chats stay isolated.
# Default is None (unrestricted) so the normal Project page can browse the
# project. During an agent request, app.py explicitly installs the selected
# paths; an empty list then means restriction active with no readable files.
# Existing PROJECT_ROOT and sensitive-file rules always still apply.

_allowed_read_paths: ContextVar[Optional[frozenset[str]]] = ContextVar(
    "allowed_read_paths", default=None
)


def _normalize_allowed_path(path: str) -> str:
    """Normalize a user-supplied relative path to the form used for matching.

    Uses safe_path so absolute / traversal paths are rejected. Returns the
    POSIX-style relative path string (forward slashes) under PROJECT_ROOT.
    """

    resolved = safe_path(path)
    rel = resolved.relative_to(get_project_root())
    return rel.as_posix()


def set_allowed_read_paths(paths: Optional[Iterable[str]]) -> Optional[frozenset[str]]:
    """Validate and install the allowed read set for the current context.

    ``None`` means unrestricted (normal non-agent filesystem browsing).
    An empty iterable installs an empty frozenset: restriction active, no
    files readable. Invalid path entries are dropped.

    Returns the value stored in the context variable (``None`` or a frozenset).
    """

    if paths is None:
        _allowed_read_paths.set(None)
        return None

    normalized: set[str] = set()
    for raw in paths:
        if not isinstance(raw, str) or not raw.strip():
            continue
        try:
            normalized.add(_normalize_allowed_path(raw.strip()))
        except ValueError:
            continue

    result = frozenset(normalized)
    _allowed_read_paths.set(result)
    return result


def clear_allowed_read_paths() -> None:
    """Reset agent read restriction to normal unrestricted filesystem browsing."""

    _allowed_read_paths.set(None)


def get_allowed_read_paths() -> Optional[frozenset[str]]:
    """Return the active allowed set, or None when unrestricted."""

    return _allowed_read_paths.get()


@contextmanager
def allowed_read_paths_context(paths: Optional[Iterable[str]]):
    """Context manager that sets allowed paths then restores the previous value."""

    if paths is None:
        token = _allowed_read_paths.set(None)
    else:
        normalized: set[str] = set()
        for raw in paths:
            if not isinstance(raw, str) or not raw.strip():
                continue
            try:
                normalized.add(_normalize_allowed_path(raw.strip()))
            except ValueError:
                continue
        token = _allowed_read_paths.set(frozenset(normalized))
    try:
        yield get_allowed_read_paths()
    finally:
        _allowed_read_paths.reset(token)


def is_read_allowed(path: str | Path) -> bool:
    """True if the path may be read under the current permission set.

    Call after safe_path / sensitive checks. When unrestricted (None),
    always returns True. An empty frozenset (the agent's no-selection case)
    denies all.
    """

    allowed = _allowed_read_paths.get()
    if allowed is None:
        return True

    try:
        if isinstance(path, Path):
            root = get_project_root()
            try:
                rel = path.resolve().relative_to(root).as_posix()
            except ValueError:
                return False
        else:
            rel = _normalize_allowed_path(str(path))
    except ValueError:
        return False

    return rel in allowed


def require_read_allowed(path: str | Path) -> None:
    """Raise ValueError if the path is outside the allowed read set."""

    if not is_read_allowed(path):
        display = path if isinstance(path, str) else str(path)
        try:
            if isinstance(path, Path):
                display = path.resolve().relative_to(get_project_root()).as_posix()
        except Exception:
            pass
        raise ValueError(
            f"Access denied: '{display}' is not in the set of files the user "
            f"selected for the agent. Select it on the Project page first."
        )
