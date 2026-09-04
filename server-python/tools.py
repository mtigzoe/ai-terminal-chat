"""Filesystem, git, and shell tools available to any provider.

Every function below is plain Python with no AI-provider dependency —
this is what app.py meant when TOOLS/TOOL_FUNCTIONS lived next to a
single Gemini client. TOOL_SCHEMAS at the bottom describes each tool's
name/description/parameters as standard (lowercase) JSON Schema, which
providers/gemini.py and providers/openai_compatible.py each adapt to
their own wire format — the schema itself doesn't change per provider,
only its casing/wrapping does.
"""

import difflib
import os
import re
import shlex
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from security import (
    PROJECT_ROOT,
    get_allowed_read_paths,
    is_read_allowed,
    is_sensitive_filename,
    is_sensitive_path,
    require_read_allowed,
    safe_path,
)

# ---------------------------------------------------------
# Filesystem tools
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
    allowed = get_allowed_read_paths()
    dir_rel = directory.relative_to(PROJECT_ROOT).as_posix()

    for item in sorted(
        directory.iterdir(),
        key=lambda p: p.name.lower()
    ):
        if allowed is not None:
            item_rel = (
                f"{dir_rel}/{item.name}" if dir_rel not in (".", "") else item.name
            )
            if item.is_dir():
                prefix = item_rel.rstrip("/") + "/"
                if not any(a == item_rel or a.startswith(prefix) for a in allowed):
                    continue
            else:
                if item_rel not in allowed:
                    continue
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

    try:
        require_read_allowed(file_path)
    except ValueError as exc:
        return {"error": str(exc)}

    # Prevent accidentally sending extremely large files to the model.
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
            if not is_read_allowed(file_path):
                continue

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
# Terminal tool
# ---------------------------------------------------------

# Commands are allowlisted by prefix so arguments (a specific file, a
# test name, etc.) are still permitted, e.g. "pytest -k test_login" is
# allowed because it starts with the "pytest" prefix. Read-only
# inspection, dependency install, and test/build commands are included;
# nothing here can commit, push, rewrite history, or delete anything —
# writes to files go through create_file/write_file, and deletion goes
# through delete_file, both of which have their own guardrails.
#
# This is the single authoritative allowlist used by run_command() and
# is_command_allowed(). The Settings UI and /allowed-commands API read
# and mutate this same list; user changes are persisted in the existing
# ~/.ai-terminal-chat/config.json configuration file.
DEFAULT_ALLOWED_COMMAND_PREFIXES = (
    "git status",
    "git branch",
    "git log",
    "git diff",
    "git show",
    "git remote -v",
    "pwd",
    "dir",
    "ls",
    "wsl",
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
    "uv --version",
    "uv run",
)

# Runtime allowlist. Starts as the defaults and is updated from the
# persisted configuration (and via the Settings UI / API). Always keep
# this as a list so mutations are visible to is_command_allowed().
ALLOWED_COMMAND_PREFIXES: list[str] = list(DEFAULT_ALLOWED_COMMAND_PREFIXES)

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

# Prefixes that must never be added through the Settings UI / API, even
# if a user attempts to do so. Defense in depth against elevating the
# allowlist to dangerous commands.
FORBIDDEN_ALLOWED_COMMAND_PREFIXES = (
    "rm",
    "del",
    "rmdir",
    "Remove-Item",
    "sudo",
    "shutdown",
    "reboot",
    "format",
    "diskpart",
    "git reset",
    "git clean",
    "git push",
    "git commit",
    "git pull",
    "git add",
)


def _normalize_command_prefix(prefix: str) -> str:
    """Return a stripped command prefix suitable for the allowlist."""

    return (prefix or "").strip()


def _is_forbidden_prefix(prefix: str) -> bool:
    """True if the prefix is explicitly blocked from the allowlist."""

    normalized = _normalize_command_prefix(prefix).lower()
    if not normalized:
        return True
    # Reject exact matches and prefixes that would expand to a forbidden
    # command. Both directions must be checked so that a broad prefix such
    # as "git" is rejected (it would permit "git push", "git reset", etc.)
    # while a safe prefix such as "git status" is still accepted.
    for forbidden in FORBIDDEN_ALLOWED_COMMAND_PREFIXES:
        forbidden_lower = forbidden.lower()
        if (
            normalized == forbidden_lower
            or normalized.startswith(forbidden_lower + " ")
            or forbidden_lower.startswith(normalized + " ")
        ):
            return True
    # Also reject anything containing dangerous shell characters.
    for char in DANGEROUS_COMMAND_CHARACTERS:
        if char in normalized:
            return True
    return False


def _load_allowed_commands_from_config() -> list[str] | None:
    """Load a persisted allowed-commands list, or None if not configured."""

    from security import _load_config

    data = _load_config()
    raw = data.get("allowed_commands")
    if not isinstance(raw, list):
        return None
    prefixes: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        normalized = _normalize_command_prefix(item)
        if normalized and not _is_forbidden_prefix(normalized):
            prefixes.append(normalized)
    return prefixes if prefixes else None


def _persist_allowed_commands(prefixes: list[str]) -> None:
    """Write the current allowlist into the existing configuration file."""

    from security import _load_config, _persist_config

    payload = _load_config()
    payload["allowed_commands"] = list(prefixes)
    _persist_config(payload)


