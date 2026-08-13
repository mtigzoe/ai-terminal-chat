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

import difflib
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path, PurePosixPath, PureWindowsPath

from dotenv import load_dotenv
from flask import Flask, Response, request, stream_with_context
from flask_cors import CORS
from google import genai
from google.genai import types


# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------

load_dotenv()

api_key = os.getenv("GOOGLE_API_KEY")

if not api_key:
    raise RuntimeError(
        "GOOGLE_API_KEY is not set. "
        "Add it to your .env file."
    )

client = genai.Client(
    api_key=api_key
)


# Gemini 3.6 Flash is Google's current GA Flash model tuned for coding,
# tool-use, and multi-step agentic workloads, so it's the default here.
# Override with GEMINI_MODEL if you want a different currently supported
# Gemini model (e.g. a Pro model for harder tasks).
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")

app = Flask(__name__)
CORS(app)


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    """Return a JSON error instead of Flask's default 500 HTML page."""

    print(f"[Unhandled error] {exc}")

    return {
        "text": "",
        "error": f"Unexpected server error: {exc}",
    }, 500


# ---------------------------------------------------------
# Security: restrict filesystem access
# ---------------------------------------------------------

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


# ---------------------------------------------------------
# Gemini filesystem tools
# ---------------------------------------------------------

def list_files(path: str = ".") -> dict:
    """List files and directories inside the application project.

    Args:
        path: Relative directory path inside the project.
              Use "." for the project root.

    Returns:
        A dictionary containing the directory entries.
    """

    try:
        directory = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if not directory.exists():
        return {"error": f"Path does not exist: {path}"}

    if not directory.is_dir():
        return {"error": f"Not a directory: {path}"}

    entries = []

    for item in sorted(
        directory.iterdir(),
        key=lambda p: p.name.lower()
    ):
        entries.append(
            {
                "name": item.name,
                "type": "directory" if item.is_dir() else "file",
            }
        )

    return {
        "path": str(directory.relative_to(PROJECT_ROOT)),
        "entries": entries,
    }


def read_file(path: str) -> dict:
    """Read a UTF-8 text file inside the application project.

    Args:
        path: Relative path to the text file.

    Returns:
        A dictionary containing the file contents.
    """

    try:
        file_path = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if is_sensitive_path(file_path):
        return {
            "error": (
                f"Refusing to read '{path}': it looks like a secrets/"
                f"credentials file (e.g. .env). Its contents are never "
                f"exposed to the model."
            )
        }

    if not file_path.exists():
        return {"error": f"File does not exist: {path}"}

    if not file_path.is_file():
        return {"error": f"Not a file: {path}"}

    # Prevent accidentally sending extremely large files to Gemini.
    max_size = 200_000

    if file_path.stat().st_size > max_size:
        return {
            "error": (
                f"File is too large to read. "
                f"Maximum size is {max_size} bytes."
            )
        }

    try:
        contents = file_path.read_text(
            encoding="utf-8"
        )
    except UnicodeDecodeError:
        return {
            "error": "The file is not a UTF-8 text file."
        }

    return {
        "path": str(file_path.relative_to(PROJECT_ROOT)),
        "contents": contents,
    }


# Directories that are never worth searching (build output, deps, VCS
# internals) — skipping them keeps search_files fast and avoids surfacing
# noise from generated code.
SEARCH_EXCLUDED_DIR_NAMES = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    "dist",
    "build",
    ".next",
    ".pytest_cache",
    ".mypy_cache",
}


def search_files(query: str, path: str = ".") -> dict:
    """Search text files inside the project for a query string.

    Args:
        query: Text to search for (case-insensitive substring match).
        path: Relative directory to search under. Use "." for the whole
              project.

    Returns:
        A dictionary with matching file paths, line numbers, and lines.
    """

    if not query or not query.strip():
        return {"error": "A non-empty search query is required."}

    try:
        directory = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if not directory.exists():
        return {"error": f"Path does not exist: {path}"}

    if not directory.is_dir():
        return {"error": f"Not a directory: {path}"}

    max_matches = 200
    max_file_size = 500_000
    query_lower = query.lower()

    matches = []
    truncated = False

    for root, dirnames, filenames in os.walk(directory):
        dirnames[:] = sorted(
            d for d in dirnames if d not in SEARCH_EXCLUDED_DIR_NAMES
        )

        for filename in sorted(filenames):
            if is_sensitive_filename(filename):
                continue

            file_path = Path(root) / filename

            try:
                if file_path.stat().st_size > max_file_size:
                    continue
                text = file_path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                # Skip binary files and unreadable files.
                continue

            for line_number, line in enumerate(text.splitlines(), start=1):
                if query_lower in line.lower():
                    matches.append(
                        {
                            "path": str(
                                file_path.relative_to(PROJECT_ROOT)
                            ),
                            "line": line_number,
                            "text": line.strip()[:300],
                        }
                    )

                    if len(matches) >= max_matches:
                        truncated = True
                        break

            if truncated:
                break

        if truncated:
            break

    return {
        "query": query,
        "path": str(directory.relative_to(PROJECT_ROOT)),
        "matches": matches,
        "truncated": truncated,
    }


# ---------------------------------------------------------
# Gemini terminal tool
# ---------------------------------------------------------

