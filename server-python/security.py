# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Filesystem access control, shared by every tool regardless of which
AI provider requested it.

Nothing here talks to any AI provider — it's pure path/filename logic,
so it doesn't move when providers change.
"""

import json
import os
import tempfile
from pathlib import Path, PurePosixPath, PureWindowsPath


class MutableProjectRoot:
    """Path-like holder whose value can change without stale imports.

    tools.py imports PROJECT_ROOT directly, so mutating this object lets the
    selected project root take effect everywhere without requiring every
    consumer to be rewritten to import the security module itself.
    """

    def __init__(self, value: Path):
        self._path = Path(value).resolve()

    def set(self, value: Path):
        self._path = Path(value).resolve()

    def __fspath__(self):
        return os.fspath(self._path)

    def __str__(self):
        return str(self._path)

    def __truediv__(self, other):
        return self._path / other

    def __getattr__(self, name):
        return getattr(self._path, name)

    def __eq__(self, other):
        return self._path == Path(other)

    def __hash__(self):
        return hash(self._path)


_CONFIG_DIR = Path.home() / ".ai-terminal-chat"
_CONFIG_FILE = _CONFIG_DIR / "config.json"
CHOOSE_PROJECT_ROOT = "__CHOOSE_PROJECT_ROOT__"


def _load_saved_root() -> Path:
    """Load a saved project root, falling back safely to the cwd."""

    configured = os.environ.get("AI_TERMINAL_PROJECT_ROOT", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.is_dir():
            return candidate

    try:
        data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        configured = str(data.get("project_root", "")).strip()
        if configured:
            candidate = Path(configured).expanduser().resolve()
            if candidate.is_dir():
                return candidate
    except (OSError, ValueError, TypeError):
        pass

    return Path.cwd().resolve()


PROJECT_ROOT = MutableProjectRoot(_load_saved_root())


def get_project_root() -> Path:
    """Return the currently selected project root."""

    return Path(os.fspath(PROJECT_ROOT)).resolve()


def _persist_project_root(root: Path) -> None:
    """Persist the selected project root atomically outside the project."""

    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix="config-",
        suffix=".tmp",
        dir=_CONFIG_DIR,
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"project_root": str(root)}, handle, indent=2)
            handle.write("\n")
        Path(temp_name).replace(_CONFIG_FILE)
    finally:
        try:
            Path(temp_name).unlink()
        except FileNotFoundError:
            pass


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
    picker. The selected path is returned but is not persisted until this
    function completes its normal validation/persistence flow.
    """

    if str(path).strip() == CHOOSE_PROJECT_ROOT:
        candidate = _choose_project_root()
    else:
        if not path or not str(path).strip():
            raise ValueError("A project path is required.")
        candidate = Path(str(path).strip()).expanduser().resolve()

    if not candidate.exists():
        raise ValueError("Project path does not exist.")
    if not candidate.is_dir():
        raise ValueError("Project path must be a directory.")

    PROJECT_ROOT.set(candidate)
    _persist_project_root(candidate)
    return candidate


def safe_path(path: str) -> Path:
    """Resolve a path while keeping it inside the application directory.

    Rejects absolute paths (POSIX or Windows-style, e.g. "/etc/passwd" or
    "C:\\Users\\...") and any traversal (e.g. "../../") that would escape
    PROJECT_ROOT.
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
        raise ValueError(
            "Access outside the project directory is not allowed."
        )

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
        rel_parts = file_path.relative_to(get_project_root()).parts
    except ValueError:
        return True

    if ".git" in rel_parts:
        return True

    return is_sensitive_filename(file_path.name)
