"""Provider-agnostic tool-calling loop with explicit write confirmation."""

from concurrent.futures import TimeoutError as FutureTimeoutError

from providers.base import Provider
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


def run_agent_loop(provider: Provider, contents: list):
    """Run the provider and explicitly execute requested tools.

    Lifecycle (visible via progress events):
      plan → inspect → execute → confirm → verify → recover → complete

    Write/destructive tools are never allowed to self-confirm. The model's
    first request is executed with confirm=False to produce a preview, then
    a pending_confirmation event is emitted and the loop stops. The HTTP
    layer can expose that event to the user and use /confirm to authorize the
    exact stored action later.

    Progress events are provider-agnostic and intended for frontend and
    screen-reader consumption.
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

        try:
            response = provider.generate(contents)
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
                future = TOOL_EXECUTOR.submit(function, **preview_args)

                try:
                    result = future.result(timeout=timeout_seconds)
                except FutureTimeoutError:
                    result = {
                        "error": (
                            f"Tool {function_name} exceeded its "
                            f"{timeout_seconds}s execution limit and was abandoned."
                        )
                    }
                except TypeError as exc:
                    result = {
                        "error": f"Malformed arguments for {function_name}: {exc}"
                    }
                except Exception as exc:
                    result = {"error": f"Tool {function_name} failed: {exc}"}

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
                future = TOOL_EXECUTOR.submit(function, **function_args)

                try:
                    result = future.result(timeout=timeout_seconds)
                except FutureTimeoutError:
                    result = {
                        "error": (
                            f"Tool {function_name} exceeded its "
                            f"{timeout_seconds}s execution limit and was abandoned."
                        )
                    }
                except TypeError as exc:
                    result = {
                        "error": f"Malformed arguments for {function_name}: {exc}"
                    }
                except Exception as exc:
                    result = {"error": f"Tool {function_name} failed: {exc}"}

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