# Commands are allowlisted by prefix so arguments (a specific file, a
# test name, etc.) are still permitted, e.g. "pytest -k test_login" is
# allowed because it starts with the "pytest" prefix. Read-only
# inspection, dependency install, and test/build commands are included;
# nothing here can commit, push, rewrite history, or delete anything —
# writes to files go through create_file/write_file, and deletion goes
# through delete_file, both of which have their own guardrails.
ALLOWED_COMMAND_PREFIXES = (
    "git status",
    "git branch",
    "git log",
    "git diff",
    "git show",
    "git remote -v",
    "pwd",
    "dir",
    "ls",
    "python --version",
    "python3 --version",
    "node --version",
    "npm --version",
    "pip --version",
    "pip3 --version",
    "pytest",
    "python -m pytest",
    "python3 -m pytest",
    "npm test",
    "npm run test",
    "npm run build",
    "npm run lint",
    "npm install",
    "npm ci",
    "pip install -r requirements.txt",
    "pip list",
    "pip show",
    "flake8",
    "black --check",
    "ruff check",
)

# Characters/sequences that enable chaining, piping, redirection, or
# substitution. Blocking these stops an allowed command from being used
# to smuggle in a second, disallowed command (e.g.
# "git status && rm -rf /").
DANGEROUS_COMMAND_CHARACTERS = (";", "&", "|", "`", "$(", ">", "<", "\n")

# Extra, explicit denylist as defense in depth on top of the allowlist
# above. Anything matching these is refused even if a future edit
# accidentally widens ALLOWED_COMMAND_PREFIXES.
BLOCKED_COMMAND_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\brm\s+-rf\b",
        r"\bsudo\b",
        r"\bshutdown\b",
        r"\breboot\b",
        r"\bpoweroff\b",
        r"\bhalt\b",
        r"\bmkfs\b",
        r"\bformat\b",
        r"\bdd\s+if=",
        r"\bchmod\s+777\b",
        r"\bchown\b",
        r"\.env\b",
        r"\bgoogle_api_key\b",
        r"\bprintenv\b",
        r"\bcredential",
        r"\bid_rsa\b",
    )
]


def is_command_allowed(command: str) -> bool:
    """True if the command matches one of the allowed dev-command prefixes."""

    return any(
        command == prefix or command.startswith(prefix + " ")
        for prefix in ALLOWED_COMMAND_PREFIXES
    )


def run_command(command: str) -> dict:
    """Run an allowlisted development command in the project directory.

    Covers read-only inspection (git status/log/diff/branch, directory
    listings, tool versions), installing dependencies, and running
    tests/builds/linters. Destructive, system-level, or credential-
    exposing commands are always refused.

    Args:
        command: A single command starting with one of the allowed
                 prefixes (e.g. "pytest", "npm test", "git log -n 5").

    Returns:
        The command, exit code, stdout, and stderr.
    """

    if not command or not command.strip():
        return {"error": "No command was provided."}

    command = command.strip()

    for pattern in BLOCKED_COMMAND_PATTERNS:
        if pattern.search(command):
            return {
                "error": (
                    f"This command is blocked for safety: {command}"
                )
            }

    for char in DANGEROUS_COMMAND_CHARACTERS:
        if char in command:
            return {
                "error": (
                    "Command chaining, piping, redirection, and "
                    "substitution are not allowed. Run one plain "
                    "command at a time."
                )
            }

    if not is_command_allowed(command):
        return {
            "error": (
                f"Command not allowed: '{command}'. Allowed command "
                f"prefixes: {sorted(ALLOWED_COMMAND_PREFIXES)}"
            )
        }

    try:
        result = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60,
        )

        # Cap output so a noisy command can't blow up the context window.
        max_output = 20_000

        return {
            "command": command,
            "returncode": result.returncode,
            "stdout": result.stdout[:max_output],
            "stderr": result.stderr[:max_output],
        }

    except subprocess.TimeoutExpired:
        return {
            "error": "Command timed out after 60 seconds."
        }

    except Exception as exc:
        return {
            "error": f"Could not execute command: {exc}"
        }


# ---------------------------------------------------------
# Gemini git tools
# ---------------------------------------------------------

def git_status() -> dict:
    """Show the current git status of the project.

    Equivalent to `git status --short --branch`. Always use this instead
    of guessing what has changed in the repository.

    Returns:
        A dictionary with the short-form status output.
    """

    try:
        result = subprocess.run(
            ["git", "status", "--short", "--branch"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "git status timed out."}
    except Exception as exc:
        return {"error": f"Could not run git status: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git status failed."}

    return {"status": result.stdout}


def git_diff(path: str = "", staged: bool = False) -> dict:
    """Show the current git diff for the project or a single file.

    Args:
        path: Optional relative path to scope the diff to one file.
              Leave empty to diff the whole project.
        staged: If true, show staged changes (git diff --staged)
                instead of unstaged changes.

    Returns:
        A dictionary with the diff text.
    """

    args = ["git", "diff"]

    if staged:
        args.append("--staged")

    if path:
        try:
            file_path = safe_path(path)
        except ValueError as exc:
            return {"error": str(exc)}

        args.append(str(file_path.relative_to(PROJECT_ROOT)))

    try:
        result = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "git diff timed out."}
    except Exception as exc:
        return {"error": f"Could not run git diff: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git diff failed."}

    diff_text = result.stdout
    max_diff = 50_000
    truncated = False

    if len(diff_text) > max_diff:
        diff_text = diff_text[:max_diff]
        truncated = True

    return {"diff": diff_text, "truncated": truncated}


