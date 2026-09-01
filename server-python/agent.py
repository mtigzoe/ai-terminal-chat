"""Provider-agnostic tool-calling loop with explicit write confirmation."""

from concurrent.futures import TimeoutError as FutureTimeoutError
from contextvars import copy_context
from queue import Empty, Queue
from threading import Event, Thread
from typing import Optional
import shlex

from providers.base import Provider, ProviderResponse, ToolCall
from pending import create_pending
from tools import (
    DEFAULT_TOOL_TIMEOUT,
    GIT_CONFIRM_TOOL_NAMES,
    TOOL_EXECUTOR,
    TOOL_FUNCTIONS,
    TOOL_TIMEOUTS,
    WRITE_TOOL_NAMES,
)

MAX_TOOL_ROUNDS = 10
MAX_CONSECUTIVE_IDENTICAL_CALLS = 3
HARD_ABORT_CONSECUTIVE_CALLS = 6
MAX_CONSECUTIVE_ERRORS = 5

_INSPECT_TOOLS = {
    "list_files",
    "read_file",
    "search_files",
    "git_status",
    "git_committed_file_count",
    "git_diff",
    "git_log",
    "git_branch",
    "git_fetch",
}
_EXECUTE_TOOLS = {
    "run_command",
}


def _progress(phase: str, message: str, **extra):
    """Build a simple, screen-reader-friendly progress event."""
    event = {"type": "progress", "phase": phase, "message": message}
    event.update(extra)
    return event


def _normalize_call_args(args: dict) -> tuple:
    """Build a stable signature for identical-call detection."""
    items = []
    for key, value in sorted(args.items()):
        if key in ("path",) and isinstance(value, str):
            normalized = value.strip()
            while normalized.startswith("./"):
                normalized = normalized[2:]
            items.append((key, normalized))
        else:
            items.append((key, repr(value)))
    return tuple(items)


def _extract_last_user_text(contents: list) -> str | None:
    """Extract the most recent user text from provider-neutral contents."""
    def text_from_value(value) -> str | None:
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            pieces = []
            for item in value:
                text = text_from_value(item)
                if text:
                    pieces.append(text)
            return "\n".join(pieces) if pieces else None
        if isinstance(value, dict):
            if isinstance(value.get("text"), str):
                return value["text"]
            if "parts" in value:
                return text_from_value(value["parts"])
            if "content" in value:
                return text_from_value(value["content"])
            return None
        text = getattr(value, "text", None)
        if isinstance(text, str):
            return text
        parts = getattr(value, "parts", None)
        if parts is not None:
            return text_from_value(parts)
        content = getattr(value, "content", None)
        if content is not None:
            return text_from_value(content)
        return None

    for item in reversed(contents or []):
        if isinstance(item, dict):
            role = item.get("role")
            if role == "user":
                text = text_from_value(item.get("content", item))
                if text:
                    return text
        else:
            role = getattr(item, "role", None)
            if role == "user":
                text = text_from_value(item)
                if text:
                    return text
    return None


def _direct_git_command(contents: list):
    """Return a deterministic tool/final response for an explicit Git command."""
    user_text = _extract_last_user_text(contents)
    if not user_text:
        return None

    command = user_text.strip()
    try:
        parts = shlex.split(command, posix=False)
    except ValueError:
        return None

    if not parts or parts[0].lower() != "git":
        return None

    subcommand = parts[1].lower() if len(parts) > 1 else ""

    if subcommand == "add":
        if len(parts) == 3:
            path = parts[2]
        elif len(parts) == 4 and parts[2] == "--":
            path = parts[3]
        else:
            return None
        if not path or path.startswith("-"):
            return None
        if len(path) >= 2 and path[0] == path[-1] and path[0] in "\"'":
            path = path[1:-1]
        return ProviderResponse(text=None, tool_calls=[ToolCall("git_add", {"path": path})])

    if subcommand == "fetch":
        remote = ""
        i = 2
        while i < len(parts):
            part = parts[i]
            if not part.startswith("-"):
                remote = part
                break
            i += 1
        return ProviderResponse(text=None, tool_calls=[ToolCall("git_fetch", {"remote": remote})])

    if subcommand == "pull":
        remote = ""
        branch = ""
        i = 2
        while i < len(parts):
            part = parts[i]
            if not part.startswith("-"):
                if not remote:
                    remote = part
                elif not branch:
                    branch = part
            i += 1
        return ProviderResponse(text=None, tool_calls=[ToolCall("git_pull", {"remote": remote, "branch": branch})])

    if subcommand == "restore":
        path = ""
        staged = False
        i = 2
        while i < len(parts):
            part = parts[i]
            if part == "--staged":
                staged = True
            elif not part.startswith("-"):
                path = part
            i += 1
        if not path:
            return None
        if len(path) >= 2 and path[0] == path[-1] and path[0] in "\"'":
            path = path[1:-1]
        return ProviderResponse(text=None, tool_calls=[ToolCall("git_restore", {"path": path, "staged": staged})])

    if subcommand == "commit":
        message = None
        i = 2
        while i < len(parts):
            part = parts[i]
            if part == "-m":
                if i + 1 < len(parts):
                    message = parts[i + 1]
                    i += 2
                    continue
                i += 1
            elif part.startswith("-m") and len(part) > 2:
                message = part[2:]
                i += 1
            else:
                i += 1
        if message:
            if len(message) >= 2 and message[0] == message[-1] and message[0] in "\"'":
                message = message[1:-1]
            return ProviderResponse(text=None, tool_calls=[ToolCall("git_commit", {"message": message})])
        return ProviderResponse(text="Git commit requires a message. Use: git commit -m \"your message\"")

    if subcommand == "push":
        remote = ""
        branch = ""
        i = 2
        while i < len(parts):
            part = parts[i]
            if not part.startswith("-"):
                if not remote:
                    remote = part
                elif not branch:
                    branch = part
            i += 1
        return ProviderResponse(text=None, tool_calls=[ToolCall("git_push", {"remote": remote, "branch": branch})])

    if subcommand == "status" and len(parts) == 2:
        return ProviderResponse(text=None, tool_calls=[ToolCall("git_status", {})])

    if subcommand == "branch" and len(parts) == 3 and parts[2] == "--show-current":
        return ProviderResponse(text=None, tool_calls=[ToolCall("run_command", {"command": command})])

    return None


