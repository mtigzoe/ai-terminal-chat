"""Filesystem access control, shared by every tool regardless of which
AI provider requested it.

Nothing here talks to any AI provider — it's pure path/filename logic,
so it doesn't move when providers change.
"""

import json
import os
import tempfile
from pathlib import Path, PurePosixPath, PureWindowsPath


_CONFIG_DIR = Path.home() / ".ai-terminal-chat"
_CONFIG_FILE = _CONFIG_DIR / "config.json"


def _default_project_root() -> Path:
    return Path.cwd().resolve()


def _load_project_root() -> Path:
    """Load the persisted project root, falling back to the server cwd."""

    try:
        data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        configured = data.get("project_root")
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
        self._path = path.resolve()

    def set(self, path: Path) -> None:
        self._path = path.resolve()

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


PROJECT_ROOT = _ProjectRootProxy(_load_project_root())


def get_project_root() -> Path:
    """Return the currently configured absolute project root."""

    return PROJECT_ROOT.resolve()


def set_project_root(path: str) -> Path:
    """Validate, persist, and activate a new project root.

    The selected path must exist and be a directory. The configuration
    file is stored under the user's home directory, outside the project,
    so the AI's filesystem tools cannot expose it.
    """

    if not path or not str(path).strip():
        raise ValueError("A project path is required.")

    candidate = Path(path).expanduser().resolve()

    if not candidate.exists():
        raise ValueError(f"Project path does not exist: {candidate}")

    if not candidate.is_dir():
        raise ValueError(f"Project path is not a directory: {candidate}")

    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"project_root": str(candidate)}

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

    root = PROJECT_ROOT.resolve()
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


def is_sensitive_filename(name: str) -> bool:
    """True if a filename looks like it holds secrets/credentials."""

    lower = name.lower()

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
        rel_parts = file_path.relative_to(PROJECT_ROOT.resolve()).parts
    except ValueError:
        return True

    if ".git" in rel_parts:
        return True

    return is_sensitive_filename(file_path.name)