def reload_allowed_commands() -> list[str]:
    """Reload ALLOWED_COMMAND_PREFIXES from configuration (or defaults).

    Returns the active list. Safe to call at startup and after API updates.
    """

    global ALLOWED_COMMAND_PREFIXES
    loaded = _load_allowed_commands_from_config()
    if loaded is not None:
        ALLOWED_COMMAND_PREFIXES = loaded
    else:
        ALLOWED_COMMAND_PREFIXES = list(DEFAULT_ALLOWED_COMMAND_PREFIXES)
    return list(ALLOWED_COMMAND_PREFIXES)


def get_allowed_commands() -> list[str]:
    """Return a sorted copy of the active allowed command prefixes."""

    return sorted(ALLOWED_COMMAND_PREFIXES)


def add_allowed_command(prefix: str) -> list[str]:
    """Add a command prefix to the allowlist and persist it.

    Raises ValueError for empty, forbidden, or dangerous prefixes.
    """

    normalized = _normalize_command_prefix(prefix)
    if not normalized:
        raise ValueError("A non-empty command prefix is required.")
    if _is_forbidden_prefix(normalized):
        raise ValueError(
            f"Command prefix '{normalized}' is not permitted for safety reasons."
        )
    if normalized not in ALLOWED_COMMAND_PREFIXES:
        ALLOWED_COMMAND_PREFIXES.append(normalized)
        _persist_allowed_commands(ALLOWED_COMMAND_PREFIXES)
    return get_allowed_commands()


def remove_allowed_command(prefix: str) -> list[str]:
    """Remove a command prefix from the allowlist and persist it.

    Raises ValueError if the prefix is not present.
    """

    normalized = _normalize_command_prefix(prefix)
    if not normalized:
        raise ValueError("A non-empty command prefix is required.")
    if normalized not in ALLOWED_COMMAND_PREFIXES:
        raise ValueError(f"Command prefix '{normalized}' is not in the allowlist.")
    ALLOWED_COMMAND_PREFIXES.remove(normalized)
    _persist_allowed_commands(ALLOWED_COMMAND_PREFIXES)
    return get_allowed_commands()


# Load any user-configured allowlist at import time.
reload_allowed_commands()

# Commands that can print arbitrary file contents. When an allowed-read set is
# active these must not be used to bypass read_file permission checks.
_FILE_CONTENT_COMMAND_PREFIXES = (
    "cat",
    "type",
    "Get-Content",
    "gc",
    "head",
    "tail",
    "less",
    "more",
    "bat",
    "nl",
    # Git content dumpers — can expose unselected file bodies
    "git show",
    "git diff",
)


def _command_reads_file_contents(command: str) -> bool:
    """True if the command is a known file-content printer."""

    cmd = command.strip()
    for prefix in _FILE_CONTENT_COMMAND_PREFIXES:
        if cmd == prefix or cmd.startswith(prefix + " "):
            return True
        if cmd.lower().startswith(prefix.lower() + " "):
            return True
    return False


def _run_command_respects_read_permissions(command: str) -> dict | None:
    """If a restriction is active, refuse shell commands that dump file contents.

    Returns an error dict when the command must be blocked, else None.
    When the command targets only paths in the allowed set, it is permitted.
    """

    allowed = get_allowed_read_paths()
    if allowed is None:
        return None

    if not _command_reads_file_contents(command):
        return None

    # Try to allow if every path argument is in the selected set.
    try:
        args = shlex.split(command, posix=False)
    except ValueError:
        args = command.split()

    # Special handling for git show: allow --stat/--no-patch, and
    # properly extract paths from commit:path and -- path syntax.
    if len(args) >= 2 and args[0].lower() == "git" and args[1].lower() == "show":
        no_content_flags = {"--stat", "--no-patch", "--name-only", "--oneline", "--quiet"}
        has_no_content_flag = any(arg in no_content_flags for arg in args[2:])
        
        if has_no_content_flag:
            return None
        
        explicit_paths = []
        past_double_dash = False
        
        for i in range(2, len(args)):
            arg = args[i]
            if arg == "--":
                past_double_dash = True
                continue
            if past_double_dash:
                explicit_paths.append(arg)
            elif ":" in arg and not arg.startswith("-"):
                explicit_paths.append(arg.split(":", 1)[1])
        
        if not explicit_paths:
            return {
                "error": (
                    "Access denied: git show can expose file contents. "
                    "Use --stat, --no-patch, or specify an allowed file path."
                )
            }
        
        if all(is_read_allowed(p) for p in explicit_paths):
            return None
        
        return {
            "error": (
                "Access denied: git show can expose file contents and the "
                "requested file was not selected on the Project page."
            )
        }

    # Existing logic for other file-content commands.
    path_args = [a for a in args[1:] if a and not a.startswith("-")]
    if path_args and all(is_read_allowed(p) for p in path_args):
        return None

    paths_hint = ", ".join(path_args) if path_args else "the requested file"
    return {
        "error": (
            f"Access denied for {paths_hint}: this command can read arbitrary "
            "file contents and is blocked while an agent file-selection is "
            "active. Select the file on the Project page, or use the "
            "read_file tool on a selected file."
        )
    }