def git_log(max_count: int = 10) -> dict:
    """Show recent commit history for the project.

    Args:
        max_count: Number of commits to show (1-100). Defaults to 10.

    Returns:
        A dictionary with the one-line-per-commit log output.
    """

    try:
        count = int(max_count)
    except (TypeError, ValueError):
        return {"error": "max_count must be a whole number."}

    count = max(1, min(count, 100))

    try:
        result = subprocess.run(
            ["git", "log", f"-{count}", "--oneline", "--decorate"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "git log timed out."}
    except Exception as exc:
        return {"error": f"Could not run git log: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git log failed."}

    return {"log": result.stdout}


def git_branch() -> dict:
    """List local branches and show which one is currently checked out.

    Returns:
        A dictionary with the branch list output (current branch marked
        with '*').
    """

    try:
        result = subprocess.run(
            ["git", "branch", "--list"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "git branch timed out."}
    except Exception as exc:
        return {"error": f"Could not run git branch: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git branch failed."}

    return {"branches": result.stdout}


# ---------------------------------------------------------
# Gemini file-modification tools
# ---------------------------------------------------------

# Character cap for contents/diffs shown back to the model in a
# confirmation preview, so a huge file doesn't blow up the context
# window before anything has even been written.
PREVIEW_CHAR_LIMIT = 2000


def create_file(path: str, contents: str = "", confirm: bool = False) -> dict:
    """Create a new file with the given contents. Requires confirmation.

    Fails if the file already exists, to avoid accidentally clobbering
    something — use write_file to modify an existing file.

    The first call (confirm=False, the default) does NOT create
    anything — it returns a preview of what would be created. Only
    pass confirm=True after the user has explicitly agreed to it.

    Args:
        path: Relative path for the new file.
        contents: Text contents to write.
        confirm: Must be True to actually create the file.

    Returns:
        A dictionary confirming the creation, or asking for confirmation.
    """

    try:
        file_path = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if is_sensitive_path(file_path):
        return {"error": f"Refusing to create sensitive file: {path}"}

    if file_path.exists():
        return {
            "error": (
                f"File already exists: {path}. Use write_file to "
                f"modify it."
            )
        }

    if not confirm:
        preview = contents[:PREVIEW_CHAR_LIMIT]
        truncated = len(contents) > PREVIEW_CHAR_LIMIT

        return {
            "requires_confirmation": True,
            "path": str(file_path.relative_to(PROJECT_ROOT)),
            "preview": preview,
            "preview_truncated": truncated,
            "message": (
                f"'{path}' was NOT created. Show the user the preview "
                f"and ask them to explicitly confirm creating this "
                f"file, then call create_file again with confirm=true."
            ),
        }

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(contents, encoding="utf-8")
    except Exception as exc:
        return {"error": f"Could not create file: {exc}"}

    return {
        "path": str(file_path.relative_to(PROJECT_ROOT)),
        "created": True,
        "bytes_written": len(contents.encode("utf-8")),
    }


def write_file(path: str, contents: str, confirm: bool = False) -> dict:
    """Overwrite a file with new contents. Requires confirmation.

    Creates the file if it doesn't exist. Read the file first (with
    read_file) so unrelated user changes elsewhere in the file aren't
    silently discarded, and change only what's necessary — prefer
    apply_patch for a small, targeted change to an existing file.

    The first call (confirm=False, the default) does NOT write
    anything — it returns a diff preview of the change. Only pass
    confirm=True after the user has explicitly agreed to it.

    Args:
        path: Relative path to the file.
        contents: The complete new contents of the file.
        confirm: Must be True to actually write the file.

    Returns:
        A dictionary confirming the write, or asking for confirmation.
    """

    try:
        file_path = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if is_sensitive_path(file_path):
        return {"error": f"Refusing to write to sensitive file: {path}"}

    if file_path.exists() and file_path.is_dir():
        return {"error": f"Cannot write to a directory: {path}"}

    existed = file_path.exists()

    if not confirm:
        old_text = ""

        if existed:
            try:
                old_text = file_path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                old_text = None

        diff_preview = None

        if old_text is not None:
            diff_lines = difflib.unified_diff(
                old_text.splitlines(keepends=True),
                contents.splitlines(keepends=True),
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
            )
            diff_preview = "".join(diff_lines)[:PREVIEW_CHAR_LIMIT]

        return {
            "requires_confirmation": True,
            "path": str(file_path.relative_to(PROJECT_ROOT)),
            "action": "overwrite" if existed else "create",
            "diff": diff_preview,
            "message": (
                f"'{path}' was NOT written. Show the user the diff "
                f"and ask them to explicitly confirm this change, "
                f"then call write_file again with confirm=true."
            ),
        }

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(contents, encoding="utf-8")
    except Exception as exc:
        return {"error": f"Could not write file: {exc}"}

    return {
        "path": str(file_path.relative_to(PROJECT_ROOT)),
        "overwritten": existed,
        "bytes_written": len(contents.encode("utf-8")),
    }


def delete_file(path: str, confirm: bool = False) -> dict:
    """Delete a single file inside the project. Requires confirmation.

    The first call (confirm=False, the default) never deletes anything —
    it only reports what would be deleted. Only pass confirm=True after
    the user has explicitly agreed to the deletion in the conversation.

    Args:
        path: Relative path to the file to delete.
        confirm: Must be True to actually perform the deletion.

    Returns:
        A dictionary confirming the deletion, or asking for confirmation.
    """

    try:
        file_path = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if is_sensitive_path(file_path):
        return {"error": f"Refusing to delete sensitive file: {path}"}

    if file_path == PROJECT_ROOT:
        return {"error": "Refusing to delete the project root."}

    if not file_path.exists():
        return {"error": f"File does not exist: {path}"}

    if file_path.is_dir():
        return {
            "error": (
                "delete_file can only delete a single file, not a "
                "directory."
            )
        }

    if not confirm:
        return {
            "requires_confirmation": True,
            "path": str(file_path.relative_to(PROJECT_ROOT)),
            "message": (
                f"'{path}' was NOT deleted. Ask the user to explicitly "
                f"confirm this deletion in the chat, then call "
                f"delete_file again with confirm=true."
            ),
        }

    try:
        file_path.unlink()
    except Exception as exc:
        return {"error": f"Could not delete file: {exc}"}

    return {
        "path": str(file_path.relative_to(PROJECT_ROOT)),
        "deleted": True,
    }


def _extract_patch_target_paths(patch_text: str) -> set:
    """Pull the file path(s) a unified diff would touch out of its headers.

    Reads '--- a/<path>' and '+++ b/<path>' style header lines (also
    tolerating headers without the 'a/'/'b/' prefix). '/dev/null'
    (used for pure adds/deletes) is ignored.
    """

    paths = set()

    for line in patch_text.splitlines():
        for prefix in ("+++ b/", "--- a/", "+++ ", "--- "):
            if line.startswith(prefix):
                candidate = line[len(prefix):].split("\t")[0].strip()
                if candidate and candidate != "/dev/null":
                    paths.add(candidate)
                break

    return paths


def apply_patch(patch: str, confirm: bool = False) -> dict:
    """Apply a small, targeted unified diff to one or more project files.

    Prefer this over write_file when only part of a file needs to
    change — it avoids resending/rewriting the whole file and makes
    the change easy to review. The patch must be in standard unified
    diff format, e.g. what `git diff` produces:

        --- a/server-python/app.py
        +++ b/server-python/app.py
        @@ -10,3 +10,3 @@
         unchanged line
        -old line
        +new line
         unchanged line

    Requires confirmation. The first call (confirm=False, the
    default) only validates that the patch applies cleanly (via
    `git apply --check`) and reports which files would change — it
    does not modify anything. Call again with confirm=true, after the
    user has agreed to the change, to actually apply it.

    Args:
        patch: The unified diff text.
        confirm: Must be True to actually apply the patch.

    Returns:
        A dictionary describing whether the patch applied, or asking
        for confirmation.
    """

    if not patch or not patch.strip():
        return {"error": "No patch text was provided."}

    max_patch_size = 200_000

    if len(patch) > max_patch_size:
        return {
            "error": (
                f"Patch is too large ({len(patch)} chars). Maximum "
                f"is {max_patch_size} chars — split it into smaller, "
                f"more targeted patches."
            )
        }

    if not (PROJECT_ROOT / ".git").exists():
        # PROJECT_ROOT can be a subdirectory of the actual repo root
        # (git discovers .git by walking upward from cwd, same as
        # git_status/git_diff/git_log/git_branch above), so this is
        # only a quick heuristic to fail fast for a *fully* untracked
        # project — the real check is `git apply --check` below.
        try:
            top_level = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except FileNotFoundError:
            return {"error": "git is not installed or not on PATH."}
        except subprocess.TimeoutExpired:
            return {"error": "Checking for a git repository timed out."}
        except Exception as exc:
            return {"error": f"Could not check for a git repository: {exc}"}

        if top_level.returncode != 0:
            return {
                "error": (
                    "apply_patch requires the project to be inside "
                    "a git repository (no .git found in "
                    "PROJECT_ROOT or any parent directory)."
                )
            }

    target_paths = _extract_patch_target_paths(patch)

    if not target_paths:
        return {
            "error": (
                "Could not find any '--- a/<path>' / '+++ b/<path>' "
                "headers in the patch. Provide a standard unified diff."
            )
        }

    resolved_paths = []

    for relative_path in target_paths:
        try:
            file_path = safe_path(relative_path)
        except ValueError as exc:
            return {
                "error": (
                    f"Patch touches an invalid path "
                    f"'{relative_path}': {exc}"
                )
            }

        if is_sensitive_path(file_path):
            return {
                "error": (
                    f"Refusing to patch sensitive file: {relative_path}"
                )
            }

        resolved_paths.append(str(file_path.relative_to(PROJECT_ROOT)))

    try:
        check = subprocess.run(
            ["git", "apply", "--check", "-"],
            input=patch,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "Validating the patch timed out."}
    except Exception as exc:
        return {"error": f"Could not validate patch: {exc}"}

    if check.returncode != 0:
        return {
            "error": (
                f"Patch does not apply cleanly: "
                f"{check.stderr.strip() or check.stdout.strip()}"
            )
        }

    if not confirm:
        return {
            "requires_confirmation": True,
            "files": resolved_paths,
            "message": (
                f"This patch was NOT applied. It would modify: "
                f"{', '.join(resolved_paths)}. Show the user the "
                f"patch and ask them to explicitly confirm it, then "
                f"call apply_patch again with confirm=true."
            ),
        }

    try:
        applied = subprocess.run(
            ["git", "apply", "-"],
            input=patch,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {"error": "Applying the patch timed out."}
    except Exception as exc:
        return {"error": f"Could not apply patch: {exc}"}

    if applied.returncode != 0:
        return {
            "error": (
                f"Failed to apply patch: "
                f"{applied.stderr.strip() or applied.stdout.strip()}"
            )
        }

    return {"files": resolved_paths, "applied": True}


# ---------------------------------------------------------
# Tool registry
# ---------------------------------------------------------

TOOL_FUNCTIONS = {
    "list_files": list_files,
    "read_file": read_file,
    "search_files": search_files,
    "run_command": run_command,
    "git_status": git_status,
    "git_diff": git_diff,
    "git_log": git_log,
    "git_branch": git_branch,
    "create_file": create_file,
    "write_file": write_file,
    "apply_patch": apply_patch,
    "delete_file": delete_file,
}

# Tools that only read or inspect the project. Kept separate from the
# write/destructive tools below purely for clarity when reasoning about
# the system's blast radius.
READ_ONLY_TOOL_NAMES = {
    "list_files",
    "read_file",
    "search_files",
    "run_command",
    "git_status",
    "git_diff",
    "git_log",
    "git_branch",
}

# Tools that create, modify, or delete files. All of these require
# confirm=True on a second call before they take effect (see each
# tool's docstring) — the first call only previews the change.
WRITE_TOOL_NAMES = {
    "create_file",
    "write_file",
    "apply_patch",
    "delete_file",
}

# Per-tool execution timeouts (seconds), enforced generically in
# run_agent_loop so a single slow tool can't stall the whole agent.
# Read-only inspection tools get short budgets; run_command and
# apply_patch get more room since they may shell out to real
# subprocesses (run_command already enforces its own internal timeout
# too, set slightly below this ceiling so its own clean timeout
# message fires first).
TOOL_TIMEOUTS = {
    "list_files": 5,
    "read_file": 5,
    "search_files": 15,
    "run_command": 65,
    "git_status": 10,
    "git_diff": 10,
    "git_log": 10,
    "git_branch": 10,
    "create_file": 5,
    "write_file": 5,
    "apply_patch": 35,
    "delete_file": 5,
}
DEFAULT_TOOL_TIMEOUT = 15

# Shared executor used to run each tool call so it can be bounded by
# TOOL_TIMEOUTS without blocking the whole process. Python threads
# can't be forcibly killed, so a timed-out tool's thread may keep
# running in the background even after the agent moves on and reports
# the timeout — this bounds how long the *agent* waits, not how long
# the underlying work actually takes.
TOOL_EXECUTOR = ThreadPoolExecutor(max_workers=8)


# ---------------------------------------------------------
# Gemini function declarations
# ---------------------------------------------------------

list_files_declaration = types.FunctionDeclaration(
    name="list_files",
    description=(
        "Lists files and directories inside the local project. "
        "Use this when the user asks what files exist or asks "
        "you to inspect a local directory."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": (
                    "Relative directory path. "
                    "Use '.' for the project root."
                ),
            }
        },
        "required": [],
    },
)


