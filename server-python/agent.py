"""Provider-agnostic tool-calling loop.

This is the same loop that used to be run_agent_loop() in app.py,
with every Gemini-specific line replaced by a call through the
Provider interface (providers/base.py) — the control flow, the
stuck-loop detection, and the per-tool timeout handling are all
unchanged.
"""

from concurrent.futures import TimeoutError as FutureTimeoutError

from providers.base import Provider
from tools import DEFAULT_TOOL_TIMEOUT, TOOL_EXECUTOR, TOOL_FUNCTIONS, TOOL_TIMEOUTS

MAX_TOOL_ROUNDS = 10

# A model that's stuck tends to call the exact same tool with the
# exact same arguments over and over with nothing else happening in
# between. We only flag *consecutive* identical calls (interleaving a
# different call, e.g. checking git_status between several edits,
# resets the counter) so legitimate repeated inspection isn't blocked.
MAX_CONSECUTIVE_IDENTICAL_CALLS = 3
HARD_ABORT_CONSECUTIVE_CALLS = 6


def run_agent_loop(provider: Provider, contents: list):
    """Run `provider` and explicitly execute any tools it requests.

    This is a generator so both /chat and /stream can share one
    implementation of the loop:

        provider.generate(contents)
          |
          v
        tool call(s)?  --no--> yield final text, done
          | yes
          v
        Python executes each tool, bounded by a per-tool timeout
        (yielding tool_call/tool_result events as it goes)
          |
          v
        tool results sent back via provider.append_tool_results()
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
            response = provider.generate(contents)
        except Exception as exc:
            yield {
                "type": "error",
                "message": f"{type(provider).__name__} error: {exc}",
            }
            return

        # Provider has produced its final answer: no more tool calls.
        if not response.tool_calls:
            if not response.text:
                yield {
                    "type": "error",
                    "message": (
                        "Model returned no text and requested no "
                        "further tools."
                    ),
                }
                return

            yield {"type": "final", "text": response.text}
            return

        # Preserve the model's function-call message.
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
                    "error": f"Unknown tool requested: {function_name}"
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
                    result = {"error": f"Tool {function_name} failed: {exc}"}

            print(f"[tool result] {function_name}: {result}")

            yield {
                "type": "tool_result",
                "name": function_name,
                "result": result,
            }

            tool_results.append({"name": function_name, "result": result})

        # Send the actual local tool results back to the provider.
        contents = provider.append_tool_results(contents, tool_results)

    yield {
        "type": "error",
        "message": (
            "Model exceeded the maximum number of tool-calling "
            "rounds without producing a final response."
        ),
    }