def _describe_tool_progress(function_name: str, function_args: dict) -> tuple:
    """Return (phase, message) describing what the agent is about to do."""
    path = function_args.get("path")
    path_label = f" {path}" if isinstance(path, str) and path.strip() else ""

    if function_name in WRITE_TOOL_NAMES:
        action = {"create_file": "create", "write_file": "modify", "apply_patch": "patch", "delete_file": "delete"}.get(function_name, "change")
        if function_name == "apply_patch":
            return "confirm", "Preparing to patch file(s)"
        return "confirm", f"Preparing to {action}{path_label or ' file(s)'}"

    if function_name in GIT_CONFIRM_TOOL_NAMES:
        return "confirm", f"Preparing to stage{path_label or ' file(s)'}"

    if function_name in _INSPECT_TOOLS:
        if function_name == "read_file":
            return "inspect", f"Inspecting{path_label or ' file'}"
        if function_name == "list_files":
            return "inspect", f"Listing files in{path_label or ' project'}"
        if function_name == "search_files":
            query = function_args.get("query", "")
            q = f" for '{query}'" if query else ""
            return "inspect", f"Searching project{q}"
        if function_name == "git_status":
            return "inspect", "Checking git status"
        if function_name == "git_committed_file_count":
            return "inspect", "Counting files in the current commit"
        if function_name == "git_diff":
            return "inspect", f"Inspecting git diff{path_label}"
        if function_name == "git_log":
            return "inspect", "Inspecting recent commits"
        if function_name == "git_branch":
            return "inspect", "Listing git branches"
        if function_name == "git_fetch":
            return "inspect", "Fetching from remote"
        return "inspect", f"Inspecting via {function_name}"

    if function_name in _EXECUTE_TOOLS:
        command = function_args.get("command", "")
        if command:
            short = command if len(command) <= 60 else command[:57] + "..."
            return "execute", f"Running command: {short}"
        return "execute", "Running command"

    return "execute", f"Calling {function_name}"


def _is_successful_write_result(result: dict) -> bool:
    """True when a write tool reports that a change actually happened."""
    if not isinstance(result, dict) or result.get("error"):
        return False
    return bool(result.get("created") or result.get("overwritten") is not None or result.get("applied") or result.get("deleted") or result.get("staged") or result.get("committed") or result.get("pushed") or result.get("pulled") or result.get("restored") or result.get("unstaged") or result.get("bytes_written") is not None)


def _cancelled_event():
    return {"type": "cancelled"}


def _run_tool_with_timeout(function, function_name: str, function_args: dict, timeout_seconds: float) -> dict:
    """Run a tool with a timeout while preserving request-scoped context."""
    result_queue: Queue = Queue(maxsize=1)
    context = copy_context()

    def worker():
        try:
            result_queue.put(context.run(function, **function_args))
        except TypeError as exc:
            result_queue.put({"error": f"Malformed arguments for {function_name}: {exc}"})
        except Exception as exc:
            result_queue.put({"error": f"Tool {function_name} failed: {exc}"})

    thread = Thread(target=worker, name=f"ai-terminal-tool:{function_name}", daemon=True)
    thread.start()
    thread.join(timeout_seconds)

    if thread.is_alive():
        return {"error": f"Tool {function_name} exceeded its {timeout_seconds}s execution limit and was abandoned."}

    try:
        return result_queue.get_nowait()
    except Empty:
        return {"error": f"Tool {function_name} completed without returning a result."}


