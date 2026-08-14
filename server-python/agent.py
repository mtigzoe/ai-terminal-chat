"""Provider-agnostic tool-calling loop with explicit write confirmation."""

from concurrent.futures import TimeoutError as FutureTimeoutError

from providers.base import Provider
from pending import create_pending
from tools import (
    DEFAULT_TOOL_TIMEOUT,
    TOOL_EXECUTOR,
    TOOL_FUNCTIONS,
    TOOL_TIMEOUTS,
    WRITE_TOOL_NAMES,
)

MAX_TOOL_ROUNDS = 10
MAX_CONSECUTIVE_IDENTICAL_CALLS = 3
HARD_ABORT_CONSECUTIVE_CALLS = 6


def run_agent_loop(provider: Provider, contents: list):
    """Run the provider and explicitly execute requested tools.

    Write/destructive tools are never allowed to self-confirm. The model's
    first request is executed with confirm=False to produce a preview, then
    a pending_confirmation event is emitted and the loop stops. The HTTP
    layer can expose that event to the user and use /confirm to authorize the
    exact stored action later.
    """

    last_call_signature = None
    consecutive_repeat_count = 0

    for _ in range(MAX_TOOL_ROUNDS):
        try:
            response = provider.generate(contents)
        except Exception as exc:
            yield {
                "type": "error",
                "message": f"{type(provider).__name__} error: {exc}",
            }
            return

        if not response.tool_calls:
            if not response.text:
                yield {
                    "type": "error",
                    "message": "Model returned no text and requested no further tools.",
                }
                return

            yield {"type": "final", "text": response.text}
            return

        contents = provider.append_model_turn(contents, response)
        tool_results = []

        for call in response.tool_calls:
            function_name = call.name
            function_args = dict(call.args or {})

            print(f"[tool call] {function_name}({function_args})")
            yield {
                "type": "tool_call",
                "name": function_name,
                "args": function_args,
            }

            call_signature = (
                function_name,
                tuple(sorted((key, repr(value)) for key, value in function_args.items())),
            )

            if call_signature == last_call_signature:
                consecutive_repeat_count += 1
            else:
                last_call_signature = call_signature
                consecutive_repeat_count = 1

            function = TOOL_FUNCTIONS.get(function_name)

            if function is None:
                result = {"error": f"Unknown tool requested: {function_name}"}

            elif consecutive_repeat_count > HARD_ABORT_CONSECUTIVE_CALLS:
                yield {
                    "type": "error",
                    "message": (
                        f"Stopping: {function_name} was called with the exact same "
                        f"arguments {consecutive_repeat_count} times in a row."
                    ),
                }
                return

            elif consecutive_repeat_count > MAX_CONSECUTIVE_IDENTICAL_CALLS:
                result = {
                    "error": (
                        f"{function_name} has already been called with these exact "
                        f"arguments {consecutive_repeat_count - 1} time(s) in a row."
                    )
                }

            elif function_name in WRITE_TOOL_NAMES:
                # The model is deliberately forced through the preview path.
                preview_args = dict(function_args)
                preview_args["confirm"] = False
                timeout_seconds = TOOL_TIMEOUTS.get(function_name, DEFAULT_TOOL_TIMEOUT)
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
                    result = {"error": f"Malformed arguments for {function_name}: {exc}"}
                except Exception as exc:
                    result = {"error": f"Tool {function_name} failed: {exc}"}

                if not result.get("error") and result.get("requires_confirmation"):
                    action = create_pending(function_name, function_args, result)
                    yield {
                        "type": "pending_confirmation",
                        "action_id": action.action_id,
                        "name": function_name,
                        "args": function_args,
                        "preview": result,
                    }
                    return

            else:
                timeout_seconds = TOOL_TIMEOUTS.get(function_name, DEFAULT_TOOL_TIMEOUT)
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
                    result = {"error": f"Malformed arguments for {function_name}: {exc}"}
                except Exception as exc:
                    result = {"error": f"Tool {function_name} failed: {exc}"}

            print(f"[tool result] {function_name}: {result}")
            yield {
                "type": "tool_result",
                "name": function_name,
                "result": result,
            }
            tool_results.append({"name": function_name, "result": result})

        contents = provider.append_tool_results(contents, tool_results)

    yield {
        "type": "error",
        "message": "Model exceeded the maximum number of tool-calling rounds without producing a final response.",
    }