read_file_declaration = types.FunctionDeclaration(
    name="read_file",
    description=(
        "Reads the contents of a UTF-8 text file inside the local "
        "project. Use this when the user asks you to inspect a "
        "specific local file."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": (
                    "Relative path to the file inside the project."
                ),
            }
        },
        "required": ["path"],
    },
)


search_files_declaration = types.FunctionDeclaration(
    name="search_files",
    description=(
        "Searches text files inside the local project for a query "
        "string (case-insensitive) and returns the matching file "
        "paths and line numbers. Use this to find where something "
        "is defined or used before deciding which file to read."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "query": {
                "type": "STRING",
                "description": "The text to search for.",
            },
            "path": {
                "type": "STRING",
                "description": (
                    "Relative directory to search under. "
                    "Use '.' for the whole project."
                ),
            },
        },
        "required": ["query"],
    },
)


run_command_declaration = types.FunctionDeclaration(
    name="run_command",
    description=(
        "Runs one of the explicitly allowed development commands "
        "inside the local project directory: read-only git "
        "inspection (status, log, diff, branch), directory listings, "
        "tool versions, installing dependencies, and running "
        "tests/builds/linters. Use this when the user asks you to "
        "run the tests, install dependencies, build the project, or "
        "check something the dedicated tools don't cover. It cannot "
        "run destructive, system-level, or credential-exposing "
        "commands."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "command": {
                "type": "STRING",
                "description": (
                    "An allowed command such as 'pytest', "
                    "'npm test', 'npm install', 'git log -n 5', "
                    "or 'npm run build'."
                ),
            }
        },
        "required": ["command"],
    },
)