def is_command_allowed(command: str) -> bool:
    """True if the command matches one of the allowed dev-command prefixes.

    The command is normalized by tokenizing it before matching so that
    leading/trailing whitespace, repeated spaces, and tabs do not affect
    the result.
    """

    try:
        tokens = shlex.split(command, posix=False)
    except ValueError:
        tokens = command.split()
    normalized = " ".join(tokens)

    return any(
        normalized == prefix or normalized.startswith(prefix + " ")
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

    permission_error = _run_command_respects_read_permissions(command)
    if permission_error is not None:
        return permission_error

    try:
        args = shlex.split(command, posix=False)
        
        # `ls` is a PowerShell alias on Windows, not an executable.
        # Use the native cmd.exe directory command while preserving
        # `ls` as the cross-platform command exposed to the agent.
        if os.name == "nt" and args and args[0].lower() in {"ls", "dir"}:
            args = ["cmd", "/c", "dir", *args[1:]]

        result = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            shell=False,
            capture_output=True,
            text=True,
            timeout=60,
        )

        # Cap output so a noisy command can't blow up the context window.
        max_output = 20_000
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        stdout_truncated = len(stdout) > max_output
        stderr_truncated = len(stderr) > max_output
        truncated = stdout_truncated or stderr_truncated

        payload = {
            "command": command,
            "returncode": result.returncode,
            "stdout": stdout[:max_output],
            "stderr": stderr[:max_output],
            "truncated": truncated,
        }
        if truncated:
            payload["truncation_note"] = (
                f"Output was truncated to {max_output} characters per "
                f"stream so the model context is not overwhelmed."
            )
        return payload

    except subprocess.TimeoutExpired:
        return {
            "error": "Command timed out after 60 seconds."
        }

    except Exception as exc:
        return {
            "error": f"Could not execute command: {exc}"
        }


# ---------------------------------------------------------
# Git tools
# ---------------------------------------------------------

# Subprocess timeouts for Git inspection tools. Kept at or below the
# agent-level TOOL_TIMEOUTS entries so the tool returns a clear timeout
# error before the agent abandons the call. True process cancellation is
# intentionally not implemented in this milestone.
GIT_STATUS_TIMEOUT = 10
GIT_DIFF_TIMEOUT = 10
GIT_LOG_TIMEOUT = 10
GIT_BRANCH_TIMEOUT = 10

# Output caps so pathological repos cannot overwhelm model context.
GIT_STATUS_MAX_CHARS = 20_000
GIT_LOG_MAX_CHARS = 20_000
GIT_BRANCH_MAX_CHARS = 20_000
GIT_DIFF_MAX_CHARS = 50_000

GIT_FETCH_TIMEOUT = 15
GIT_PULL_TIMEOUT = 30
GIT_COMMIT_TIMEOUT = 15
GIT_PUSH_TIMEOUT = 30

GIT_FETCH_MAX_CHARS = 10_000
GIT_PULL_MAX_CHARS = 10_000
GIT_COMMIT_MAX_CHARS = 10_000
GIT_PUSH_MAX_CHARS = 10_000

# The full set of `git status --short` XY codes that represent an
# unresolved merge conflict (e.g. from `git merge` or `git rebase`).
# "AA" (both added) and "DD" (both deleted) don't contain the letter
# "M"/"A"/"D" in a way that's distinguishable from an ordinary staged
# add/delete, so they must be checked explicitly rather than inferred.
GIT_CONFLICT_STATUS_CODES = frozenset({"DD", "AU", "UD", "UA", "DU", "AA", "UU"})


