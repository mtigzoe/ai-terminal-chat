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

# Tool groups used only for progress phase labels — not for security.
_INSPECT_TOOLS = {
    "list_files",
    "read_file",
    "search_files",
    "git_status",
    "git_committed_file_count",
    "git_diff",
    "git_log",
    "git_branch",
}
_EXECUTE_TOOLS = {
    "run_command",
}


def _progress(phase: str, message: str, **extra):
    """Build a simple, screen-reader-friendly progress event."""

    event = {
        "type": "progress",
        "phase": phase,
        "message": message,
    }
    event.update(extra)
    return event


def _normalize_call_args(args: dict) -> tuple:
    """Build a stable signature for identical-call detection.

    Exact matching is preserved. Path-like values are lightly normalized
    so trivial variants such as 'app.py' and './app.py' count as the
    same call. No fuzzy or semantic similarity is applied.
    """

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
    """Extract the most recent user text from provider-neutral contents.

    Providers use slightly different content shapes. This helper only
    inspects entries explicitly marked as user turns and supports the
    common OpenAI-style ``content`` string and Gemini-style ``parts``
    objects. It is deliberately conservative: if no user text can be
    identified, normal model tool selection is used.
    """

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
    """Return a deterministic tool/final response for an explicit Git command.

    The agent should not ask the model to infer an obvious command from a
    user message such as ``git add file.txt``. Small/local models can instead
    mistake that command for a file-editing request. Exact command syntax is
    handled here while ordinary natural-language requests continue through
    the model.

    State-changing Git commands still use the normal confirmation mechanism.
    Commit and push remain intentionally unavailable in the tool set.
    """

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
        return ProviderResponse(
            text=None,
            tool_calls=[ToolCall("git_add", {"path": path})]
        )

    if subcommand == "status" and len(parts) == 2:
        return ProviderResponse(
            text=None,
            tool_calls=[ToolCall("git_status", {})]
        )

    if subcommand == "branch" and len(parts) == 3 and parts[2] == "--show-current":
        return ProviderResponse(
            text=None,
            tool_calls=[ToolCall("run_command", {"command": command})]
        )

    if subcommand == "commit":
        return ProviderResponse(
            text=(
                "Git commit is intentionally not available to the agent. "
                "The agent can create or modify files and stage a file with "
                "git add after confirmation, but commits must be made by the "
                "user in their own Git client or terminal."
            )
        )

    if subcommand == "push":
        return ProviderResponse(
            text=(
                "Git push is intentionally not available to the agent. "
                "Push the committed changes from your own Git client or terminal."
            )
        )

    return None


def _describe_tool_progress(function_name: str, function_args: dict) -> tuple:
    """Return (phase, message) describing what the agent is about to do."""

    path = function_args.get("path")
    path_label = f" {path}" if isinstance(path, str) and path.strip() else ""

    if function_name in WRITE_TOOL_NAMES:
        action = {
            "create_file": "create",
            "write_file": "modify",
            "apply_patch": "patch",
            "delete_file": "delete",
        }.get(function_name, "change")
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
    return bool(
        result.get("created")
        or result.get("overwritten") is not None
        or result.get("applied")
        or result.get("deleted")
        or result.get("staged")
        or result.get("bytes_written") is not None
    )


def _cancelled_event():
    return {"type": "cancelled"}


def _run_tool_with_timeout(function, function_name: str, function_args: dict, timeout_seconds: float) -> dict:
    """Run a tool with a timeout while preserving request-scoped context.

    Agent file permissions are stored in a ContextVar. Python does not
    automatically propagate ContextVar values into a newly created thread,
    so the current context is copied before the worker starts and executed
    explicitly inside that worker. This keeps the Project-page file
    selection attached to the actual tool invocation.
    """

    result_queue: Queue = Queue(maxsize=1)
    context = copy_context()

    def worker():
        try:
            result_queue.put(context.run(function, **function_args))
        except TypeError as exc:
            result_queue.put({
                "error": f"Malformed arguments for {function_name}: {exc}"
            })
        except Exception as exc:
            result_queue.put({
                "error": f"Tool {function_name} failed: {exc}"
            })

    thread = Thread(
        target=worker,
        name=f"ai-terminal-tool:{function_name}",
        daemon=True,
    )
    thread.start()
    thread.join(timeout_seconds)

    if thread.is_alive():
        return {
            "error": (
                f"Tool {function_name} exceeded its "
                f"{timeout_seconds}s execution limit and was abandoned."
            )
        }

    try:
        return result_queue.get_nowait()
    except Empty:
        return {
            "error": f"Tool {function_name} completed without returning a result."
        }


