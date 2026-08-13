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

from pathlib import Path, PurePosixPath, PureWindowsPath

PROJECT_ROOT = Path.cwd().resolve()


def safe_path(path: str) -> Path:
    """Resolve a path while keeping it inside the application directory.

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

    requested = (PROJECT_ROOT / path).resolve()

    try:
        requested.relative_to(PROJECT_ROOT)
    except ValueError:
        raise ValueError(
            "Access outside the project directory is not allowed."
        )

    return requested


# Filenames/extensions that must never be read, searched, created,
# overwritten, or deleted by the model, even though they live inside
# PROJECT_ROOT. This is what keeps GOOGLE_API_KEY and other secrets out
# of the model's context.
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
        rel_parts = file_path.relative_to(PROJECT_ROOT).parts
    except ValueError:
        return True

    if ".git" in rel_parts:
        return True

    return is_sensitive_filename(file_path.name)