git_status_declaration = types.FunctionDeclaration(
    name="git_status",
    description=(
        "Shows the current git status (branch and changed files) "
        "of the project. Always call this instead of guessing or "
        "assuming the repository state."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {},
        "required": [],
    },
)


git_diff_declaration = types.FunctionDeclaration(
    name="git_diff",
    description=(
        "Shows the current git diff for the project, or for a "
        "single file. Use this to see exactly what has changed "
        "before or after making edits."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": (
                    "Optional relative path to scope the diff to "
                    "a single file. Leave empty for the whole "
                    "project."
                ),
            },
            "staged": {
                "type": "BOOLEAN",
                "description": (
                    "If true, show staged changes instead of "
                    "unstaged changes."
                ),
            },
        },
        "required": [],
    },
)


git_log_declaration = types.FunctionDeclaration(
    name="git_log",
    description=(
        "Shows recent commit history for the project (one line per "
        "commit). Use this to understand recent changes instead of "
        "guessing."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "max_count": {
                "type": "INTEGER",
                "description": (
                    "Number of commits to show (1-100). Defaults to 10."
                ),
            },
        },
        "required": [],
    },
)


git_branch_declaration = types.FunctionDeclaration(
    name="git_branch",
    description=(
        "Lists local git branches and shows which one is currently "
        "checked out."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {},
        "required": [],
    },
)


create_file_declaration = types.FunctionDeclaration(
    name="create_file",
    description=(
        "Creates a new file with the given contents inside the "
        "local project. Fails if the file already exists — use "
        "write_file to modify an existing file instead. Requires "
        "confirmation: calling without confirm=true will NOT create "
        "anything, it only returns a preview. Only call it again "
        "with confirm=true after the user has explicitly agreed."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": "Relative path for the new file.",
            },
            "contents": {
                "type": "STRING",
                "description": "Text contents to write to the file.",
            },
            "confirm": {
                "type": "BOOLEAN",
                "description": (
                    "Must be true to actually create the file. "
                    "Defaults to false."
                ),
            },
        },
        "required": ["path", "contents"],
    },
)