def _git_status_raw() -> dict:
    """Run `git status --short --branch` and return raw text (or error)."""

    try:
        result = subprocess.run(
            ["git", "status", "--short", "--branch"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_STATUS_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git status timed out after {GIT_STATUS_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git status: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git status failed."}

    status_text = result.stdout or ""
    truncated = len(status_text) > GIT_STATUS_MAX_CHARS
    payload = {
        "status": status_text[:GIT_STATUS_MAX_CHARS],
        "truncated": truncated,
    }
    if truncated:
        payload["truncation_note"] = (
            f"Status output was truncated to {GIT_STATUS_MAX_CHARS} "
            f"characters."
        )
    return payload


def git_status() -> dict:
    """Show the current git status of the project in plain language.

    Equivalent to parsing `git status --short --branch` into a concise
    summary (clean/dirty, staged counts, ahead/behind) so the model and
    user do not have to decode Git's two-column status codes. Always use
    this instead of guessing what has changed in the repository.

    Returns:
        A dictionary with summary, details, and structured fields
        (clean, ahead, behind, staged, etc.), or an error.
    """

    raw = _git_status_raw()
    if "error" in raw:
        return raw

    status = str(raw.get("status") or "")
    lines = [line for line in status.splitlines() if line]
    branch_line = next((line for line in lines if line.startswith("## ")), "")

    branch = None
    if branch_line.startswith("## "):
        # "## main...origin/main [ahead 1]" or "## main"
        rest = branch_line[3:]
        if "..." in rest:
            branch = rest.split("...", 1)[0].strip() or None
        else:
            branch = rest.split()[0].strip() if rest.strip() else None

    has_remote = "..." in branch_line
    ahead = 0
    behind = 0
    tracking_start = branch_line.find("[")
    tracking_end = branch_line.find("]")
    if tracking_start != -1 and tracking_end > tracking_start:
        tracking = branch_line[tracking_start + 1 : tracking_end]
        if "ahead " in tracking:
            try:
                ahead = int(tracking.split("ahead ", 1)[1].split(",", 1)[0].split()[0])
            except (ValueError, IndexError):
                ahead = 0
        if "behind " in tracking:
            try:
                behind = int(tracking.split("behind ", 1)[1].split(",", 1)[0].split()[0])
            except (ValueError, IndexError):
                behind = 0

    changed = 0
    untracked = 0
    staged = 0
    conflicts = 0
    details: list[str] = []

    for line in lines:
        if line.startswith("## ") or len(line) < 3:
            continue
        x, y = line[0], line[1]
        code = line[0:2]
        file_path = line[3:].strip()

        if code == "??":
            untracked += 1
            details.append(f"{file_path} — new file, not tracked by Git")
            continue

        if code in GIT_CONFLICT_STATUS_CODES:
            # An unresolved merge conflict (e.g. from `git merge` or
            # `git rebase`). This must never be reported as an ordinary
            # staged change: "AA" and "DD" in particular contain no "M"/
            # "A"/"D" that uniquely identifies them as a conflict, so they
            # need to be checked before the modified/added/deleted branch
            # below, not folded into it.
            changed += 1
            conflicts += 1
            details.append(
                f"{file_path} — unresolved merge conflict, must be resolved "
                f"before this can be committed"
            )
            continue

        changed += 1
        if x != " ":
            staged += 1

        description = "changed"
        if x in ("A",) or y in ("A",):
            description = "added"
        elif x in ("D",) or y in ("D",):
            description = "deleted"
        elif x in ("R",) or y in ("R",):
            description = "renamed"
        elif x in ("M",) or y in ("M",):
            description = "modified"

        stage_note = ", staged" if x != " " else ", not staged"
        details.append(f"{file_path} — {description}{stage_note}")

    clean = changed == 0 and untracked == 0
    synchronized = has_remote and ahead == 0 and behind == 0
    total_changes = changed + untracked
    parts: list[str] = []

    if clean:
        parts.append("Your working tree is clean.")
    else:
        noun = "file" if total_changes == 1 else "files"
        parts.append(f"You have {total_changes} uncommitted {noun}.")

    if conflicts > 0:
        noun = "file" if conflicts == 1 else "files"
        verb = "has" if conflicts == 1 else "have"
        parts.append(
            f"{conflicts} {noun} {verb} an unresolved merge conflict and "
            f"must be resolved before you can commit."
        )

    if staged > 0:
        verb = "is" if staged == 1 else "are"
        noun = "file" if staged == 1 else "files"
        parts.append(f"{staged} {noun} {verb} staged for the next commit.")

    if ahead > 0 and behind > 0:
        parts.append(
            f"Your branch has {ahead} commit{'s' if ahead != 1 else ''} not "
            f"pushed and is {behind} commit{'s' if behind != 1 else ''} behind "
            f"the remote."
        )
    elif ahead > 0:
        parts.append(
            f"Your branch has {ahead} commit{'s' if ahead != 1 else ''} not "
            f"pushed to the remote."
        )
    elif behind > 0:
        parts.append(
            f"Your branch is {behind} commit{'s' if behind != 1 else ''} behind "
            f"the remote."
        )
    elif synchronized:
        parts.append("Your local branch is synchronized with its remote branch.")
    elif not has_remote and branch:
        parts.append(
            "This branch is not tracking a remote branch, so Git cannot tell "
            "whether it has been pushed."
        )

    return {
        "summary": " ".join(parts),
        "details": details,
        "branch": branch,
        "clean": clean,
        "ahead": ahead,
        "behind": behind,
        "changed": changed,
        "untracked": untracked,
        "staged": staged,
        "conflicts": conflicts,
        "hasRemote": has_remote,
        "synchronized": synchronized,
    }


def git_committed_file_count() -> dict:
    """Count files recorded in the current commit without changing state.

    Returns:
        A dictionary with committed_files count, or an error.
    """

    try:
        result = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "HEAD"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_STATUS_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git ls-tree timed out after {GIT_STATUS_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not count committed files: {exc}"}

    if result.returncode != 0:
        return {
            "error": (
                result.stderr.strip()
                or "Could not count files in the current commit. "
                "The repository may not have a commit yet."
            )
        }

    names = [line for line in (result.stdout or "").splitlines() if line.strip()]
    return {"committed_files": len(names)}


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

        try:
            require_read_allowed(file_path)
        except ValueError as exc:
            return {"error": str(exc)}

        args.append(str(file_path.relative_to(PROJECT_ROOT)))
    elif not staged and get_allowed_read_paths() is not None:
        # Project-page file selection restricts which files the model can
        # read (read_file, and an unscoped diff would let it see arbitrary
        # working-tree changes across the whole repo instead). Staged
        # changes are different: a file only ends up here after git_add
        # already asked for — and got — its own explicit user
        # confirmation, so showing that specific staged diff back
        # (including from git_commit's own preview step, just below)
        # isn't a way around the file-selection boundary.
        return {
            "error": (
                "A path is required while agent file-selection is active. "
                "Pass an allowed relative path, or use read_file on a "
                "selected file."
            )
        }

    try:
        result = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_DIFF_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git diff timed out after {GIT_DIFF_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git diff: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git diff failed."}

    diff_text = result.stdout or ""
    truncated = len(diff_text) > GIT_DIFF_MAX_CHARS
    payload = {
        "diff": diff_text[:GIT_DIFF_MAX_CHARS],
        "truncated": truncated,
    }
    if truncated:
        payload["truncation_note"] = (
            f"Diff output was truncated to {GIT_DIFF_MAX_CHARS} "
            f"characters. Request a path-scoped diff for a smaller view."
        )
    return payload


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
            timeout=GIT_LOG_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git log timed out after {GIT_LOG_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git log: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git log failed."}

    log_text = result.stdout or ""
    truncated = len(log_text) > GIT_LOG_MAX_CHARS
    payload = {
        "log": log_text[:GIT_LOG_MAX_CHARS],
        "truncated": truncated,
    }
    if truncated:
        payload["truncation_note"] = (
            f"Log output was truncated to {GIT_LOG_MAX_CHARS} characters."
        )
    return payload


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
            timeout=GIT_BRANCH_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git branch timed out after {GIT_BRANCH_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git branch: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git branch failed."}

    branches_text = result.stdout or ""
    truncated = len(branches_text) > GIT_BRANCH_MAX_CHARS
    payload = {
        "branches": branches_text[:GIT_BRANCH_MAX_CHARS],
        "truncated": truncated,
    }
    if truncated:
        payload["truncation_note"] = (
            f"Branch list was truncated to {GIT_BRANCH_MAX_CHARS} "
            f"characters."
        )
    return payload


def git_add(path: str, confirm: bool = False) -> dict:
    """Stage a single file's current changes for the next commit.

    This is the first *state-changing* Git operation exposed to the
    model. It follows the exact same preview/confirm pattern as
    create_file/write_file/apply_patch/delete_file: the first call
    (confirm=False, the default) does NOT touch the git index at all
    — it only reports what would be staged. Only pass confirm=True
    after the user has explicitly agreed to it.

    Staging is not committing: git_add only updates the index. It
    does not create a commit or push anything by itself — use
    git_commit and git_push (each with their own confirm step) for
    those.

    Args:
        path: Relative path to the file to stage.
        confirm: Must be True to actually stage the file.

    Returns:
        A dictionary confirming the staged file, or asking for
        confirmation.
    """

    try:
        file_path = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if is_sensitive_path(file_path):
        return {"error": f"Refusing to stage sensitive file: {path}"}

    if not (PROJECT_ROOT / ".git").exists():
        # PROJECT_ROOT can be a subdirectory of the actual repo root
        # (git discovers .git by walking upward from cwd, same as the
        # other git_* tools and apply_patch above), so this is only a
        # quick heuristic to fail fast for a fully untracked project.
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
                    "git_add requires the project to be inside a git "
                    "repository (no .git found in PROJECT_ROOT or any "
                    "parent directory)."
                )
            }

    if not file_path.exists():
        return {"error": f"File does not exist: {path}"}

    if file_path.is_dir():
        return {
            "error": "git_add can only stage a single file, not a directory."
        }

    rel_path = str(file_path.relative_to(PROJECT_ROOT))

    if not confirm:
        return {
            "requires_confirmation": True,
            "path": rel_path,
            "message": (
                f"'{rel_path}' was NOT staged. Show the user what "
                f"would be staged and ask them to explicitly confirm "
                f"it, then call git_add again with confirm=true."
            ),
        }

    try:
        result = subprocess.run(
            ["git", "add", "--", rel_path],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "Staging the file timed out."}
    except Exception as exc:
        return {"error": f"Could not stage file: {exc}"}

    if result.returncode != 0:
        return {
            "error": (
                f"git add failed: "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        }

    return {"path": rel_path, "staged": True}


def git_fetch(remote: str = "") -> dict:
    """Fetch changes from a remote without merging.

    Args:
        remote: Remote name to fetch from. Leave empty for all remotes.

    Returns:
        A dictionary with fetch output, or an error.
    """

    try:
        args = ["git", "fetch"]
        if remote:
            args.append(remote)
        result = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_FETCH_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git fetch timed out after {GIT_FETCH_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git fetch: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git fetch failed."}

    output = result.stdout or ""
    if not output and not result.stderr:
        output = "Fetch completed successfully."

    return {
        "output": output[:GIT_FETCH_MAX_CHARS],
        "remote": remote or "all remotes",
    }


def git_pull(remote: str = "", branch: str = "", confirm: bool = False) -> dict:
    """Pull changes from a remote and merge into the current branch.

    Requires confirmation. The first call (confirm=False, the default)
    does NOT pull anything — it only reports what would be pulled.
    Only pass confirm=True after the user has explicitly agreed.

    Args:
        remote: Remote name. Leave empty for the default remote.
        branch: Branch to pull. Leave empty for the current branch.
        confirm: Must be True to actually pull.

    Returns:
        A dictionary with pull output, or asking for confirmation.
    """

    if not confirm:
        return {
            "requires_confirmation": True,
            "remote": remote or "default",
            "branch": branch or "current",
            "message": (
                f"This will pull from '{remote or 'default remote'}' "
                f"and merge into the current branch. This changes local "
                f"files and may create merge conflicts. Confirm to proceed."
            ),
        }

    try:
        args = ["git", "pull"]
        if remote:
            args.append(remote)
        if branch:
            args.append(branch)
        result = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_PULL_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git pull timed out after {GIT_PULL_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git pull: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git pull failed."}

    output = result.stdout or ""
    return {
        "output": output[:GIT_PULL_MAX_CHARS],
        "remote": remote or "default",
        "branch": branch or "current",
    }


def git_restore(path: str, staged: bool = False, confirm: bool = False) -> dict:
    """Restore a file to its state in HEAD (or index if staged).

    Requires confirmation. The first call (confirm=False, the default)
    does NOT restore anything — it only reports what would be restored.
    Only pass confirm=True after the user has explicitly agreed.

    Args:
        path: Relative path to the file to restore.
        staged: If true, restore the staged version (unstage).
        confirm: Must be True to actually restore the file.

    Returns:
        A dictionary confirming the restore, or asking for confirmation.
    """

    try:
        file_path = safe_path(path)
    except ValueError as exc:
        return {"error": str(exc)}

    if is_sensitive_path(file_path):
        return {"error": f"Refusing to restore sensitive file: {path}"}

    if not file_path.exists():
        return {"error": f"File does not exist: {path}"}

    rel_path = str(file_path.relative_to(PROJECT_ROOT))

    if not confirm:
        if staged:
            action = "unstage"
            message = (
                f"'{rel_path}' will be unstaged. Your working-tree "
                f"changes will be preserved. Confirm to proceed."
            )
        else:
            action = "restore"
            message = (
                f"'{rel_path}' will be restored to its state in HEAD. "
                f"Uncommitted working-tree changes will be discarded. "
                f"Confirm to proceed."
            )
        return {
            "requires_confirmation": True,
            "path": rel_path,
            "action": action,
            "message": message,
        }

    try:
        args = ["git", "restore"]
        if staged:
            args.append("--staged")
        args.append("--")
        args.append(rel_path)
        result = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "Restoring the file timed out."}
    except Exception as exc:
        return {"error": f"Could not restore file: {exc}"}

    if result.returncode != 0:
        return {
            "error": (
                f"git restore failed: "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        }

    return {"path": rel_path, "restored": not staged, "unstaged": staged}


def git_commit(message: str, confirm: bool = False) -> dict:
    """Commit staged changes with a message.

    Requires confirmation. The first call (confirm=False, the default)
    does NOT commit anything — it only previews the staged diff and
    reports what would be committed. Only pass confirm=True after the
    user has explicitly agreed.

    Args:
        message: Commit message.
        confirm: Must be True to actually create the commit.

    Returns:
        A dictionary confirming the commit, or asking for confirmation.
    """

    if not message or not message.strip():
        return {"error": "A commit message is required."}

    message = message.strip()

    if not confirm:
        diff_result = git_diff(staged=True)
        diff_text = ""
        if isinstance(diff_result, dict):
            diff_text = diff_result.get("diff", "") or ""

        if not diff_text:
            return {"error": "No staged changes to commit."}

        preview = diff_text[:PREVIEW_CHAR_LIMIT]
        preview_truncated = len(diff_text) > PREVIEW_CHAR_LIMIT

        return {
            "requires_confirmation": True,
            "commit_message": message,
            "preview": preview,
            "preview_truncated": preview_truncated,
            "message": (
                f"About to commit with message: '{message}'. "
                f"This creates a new commit in the repository. "
                f"Confirm to proceed."
            ),
        }

    try:
        result = subprocess.run(
            ["git", "commit", "-m", message],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_COMMIT_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git commit timed out after {GIT_COMMIT_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git commit: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git commit failed."}

    output = result.stdout or ""
    return {
        "output": output[:GIT_COMMIT_MAX_CHARS],
        "commit_message": message,
        "committed": True,
    }


def git_push(remote: str = "", branch: str = "", confirm: bool = False) -> dict:
    """Push commits to a remote repository.

    Requires confirmation. The first call (confirm=False, the default)
    does NOT push anything — it only reports what would be pushed.
    Only pass confirm=True after the user has explicitly agreed.

    Args:
        remote: Remote name. Leave empty for the default remote.
        branch: Branch to push. Leave empty for the current branch.
        confirm: Must be True to actually push.

    Returns:
        A dictionary confirming the push, or asking for confirmation.
    """

    if not confirm:
        return {
            "requires_confirmation": True,
            "remote": remote or "default",
            "branch": branch or "current",
            "message": (
                f"This will push commits to '{remote or 'default remote'}' "
                f"on branch '{branch or 'current branch'}'. This updates "
                f"the remote repository. Confirm to proceed."
            ),
        }

    try:
        args = ["git", "push"]
        if remote:
            args.append(remote)
        if branch:
            args.append(branch)
        result = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_PUSH_TIMEOUT,
        )
    except FileNotFoundError:
        return {"error": "git is not installed or not on PATH."}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"git push timed out after {GIT_PUSH_TIMEOUT} seconds."
            )
        }
    except Exception as exc:
        return {"error": f"Could not run git push: {exc}"}

    if result.returncode != 0:
        return {"error": result.stderr.strip() or "git push failed."}

    output = result.stdout or ""
    return {
        "output": output[:GIT_PUSH_MAX_CHARS],
        "remote": remote or "default",
        "branch": branch or "current",
        "pushed": True,
    }


# ---------------------------------------------------------
# File-modification tools
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
    "git_committed_file_count": git_committed_file_count,
    "git_diff": git_diff,
    "git_log": git_log,
    "git_branch": git_branch,
    "git_fetch": git_fetch,
    "git_pull": git_pull,
    "git_restore": git_restore,
    "git_commit": git_commit,
    "git_push": git_push,
    "create_file": create_file,
    "write_file": write_file,
    "apply_patch": apply_patch,
    "delete_file": delete_file,
    "git_add": git_add,
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
    "git_committed_file_count",
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

# Git tools that change repository state (as opposed to git_status/
# git_diff/git_log/git_branch, which are read-only and never require
# confirmation). Kept as a separate set from WRITE_TOOL_NAMES so the
# two categories (filesystem vs. git) stay distinguishable — agent.py
# and app.py gate on both, but this set exists specifically so a
# future permission-level system can grant/restrict git operations
# independently of filesystem writes. Every tool here must follow the
# same confirm=False (preview only) / confirm=True (execute) pattern
# as WRITE_TOOL_NAMES.
GIT_CONFIRM_TOOL_NAMES = {
    "git_add",
    "git_pull",
    "git_restore",
    "git_commit",
    "git_push",
}

# Per-tool execution timeouts (seconds), enforced generically in
# agent.run_agent_loop so a single slow tool can't stall the whole
# agent. Read-only inspection tools get short budgets; run_command and
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
    "git_committed_file_count": 10,
    "git_diff": 10,
    "git_log": 10,
    "git_branch": 10,
    "git_fetch": 15,
    "git_pull": 30,
    "git_restore": 15,
    "git_commit": 15,
    "git_push": 30,
    "create_file": 5,
    "write_file": 5,
    "apply_patch": 35,
    "delete_file": 5,
    "git_add": 10,
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
# Canonical (provider-agnostic) tool schemas
# ---------------------------------------------------------
#
# Standard JSON Schema, lowercase types ("object", "string", ...).
# providers/gemini.py upcases these into Gemini's FunctionDeclaration
# format; providers/openai_compatible.py (Ollama, the Kilo gateway,
# OpenAI) uses them close to as-is, since that's already the format
# OpenAI-style `tools` arrays expect. Add a new tool in exactly one
# place — here plus TOOL_FUNCTIONS above — and every provider picks
# it up automatically.

TOOL_SCHEMAS = {
    "list_files": {
        "description": (
            "Lists files and directories inside the application "
            "project. Use this to explore the project structure "
            "before reading or editing files."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Relative directory path inside the project. "
                        "Use '.' for the project root."
                    ),
                },
            },
            "required": [],
        },
    },
    "read_file": {
        "description": (
            "Reads a UTF-8 text file inside the application project. "
            "Always read a file before editing it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to the text file.",
                },
            },
            "required": ["path"],
        },
    },
    "search_files": {
        "description": (
            "Searches text files inside the project for a query "
            "string (case-insensitive substring match), returning "
            "matching file paths, line numbers, and lines."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Text to search for.",
                },
                "path": {
                    "type": "string",
                    "description": (
                        "Relative directory to search under. Use '.' "
                        "for the whole project."
                    ),
                },
            },
            "required": ["query"],
        },
    },
    "run_command": {
        "description": (
            "Runs one of the explicitly allowed development commands "
            "inside the local project directory: read-only git "
            "inspection (status, log, diff, branch), directory "
            "listings, tool versions, installing dependencies, and "
            "running tests/builds/linters. Use this when the user "
            "asks you to run the tests, install dependencies, build "
            "the project, or check something the dedicated tools "
            "don't cover. It cannot run destructive, system-level, or "
            "credential-exposing commands."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": (
                        "An allowed command such as 'pytest', "
                        "'npm test', 'npm install', 'git log -n 5', "
                        "or 'npm run build'."
                    ),
                },
            },
            "required": ["command"],
        },
    },
    "git_status": {
        "description": (
            "Shows the current git status of the project as plain-language "
            "summary and structured fields (clean, staged, ahead/behind, "
            "file details). Always call this instead of guessing or "
            "assuming the repository state. Use the structured fields to "
            "answer questions such as whether changes are committed or "
            "whether the branch is synchronized with the remote."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    "git_committed_file_count": {
        "description": (
            "Counts how many files are recorded in the current HEAD commit "
            "without modifying the repository. Use when the user asks how "
            "many files are committed or tracked in the current commit."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    "git_diff": {
        "description": (
            "Shows the current git diff for the project, or for a "
            "single file. Use this to see exactly what has changed "
            "before or after making edits."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Optional relative path to scope the diff to "
                        "a single file. Leave empty for the whole "
                        "project."
                    ),
                },
                "staged": {
                    "type": "boolean",
                    "description": (
                        "If true, show staged changes instead of "
                        "unstaged changes."
                    ),
                },
            },
            "required": [],
        },
    },
    "git_log": {
        "description": (
            "Shows recent commit history for the project (one line "
            "per commit). Use this to understand recent changes "
            "instead of guessing."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "max_count": {
                    "type": "integer",
                    "description": (
                        "Number of commits to show (1-100). Defaults "
                        "to 10."
                    ),
                },
            },
            "required": [],
        },
    },
    "git_branch": {
        "description": (
            "Lists local git branches and shows which one is "
            "currently checked out."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    "git_fetch": {
        "description": (
            "Fetch changes from a remote repository without merging. "
            "Use this to update remote tracking branches before "
            "inspecting or pulling."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "remote": {
                    "type": "string",
                    "description": (
                        "Remote name to fetch from. Leave empty for "
                        "all remotes."
                    ),
                },
            },
            "required": [],
        },
    },
    "git_pull": {
        "description": (
            "Pull changes from a remote and merge into the current "
            "branch. Requires confirmation: calling without "
            "confirm=true will NOT pull anything, it only reports "
            "what would be pulled. Only call it again with "
            "confirm=true after the user has explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "remote": {
                    "type": "string",
                    "description": (
                        "Remote name. Leave empty for the default "
                        "remote."
                    ),
                },
                "branch": {
                    "type": "string",
                    "description": (
                        "Branch to pull. Leave empty for the current "
                        "branch."
                    ),
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually pull. "
                        "Defaults to false."
                    ),
                },
            },
            "required": [],
        },
    },
    "git_restore": {
        "description": (
            "Restore a file to its state in HEAD (or unstage it if "
            "staged=true). Requires confirmation: calling without "
            "confirm=true will NOT restore anything, it only reports "
            "what would be restored. Only call it again with "
            "confirm=true after the user has explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to the file to restore.",
                },
                "staged": {
                    "type": "boolean",
                    "description": (
                        "If true, unstage the file instead of "
                        "restoring working tree changes."
                    ),
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually restore the file. "
                        "Defaults to false."
                    ),
                },
            },
            "required": ["path"],
        },
    },
    "git_commit": {
        "description": (
            "Commit staged changes with a message. Requires "
            "confirmation: calling without confirm=true will NOT "
            "commit anything, it only previews the staged diff and "
            "reports what would be committed. Only call it again "
            "with confirm=true after the user has explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "Commit message.",
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually create the commit. "
                        "Defaults to false."
                    ),
                },
            },
            "required": ["message"],
        },
    },
    "git_push": {
        "description": (
            "Push commits to a remote repository. Requires "
            "confirmation: calling without confirm=true will NOT "
            "push anything, it only reports what would be pushed. "
            "Only call it again with confirm=true after the user "
            "has explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "remote": {
                    "type": "string",
                    "description": (
                        "Remote name. Leave empty for the default "
                        "remote."
                    ),
                },
                "branch": {
                    "type": "string",
                    "description": (
                        "Branch to push. Leave empty for the current "
                        "branch."
                    ),
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually push. "
                        "Defaults to false."
                    ),
                },
            },
            "required": [],
        },
    },
    "create_file": {
        "description": (
            "Creates a new file with the given contents inside the "
            "local project. Fails if the file already exists — use "
            "write_file to modify an existing file instead. Requires "
            "confirmation: calling without confirm=true will NOT "
            "create anything, it only returns a preview. Only call "
            "it again with confirm=true after the user has "
            "explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path for the new file.",
                },
                "contents": {
                    "type": "string",
                    "description": "Text contents to write to the file.",
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually create the file. "
                        "Defaults to false."
                    ),
                },
            },
            "required": ["path", "contents"],
        },
    },
    "write_file": {
        "description": (
            "Overwrites an existing file (or creates it if missing) "
            "with new contents inside the local project. Read the "
            "file first with read_file so you don't discard "
            "unrelated user changes, and prefer apply_patch for a "
            "small, targeted change instead of rewriting the whole "
            "file. Requires confirmation: calling without "
            "confirm=true will NOT write anything, it only returns a "
            "diff preview. Only call it again with confirm=true "
            "after the user has explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to the file.",
                },
                "contents": {
                    "type": "string",
                    "description": "The complete new contents of the file.",
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually write the file. "
                        "Defaults to false."
                    ),
                },
            },
            "required": ["path", "contents"],
        },
    },
    "apply_patch": {
        "description": (
            "Applies a small, targeted unified diff (like `git diff` "
            "output) to one or more project files. This is the "
            "preferred way to make a focused change to an existing "
            "file instead of rewriting it entirely with write_file. "
            "Requires confirmation: calling without confirm=true will "
            "NOT apply anything, it only validates the patch and "
            "reports which files would change. Only call it again "
            "with confirm=true after the user has explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "patch": {
                    "type": "string",
                    "description": (
                        "The unified diff text, including "
                        "'--- a/<path>' / '+++ b/<path>' headers and "
                        "'@@ ... @@' hunks."
                    ),
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually apply the patch. "
                        "Defaults to false."
                    ),
                },
            },
            "required": ["patch"],
        },
    },
    "delete_file": {
        "description": (
            "Deletes a single file inside the local project. This is "
            "destructive. Calling it without confirm=true will NOT "
            "delete anything — it only returns what would be "
            "deleted. Only call it again with confirm=true after the "
            "user has explicitly agreed to the deletion in the "
            "conversation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to the file to delete.",
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually perform the "
                        "deletion. Defaults to false."
                    ),
                },
            },
            "required": ["path"],
        },
    },
    "git_add": {
        "description": (
            "Stages a single file's current changes for the next "
            "commit (git add). This only updates the git index — it "
            "does not commit or push by itself; use git_commit and "
            "git_push (each with their own separate confirm step) "
            "for those. Requires confirmation: calling without "
            "confirm=true will NOT stage anything, it only reports "
            "what would be staged. Only call it again with "
            "confirm=true after the user has explicitly agreed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to the file to stage.",
                },
                "confirm": {
                    "type": "boolean",
                    "description": (
                        "Must be true to actually stage the file. "
                        "Defaults to false."
                    ),
                },
            },
            "required": ["path"],
        },
    },
}

assert TOOL_SCHEMAS.keys() == TOOL_FUNCTIONS.keys(), (
    "TOOL_SCHEMAS and TOOL_FUNCTIONS must declare exactly the same "
    "tool names."
)