def run_agent_loop(
    provider: Provider,
    contents: list,
    cancel_event: Optional[Event] = None,
):
    """Run the provider and explicitly execute requested tools.

    Lifecycle (visible via progress events):
      plan → inspect → execute → confirm → verify → recover → complete

    Write/destructive tools are never allowed to self-confirm. The model's
    first request is executed with confirm=False to produce a preview, then
    a pending_confirmation event is emitted and the loop stops. The HTTP
    layer can expose that event to the user and use /confirm to authorize
    the exact stored action later.

    Progress events are provider-agnostic and intended for frontend and
    screen-reader consumption.

    `cancel_event`, when provided, is checked before each provider call
    and before each tool call. This is cooperative cancellation: a call
    already in flight (a slow provider.generate() or a running tool)
    still runs to completion, but the loop stops taking further action
    as soon as it next checks the event, instead of continuing to spend
    rounds, tool calls, and provider time after the user asked to stop.
    """

    last_call_signature = None
    consecutive_repeat_count = 0
    consecutive_error_count = 0

    yield _progress(
        "plan",
        "Planning next step",
        round=1,
        max_rounds=MAX_TOOL_ROUNDS,
    )

    for round_index in range(MAX_TOOL_ROUNDS):
        round_number = round_index + 1

        if cancel_event is not None and cancel_event.is_set():
            yield _progress(
                "cancelled",
                "Stopped: cancelled by user",
                round=round_number,
                max_rounds=MAX_TOOL_ROUNDS,
            )
            yield _cancelled_event()
            return

        try:
            direct_response = _direct_git_command(contents) if round_index == 0 else None
            response = direct_response if direct_response is not None else provider.generate(contents)
        except Exception as exc:
            yield _progress(
                "error",
                f"Provider failed: {exc}",
                round=round_number,
                max_rounds=MAX_TOOL_ROUNDS,
            )
            yield {
                "type": "error",
                "message": f"{type(provider).__name__} error: {exc}",
            }
            return

        if not response.tool_calls:
            if not response.text:
                yield _progress(
                    "error",
                    "Model returned no text and requested no further tools.",
                    round=round_number,
                    max_rounds=MAX_TOOL_ROUNDS,
                )
                yield {
                    "type": "error",
                    "message": "Model returned no text and requested no further tools.",
                }
                return

            yield _progress(
                "complete",
                "Task completed",
                round=round_number,
                max_rounds=MAX_TOOL_ROUNDS,
            )
            yield {"type": "final", "text": response.text}
            return

        contents = provider.append_model_turn(contents, response)
        tool_results = []

        for call in response.tool_calls:
            if cancel_event is not None and cancel_event.is_set():
                yield _progress(
                    "cancelled",
                    "Stopped: cancelled by user",
                    round=round_number,
                    max_rounds=MAX_TOOL_ROUNDS,
                )
                yield _cancelled_event()
                return

            function_name = call.name
            function_args = dict(call.args or {})

            phase, progress_message = _describe_tool_progress(
                function_name, function_args
            )
            yield _progress(
                phase,
                progress_message,
                round=round_number,
                max_rounds=MAX_TOOL_ROUNDS,
                tool=function_name,
            )

            print(f"[tool call] {function_name}({function_args})")
            yield {
                "type": "tool_call",
                "name": function_name,
                "args": function_args,
            }

            call_signature = (function_name, _normalize_call_args(function_args))

            if call_signature == last_call_signature:
                consecutive_repeat_count += 1
            else:
                last_call_signature = call_signature
                consecutive_repeat_count = 1

            function = TOOL_FUNCTIONS.get(function_name)

            if function is None:
                result = {
                    "error": (
                        f"Unknown tool requested: {function_name}. "
                        f"Use only the tools that are available."
                    )
                }

            elif consecutive_repeat_count > HARD_ABORT_CONSECUTIVE_CALLS:
                yield _progress(
                    "error",
                    (
                        f"Stopped after {consecutive_repeat_count} identical "
                        f"calls to {function_name}."
                    ),
                    round=round_number,
                    max_rounds=MAX_TOOL_ROUNDS,
                    tool=function_name,
                )
                yield {
                    "type": "error",
                    "message": (
                        f"Stopping: {function_name} was called with the exact same "
                        f"arguments {consecutive_repeat_count} times in a row. "
                        f"Change approach rather than repeating the identical call."
                    ),
                }
                return

            elif consecutive_repeat_count > MAX_CONSECUTIVE_IDENTICAL_CALLS:
                result = {
                    "error": (
                        f"{function_name} has already been called with these exact "
                        f"arguments {consecutive_repeat_count - 1} time(s) in a row. "
                        f"Do not retry the identical call. Inspect the previous "
                        f"result, choose a different tool or different arguments, "
                        f"or explain the blockage to the user."
                    )
                }

            elif (
                function_name in WRITE_TOOL_NAMES
                or function_name in GIT_CONFIRM_TOOL_NAMES
            ):
                # Security invariant: the model can never self-confirm.
                # First call always runs with confirm=False for a preview only.
                preview_args = dict(function_args)
                preview_args["confirm"] = False
                timeout_seconds = TOOL_TIMEOUTS.get(
                    function_name, DEFAULT_TOOL_TIMEOUT
                )
                result = _run_tool_with_timeout(
                    function, function_name, preview_args, timeout_seconds
                )

                if not result.get("error") and result.get("requires_confirmation"):
                    action = create_pending(function_name, function_args, result)
                    path = function_args.get("path")
                    if function_name == "apply_patch":
                        confirm_message = (
                            "Waiting for confirmation to apply patch"
                        )
                    elif function_name == "git_add":
                        confirm_message = (
                            f"Waiting for confirmation to stage {path}"
                            if isinstance(path, str) and path.strip()
                            else "Waiting for confirmation to stage file(s)"
                        )
                    elif isinstance(path, str) and path.strip():
                        confirm_message = (
                            f"Waiting for confirmation to modify {path}"
                        )
                    else:
                        confirm_message = (
                            f"Waiting for confirmation for {function_name}"
                        )

                    yield _progress(
                        "confirm",
                        confirm_message,
                        round=round_number,
                        max_rounds=MAX_TOOL_ROUNDS,
                        tool=function_name,
                        action_id=action.action_id,
                    )
                    yield {
                        "type": "pending_confirmation",
                        "action_id": action.action_id,
                        "name": function_name,
                        "args": function_args,
                        "preview": result,
                    }
                    return

            else:
                timeout_seconds = TOOL_TIMEOUTS.get(
                    function_name, DEFAULT_TOOL_TIMEOUT
                )
                result = _run_tool_with_timeout(
                    function, function_name, function_args, timeout_seconds
                )

            if isinstance(result, dict) and result.get("error"):
                consecutive_error_count += 1
            else:
                consecutive_error_count = 0

            if consecutive_error_count >= 3 and isinstance(result, dict):
                result = dict(result)
                result["recovery_hint"] = (
                    "Multiple consecutive tool failures have occurred. "
                    "Stop repeating the same pattern: report the errors, "
                    "inspect the project state if needed, and try a different "
                    "approach or explain the blockage to the user."
                )
                yield _progress(
                    "recover",
                    (
                        f"Recovery needed after {consecutive_error_count} "
                        f"consecutive tool failures"
                    ),
                    round=round_number,
                    max_rounds=MAX_TOOL_ROUNDS,
                    tool=function_name,
                )

            if consecutive_error_count >= MAX_CONSECUTIVE_ERRORS:
                yield _progress(
                    "error",
                    (
                        f"Stopped after {consecutive_error_count} consecutive "
                        f"tool failures."
                    ),
                    round=round_number,
                    max_rounds=MAX_TOOL_ROUNDS,
                )
                yield {
                    "type": "error",
                    "message": (
                        f"Stopping: {consecutive_error_count} consecutive tool "
                        f"failures without a successful recovery. Report the "
                        f"problem to the user rather than continuing to retry."
                    ),
                }
                return

            # Successful writes normally occur only via /confirm outside this
            # loop. If a success result is ever observed here, prompt verification.
            if _is_successful_write_result(result):
                path = result.get("path") or function_args.get("path") or ""
                verify_target = f" {path}" if path else ""
                yield _progress(
                    "verify",
                    f"Verifying changes{verify_target}",
                    round=round_number,
                    max_rounds=MAX_TOOL_ROUNDS,
                    tool=function_name,
                )
                if isinstance(result, dict):
                    result = dict(result)
                    result["verification_hint"] = (
                        "A write operation succeeded. Verify the result next: "
                        "read the affected file back and/or inspect git_diff. "
                        "When practical, run a focused test or lint for the "
                        "changed area. Do not claim success without checking."
                    )

            print(f"[tool result] {function_name}: {result}")
            yield {
                "type": "tool_result",
                "name": function_name,
                "result": result,
            }
            tool_results.append({"name": function_name, "result": result})

        contents = provider.append_tool_results(contents, tool_results)

        if round_number < MAX_TOOL_ROUNDS:
            yield _progress(
                "plan",
                "Planning next step",
                round=round_number + 1,
                max_rounds=MAX_TOOL_ROUNDS,
            )

    yield _progress(
        "error",
        "Exceeded maximum tool-calling rounds without a final response.",
        round=MAX_TOOL_ROUNDS,
        max_rounds=MAX_TOOL_ROUNDS,
    )
    yield {
        "type": "error",
        "message": (
            "Model exceeded the maximum number of tool-calling rounds "
            "without producing a final response. Break the task into "
            "smaller steps or ask the user how to proceed."
        ),
    }