write_file_declaration = types.FunctionDeclaration(
    name="write_file",
    description=(
        "Overwrites an existing file (or creates it if missing) "
        "with new contents inside the local project. Read the file "
        "first with read_file so you don't discard unrelated user "
        "changes, and prefer apply_patch for a small, targeted "
        "change instead of rewriting the whole file. Requires "
        "confirmation: calling without confirm=true will NOT write "
        "anything, it only returns a diff preview. Only call it "
        "again with confirm=true after the user has explicitly "
        "agreed."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": "Relative path to the file.",
            },
            "contents": {
                "type": "STRING",
                "description": "The complete new contents of the file.",
            },
            "confirm": {
                "type": "BOOLEAN",
                "description": (
                    "Must be true to actually write the file. "
                    "Defaults to false."
                ),
            },
        },
        "required": ["path", "contents"],
    },
)


apply_patch_declaration = types.FunctionDeclaration(
    name="apply_patch",
    description=(
        "Applies a small, targeted unified diff (like `git diff` "
        "output) to one or more project files. This is the "
        "preferred way to make a focused change to an existing "
        "file instead of rewriting it entirely with write_file. "
        "Requires confirmation: calling without confirm=true will "
        "NOT apply anything, it only validates the patch and "
        "reports which files would change. Only call it again with "
        "confirm=true after the user has explicitly agreed."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "patch": {
                "type": "STRING",
                "description": (
                    "The unified diff text, including "
                    "'--- a/<path>' / '+++ b/<path>' headers and "
                    "'@@ ... @@' hunks."
                ),
            },
            "confirm": {
                "type": "BOOLEAN",
                "description": (
                    "Must be true to actually apply the patch. "
                    "Defaults to false."
                ),
            },
        },
        "required": ["patch"],
    },
)


delete_file_declaration = types.FunctionDeclaration(
    name="delete_file",
    description=(
        "Deletes a single file inside the local project. This is "
        "destructive. Calling it without confirm=true will NOT "
        "delete anything — it only returns what would be deleted. "
        "Only call it again with confirm=true after the user has "
        "explicitly agreed to the deletion in the conversation."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "path": {
                "type": "STRING",
                "description": "Relative path to the file to delete.",
            },
            "confirm": {
                "type": "BOOLEAN",
                "description": (
                    "Must be true to actually perform the deletion. "
                    "Defaults to false."
                ),
            },
        },
        "required": ["path"],
    },
)


TOOLS = [
    types.Tool(
        function_declarations=[
            list_files_declaration,
            read_file_declaration,
            search_files_declaration,
            run_command_declaration,
            git_status_declaration,
            git_diff_declaration,
            git_log_declaration,
            git_branch_declaration,
            create_file_declaration,
            write_file_declaration,
            apply_patch_declaration,
            delete_file_declaration,
        ]
    )
]


# ---------------------------------------------------------
# Gemini configuration
# ---------------------------------------------------------

GENERATE_CONFIG = types.GenerateContentConfig(
    tools=TOOLS,
    automatic_function_calling=types.AutomaticFunctionCallingConfig(
        disable=True
    ),
    system_instruction=(
        "You are a local coding/project agent operating on a single "
        "project directory (PROJECT_ROOT), similar in behavior to "
        "Gemini CLI. You act through explicit tools; you do not have "
        "any other way to see or change this project.\n"
        "\n"
        "Inspecting the project:\n"
        "- Inspect the project with your tools before making "
        "assumptions about its contents or structure.\n"
        "- Prefer reading relevant files yourself over asking the "
        "user to paste code.\n"
        "- Use search_files to locate where something is defined or "
        "used before reading whole files.\n"
        "- Use git_status, git_diff, git_log, and git_branch whenever "
        "the user asks about, or your work depends on, the state of "
        "the repository. Never guess or hallucinate repository "
        "state, commit history, or the current branch.\n"
        "\n"
        "Making changes:\n"
        "- Before modifying an important file: read it and decide "
        "the minimal necessary change.\n"
        "- Prefer apply_patch for a small, targeted change to an "
        "existing file. Only use write_file for a genuinely new "
        "file's full contents or a near-total rewrite, and only "
        "after reading the current contents first so you don't "
        "silently discard unrelated parts of the file.\n"
        "- create_file, write_file, apply_patch, and delete_file all "
        "require confirmation: your first call (confirm not set, or "
        "false) never changes anything — it only returns a preview "
        "(contents, diff, or affected files). Show that preview to "
        "the user in your reply, wait for them to explicitly agree "
        "in the conversation, and only then call the same tool "
        "again with confirm=true. Never set confirm=true on the "
        "first attempt, and never claim a file was created, "
        "written, patched, or deleted unless the tool result "
        "actually confirms it happened.\n"
        "- Never run 'git commit' or 'git push', and do not commit "
        "or push changes, unless the user explicitly asks you to in "
        "this conversation.\n"
        "\n"
        "Verifying changes — this is not optional:\n"
        "- After a create_file/write_file/apply_patch call actually "
        "succeeds (not just the preview step), verify the result: "
        "read the file back, or use git_diff, to confirm the change "
        "looks right.\n"
        "- When practical, run an appropriate test, build, or lint/"
        "syntax check with run_command after the change and inspect "
        "the real output.\n"
        "- If verification fails (the test fails, the build breaks, "
        "the file doesn't look right), say so, investigate why, and "
        "attempt a correction if it's reasonable to do so — don't "
        "stop at the first failed attempt without at least "
        "explaining what went wrong.\n"
        "- Never claim a change was successfully made unless the "
        "corresponding tool call actually succeeded. Never claim a "
        "test or command passed unless you actually ran it with a "
        "tool and it returned a passing result. Never claim you ran "
        "a command, read a file, or checked git state unless the "
        "corresponding tool actually did so.\n"
        "\n"
        "Explaining yourself:\n"
        "- Explain what you are about to change before changing it, "
        "and summarize what you actually changed (and verified) "
        "afterward.\n"
        "- Report command output and tool results accurately, "
        "including failures.\n"
        "- Some files (like .env) are blocked from every tool and "
        "will never be shown to you; if a tool refuses for that "
        "reason, tell the user instead of retrying.\n"
        "- If a tool call fails or is rejected (including a blocked "
        "repeated call), report the actual error to the user rather "
        "than guessing what might have happened or silently retrying "
        "the same thing."
    ),
)