def run_agent_loop(provider: Provider, contents: list, cancel_event: Optional[Event] = None):
    """Run the provider and explicitly execute requested tools."""
    last_call_signature = None
    consecutive_repeat_count = 0
    consecutive_error_count = 0

    yield _progress("plan", "Planning next step", round=1, max_rounds=MAX_TOOL_ROUNDS)

    for round_index in range(MAX_TOOL_ROUNDS):
        round_number = round_index + 1

        if cancel_event is not None and cancel_event.is_set():
            yield _progress("cancelled", "Stopped: cancelled by user", round=round_number, max_rounds=MAX_TOOL_ROUNDS)
            yield _cancelled_event()
            return

        try:
            direct_response = _direct_git_command(contents) if round_index == 0 else None
            response = direct_response if direct_response is not None else provider.generate(contents)
        except Exception as exc:
            yield _progress("error", f"Provider failed: {exc}", round=round_number, max_rounds=MAX_TOOL_ROUNDS)
            yield {"type": "error", "message": f"{type(provider).__name__} error: {exc}"}
            return

        if not response.tool_calls:
            if not response.text:
                yield _progress("error", "Model returned no text and requested no further tools.", round=round_number, max_rounds=MAX_TOOL_ROUNDS)
                yield {"type": "error", "message": "Model returned no text and requested no further tools."}
                return
            yield _progress("complete", "Task completed", round=round_number, max_rounds=MAX_TOOL_ROUNDS)
            yield {"type": "final", "text": response.text}
            return

        contents = provider.append_model_turn(contents, response)
        tool_results = []

        for call in response.tool_calls:
            if cancel_event is not None and cancel_event.is_set():
                yield _progress("cancelled", "Stopped: cancelled by user", round=round_number, max_rounds=MAX_TOOL_ROUNDS)
                yield _cancelled_event()
                return

            function_name = call.name
            function_args = dict(call.args or {})
            phase, progress_message = _describe_tool_progress(function_name, function_args)
            yield _progress(phase, progress_message, round=round_number, max_rounds=MAX_TOOL_ROUNDS, tool=function_name)
            print(f"[tool call] {function_name}({function_args})")
            yield {"type": "tool_call", "name": function_name, "args": function_args}

            call_signature = (function_name, _normalize_call_args(function_args))
            if call_signature == last_call_signature:
                consecutive_repeat_count += 1
            else:
                last_call_signature = call_signature
                consecutive_repeat_count = 1

            function = TOOL_FUNCTIONS.get(function_name)

            if function is None:
                result = {"error": f"Unknown tool requested: {function_name}. Use only the tools that are available."}
            elif consecutive_repeat_count > HARD_ABORT_CONSECUTIVE_CALLS:
                yield _progress("error", f"Stopped after {consecutive_repeat_count} identical calls to {function_name}.", round=round_number, max_rounds=MAX_TOOL_ROUNDS, tool=function_name)
                yield {"type": "error", "message": f"Stopping: {function_name} was called with the exact same arguments {consecutive_repeat_count} times in a row. Change approach rather than repeating the identical call."}
                return
            elif consecutive_repeat_count > MAX_CONSECUTIVE_IDENTICAL_CALLS:
                result = {"error": f"{function_name} has already been called with these exact arguments {consecutive_repeat_count - 1} time(s) in a row. Do not retry the identical call. Inspect the previous result, choose a different tool or different arguments, or explain the blockage to the user."}
            elif function_name in WRITE_TOOL_NAMES or function_name in GIT_CONFIRM_TOOL_NAMES:
                preview_args = dict(function_args)
                preview_args["confirm"] = False
                timeout_seconds = TOOL_TIMEOUTS.get(function_name, DEFAULT_TOOL_TIMEOUT)
                result = _run_tool_with_timeout(function, function_name, preview_args, timeout_seconds)

                if not result.get("error") and result.get("requires_confirmation"):
                    action = create_pending(function_name, function_args, result)
                    path = function_args.get("path")
                    if function_name == "apply_patch":
                        confirm_message = "Waiting for confirmation to apply patch"
                    elif function_name == "git_add":
                        confirm_message = f"Waiting for confirmation to stage {path}" if isinstance(path, str) and path.strip() else "Waiting for confirmation to stage file(s)"
                    elif function_name == "git_restore":
                        action_type = result.get("action", "restore")
                        confirm_message = f"Waiting for confirmation to {action_type} {path}" if isinstance(path, str) and path.strip() else f"Waiting for confirmation to {action_type} file"
                    elif function_name == "git_commit":
                        confirm_message = "Waiting for confirmation to commit"
                    elif function_name == "git_push":
                        confirm_message = "Waiting for confirmation to push"
                    elif function_name == "git_pull":
                        confirm_message = "Waiting for confirmation to pull"
                    elif isinstance(path, str) and path.strip():
                        confirm_message = f"Waiting for confirmation to modify {path}"
                    else:
                        confirm_message = f"Waiting for confirmation for {function_name}"

                    yield _progress("confirm", confirm_message, round=round_number, max_rounds=MAX_TOOL_ROUNDS, tool=function_name, action_id=action.action_id)
                    yield {"type": "pending_confirmation", "action_id": action.action_id, "name": function_name, "args": function_args, "preview": result}
                    return
            else:
                timeout_seconds = TOOL_TIMEOUTS.get(function_name, DEFAULT_TOOL_TIMEOUT)
                result = _run_tool_with_timeout(function, function_name, function_args, timeout_seconds)

            # Reading an unselected file is a user-permission boundary, not a
            # normal model/tool error. Pause here and let the browser present
            # an explicit Allow/Decline choice. The browser will persist the
            # granted path in the Project-page selection store.
            if (
                function_name == "read_file"
                and isinstance(result, dict)
                and isinstance(result.get("error"), str)
                and result["error"].startswith("Access denied:")
            ):
                path = function_args.get("path")
                if isinstance(path, str) and path.strip():
                    action = create_pending(
                        "read_file_permission",
                        {"path": path},
                        {
                            "message": (
                                f"The assistant wants to read '{path}'. "
                                "Allowing this will add the file to your "
                                "Project-page agent selection."
                            ),
                            "permission_request": True,
                        },
                    )
                    yield _progress(
                        "confirm",
                        f"Waiting for permission to read {path}",
                        round=round_number,
                        max_rounds=MAX_TOOL_ROUNDS,
                        tool="read_file",
                        action_id=action.action_id,
                    )
                    yield {
                        "type": "pending_confirmation",
                        "action_id": action.action_id,
                        "name": "read_file_permission",
                        "args": {"path": path},
                        "preview": action.preview,
                    }
                    return

            if isinstance(result, dict) and result.get("error"):
                consecutive_error_count += 1
            else:
                consecutive_error_count = 0

            if consecutive_error_count >= 3 and isinstance(result, dict):
                result = dict(result)
                result["recovery_hint"] = "Multiple consecutive tool failures have occurred. Stop repeating the same pattern: report the errors, inspect the project state if needed, and try a different approach or explain the blockage to the user."
                yield _progress("recover", f"Recovery needed after {consecutive_error_count} consecutive tool failures", round=round_number, max_rounds=MAX_TOOL_ROUNDS, tool=function_name)

            if consecutive_error_count >= MAX_CONSECUTIVE_ERRORS:
                yield _progress("error", f"Stopped after {consecutive_error_count} consecutive tool failures.", round=round_number, max_rounds=MAX_TOOL_ROUNDS)
                yield {"type": "error", "message": f"Stopping: {consecutive_error_count} consecutive tool failures without a successful recovery. Report the problem to the user rather than continuing to retry."}
                return

            if _is_successful_write_result(result):
                path = result.get("path") or function_args.get("path") or ""
                verify_target = f" {path}" if path else ""
                yield _progress("verify", f"Verifying changes{verify_target}", round=round_number, max_rounds=MAX_TOOL_ROUNDS, tool=function_name)
                if isinstance(result, dict):
                    result = dict(result)
                    result["verification_hint"] = "A write operation succeeded. Verify the result next: read the affected file back and/or inspect git_diff. When practical, run a focused test or lint for the changed area. Do not claim success without checking."

            print(f"[tool result] {function_name}: {result}")
            yield {"type": "tool_result", "name": function_name, "result": result}
            tool_results.append({"name": function_name, "result": result})

        contents = provider.append_tool_results(contents, tool_results)
        if round_number < MAX_TOOL_ROUNDS:
            yield _progress("plan", "Planning next step", round=round_number + 1, max_rounds=MAX_TOOL_ROUNDS)

    yield _progress("error", "Exceeded maximum tool-calling rounds without a final response.", round=MAX_TOOL_ROUNDS, max_rounds=MAX_TOOL_ROUNDS)
    yield {"type": "error", "message": "Model exceeded the maximum number of tool-calling rounds without producing a final response. Break the task into smaller steps or ask the user how to proceed."}