# ---------------------------------------------------------
# Build conversation contents
# ---------------------------------------------------------

def build_contents(msg, history):
    """Convert frontend conversation history into Gemini contents."""

    contents = []

    for item in history:
        role = item.get("role")
        parts = item.get("parts", [])

        if role and parts:
            converted_parts = []

            for part in parts:
                if isinstance(part, dict) and "text" in part:
                    converted_parts.append(
                        types.Part.from_text(
                            text=part["text"]
                        )
                    )
                else:
                    converted_parts.append(part)

            contents.append(
                types.Content(
                    role=role,
                    parts=converted_parts,
                )
            )

    contents.append(
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    text=msg
                )
            ],
        )
    )

    return contents


# ---------------------------------------------------------
# Explicit Gemini tool-calling loop
# ---------------------------------------------------------

MAX_TOOL_ROUNDS = 10

# A model that's stuck tends to call the exact same tool with the
# exact same arguments over and over with nothing else happening in
# between. We only flag *consecutive* identical calls (interleaving a
# different call, e.g. checking git_status between several edits,
# resets the counter) so legitimate repeated inspection isn't blocked.
MAX_CONSECUTIVE_IDENTICAL_CALLS = 3
HARD_ABORT_CONSECUTIVE_CALLS = 6


def run_agent_loop(contents):
    """Run Gemini and explicitly execute requested tools.

    This is a generator so both /chat and /stream can share one
    implementation of the loop:

        Gemini
          |
          v
        function call?  --no--> yield final text, done
          | yes
          v
        Python executes the tool, bounded by a per-tool timeout
        (yielding tool_call/tool_result events as it goes)
          |
          v
        tool result sent back to Gemini
          |
          v
        repeat, up to MAX_TOOL_ROUNDS

    The same (name, arguments) call repeated several times *in a row*
    is treated as a stuck loop: after MAX_CONSECUTIVE_IDENTICAL_CALLS
    it's refused with an explanation instead of being executed again,
    and after HARD_ABORT_CONSECUTIVE_CALLS the whole loop is aborted.

    Yields dicts of one of these shapes:
        {"type": "tool_call", "name": str, "args": dict}
        {"type": "tool_result", "name": str, "result": dict}
        {"type": "final", "text": str}
        {"type": "error", "message": str}
    A generator stops after yielding "final" or "error".
    """

    last_call_signature = None
    consecutive_repeat_count = 0

    for _ in range(MAX_TOOL_ROUNDS):

        try:
            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=contents,
                config=GENERATE_CONFIG,
            )
        except Exception as exc:
            yield {
                "type": "error",
                "message": f"Gemini API error: {exc}",
            }
            return

        if not response.candidates:
            yield {
                "type": "error",
                "message": "Gemini returned no response candidates.",
            }
            return

        model_content = response.candidates[0].content

        if model_content is None or not model_content.parts:
            yield {
                "type": "error",
                "message": "Gemini returned an empty response.",
            }
            return

        function_calls = [
            part.function_call
            for part in model_content.parts
            if part.function_call
        ]

        # Gemini has produced its final answer: no more tool calls.
        if not function_calls:

            text = None

            try:
                text = response.text
            except Exception:
                text = None

            if not text:
                # Fall back to manually concatenating any text parts.
                text = "".join(
                    part.text
                    for part in model_content.parts
                    if getattr(part, "text", None)
                ) or None

            if not text:
                yield {
                    "type": "error",
                    "message": (
                        "Gemini returned no text and requested no "
                        "further tools."
                    ),
                }
                return

            yield {"type": "final", "text": text}
            return

        # Preserve Gemini's function-call message.
        contents.append(model_content)

        function_response_parts = []

        for function_call in function_calls:

            function_name = function_call.name
            function_args = dict(function_call.args or {})

            print(
                f"[Gemini tool call] "
                f"{function_name}({function_args})"
            )

            yield {
                "type": "tool_call",
                "name": function_name,
                "args": function_args,
            }

            # Track consecutive identical (name, args) calls to catch
            # a stuck loop. Any different call in between resets this.
            call_signature = (
                function_name,
                tuple(
                    sorted(
                        (key, repr(value))
                        for key, value in function_args.items()
                    )
                ),
            )

            if call_signature == last_call_signature:
                consecutive_repeat_count += 1
            else:
                last_call_signature = call_signature
                consecutive_repeat_count = 1

            function = TOOL_FUNCTIONS.get(function_name)

            if function is None:
                result = {
                    "error": (
                        f"Unknown tool requested: {function_name}"
                    )
                }

            elif consecutive_repeat_count > HARD_ABORT_CONSECUTIVE_CALLS:
                yield {
                    "type": "error",
                    "message": (
                        f"Stopping: {function_name} was called with "
                        f"the exact same arguments "
                        f"{consecutive_repeat_count} times in a row "
                        f"with nothing else happening in between. "
                        f"This looks like a stuck loop rather than "
                        f"progress."
                    ),
                }
                return

            elif consecutive_repeat_count > MAX_CONSECUTIVE_IDENTICAL_CALLS:
                result = {
                    "error": (
                        f"{function_name} has already been called "
                        f"with these exact arguments "
                        f"{consecutive_repeat_count - 1} time(s) in "
                        f"a row with no other action in between, so "
                        f"repeating it again won't provide new "
                        f"information. Try a different tool, "
                        f"different arguments, or give your final "
                        f"answer based on what you already know."
                    )
                }

            else:
                timeout_seconds = TOOL_TIMEOUTS.get(
                    function_name, DEFAULT_TOOL_TIMEOUT
                )
                future = TOOL_EXECUTOR.submit(function, **function_args)

                try:
                    result = future.result(timeout=timeout_seconds)

                except FutureTimeoutError:
                    result = {
                        "error": (
                            f"Tool {function_name} exceeded its "
                            f"{timeout_seconds}s execution limit and "
                            f"was abandoned."
                        )
                    }

                except TypeError as exc:
                    # Wrong/missing/extra arguments for the tool.
                    result = {
                        "error": (
                            f"Malformed arguments for "
                            f"{function_name}: {exc}"
                        )
                    }

                except Exception as exc:
                    result = {
                        "error": (
                            f"Tool {function_name} failed: {exc}"
                        )
                    }

            print(
                f"[Gemini tool result] "
                f"{function_name}: {result}"
            )

            yield {
                "type": "tool_result",
                "name": function_name,
                "result": result,
            }

            # IMPORTANT:
            # google-genai 2.17.0 does not accept id= here.
            function_response_parts.append(
                types.Part.from_function_response(
                    name=function_name,
                    response={
                        "result": result
                    },
                )
            )

        # Send the actual local tool results back to Gemini.
        contents.append(
            types.Content(
                role="user",
                parts=function_response_parts,
            )
        )

    yield {
        "type": "error",
        "message": (
            "Gemini exceeded the maximum number of tool-calling "
            "rounds without producing a final response."
        ),
    }


# ---------------------------------------------------------
# Chat endpoint
# ---------------------------------------------------------

@app.route("/chat", methods=["POST"])
def chat():
    """Process a chat request and run the tool-calling loop to completion."""

    data = request.get_json(silent=True) or {}

    msg = data.get("chat", "")
    history = data.get("history", [])

    if not msg or not str(msg).strip():
        return {"text": "", "error": "Message must not be empty."}, 400

    try:
        contents = build_contents(msg, history)
    except Exception as exc:
        return {
            "text": "",
            "error": f"Could not process conversation history: {exc}",
        }, 400

    tool_activity = []
    final_text = ""
    error_message = None

    try:
        for event in run_agent_loop(contents):
            if event["type"] == "tool_call":
                tool_activity.append(
                    {
                        "type": "tool_call",
                        "name": event["name"],
                        "args": event["args"],
                    }
                )
            elif event["type"] == "tool_result":
                tool_activity.append(
                    {
                        "type": "tool_result",
                        "name": event["name"],
                        "result": event["result"],
                    }
                )
            elif event["type"] == "final":
                final_text = event["text"]
            elif event["type"] == "error":
                error_message = event["message"]
    except Exception as exc:
        error_message = f"Unexpected server error: {exc}"

    if error_message and not final_text:
        return {
            "text": "",
            "error": error_message,
            "tool_activity": tool_activity,
        }, 502

    return {
        "text": final_text,
        "tool_activity": tool_activity,
    }


# ---------------------------------------------------------
# Streaming endpoint
# ---------------------------------------------------------

@app.route("/stream", methods=["POST"])
def stream():
    """Stream the tool-calling loop's activity and final response.

    The existing React client reads this endpoint as plain text and
    appends every chunk directly to the message it is displaying, so
    this keeps emitting plain text (no JSON envelope) to stay
    compatible with it. Tool-call and tool-error activity is streamed
    first as short, human-readable status lines, followed by Gemini's
    final answer text.
    """

    def format_args(args):
        return ", ".join(f"{k}={v!r}" for k, v in args.items())

    def generate():

        data = request.get_json(silent=True) or {}

        msg = data.get("chat", "")
        history = data.get("history", [])

        if not msg or not str(msg).strip():
            yield "Please enter a message."
            return

        try:
            contents = build_contents(msg, history)
        except Exception as exc:
            yield f"[Error building request: {exc}]"
            return

        try:
            for event in run_agent_loop(contents):

                if event["type"] == "tool_call":
                    yield (
                        f"\n\u2699\ufe0f {event['name']}"
                        f"({format_args(event['args'])})\n"
                    )

                elif event["type"] == "tool_result":
                    result = event["result"]
                    if isinstance(result, dict) and result.get("error"):
                        yield f"\u26a0\ufe0f {event['name']}: {result['error']}\n"

                elif event["type"] == "final":
                    yield event["text"]

                elif event["type"] == "error":
                    yield f"\n[Error: {event['message']}]"

        except Exception as exc:
            # Never let an uncaught exception surface as a bare
            # connection drop / Flask 500 mid-stream.
            yield f"\n[Error: {exc}]"

    return Response(
        stream_with_context(generate()),
        mimetype="text/plain",
    )


# ---------------------------------------------------------
# Run Flask
# ---------------------------------------------------------

if __name__ == "__main__":

    port = int(
        os.getenv("PORT", "9000")
    )

    app.run(
        host="127.0.0.1",
        port=port,
    )