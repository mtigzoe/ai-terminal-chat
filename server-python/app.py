# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0

"""Flask HTTP layer for the provider-agnostic terminal agent."""

import os

from concurrent.futures import TimeoutError as FutureTimeoutError
from dotenv import load_dotenv
from flask import Flask, Response, request, stream_with_context
from flask_cors import CORS

from agent import run_agent_loop
from pending import get_pending, pop_pending
from providers import SUPPORTED_PROVIDERS, get_provider
from security import PROJECT_ROOT, is_sensitive_filename, safe_path  # noqa: F401
from tools import (
    TOOL_EXECUTOR,
    TOOL_FUNCTIONS,
    TOOL_TIMEOUTS,
    DEFAULT_TOOL_TIMEOUT,
    WRITE_TOOL_NAMES,
    is_command_allowed,
    run_command,
)  # noqa: F401

load_dotenv()
provider = get_provider()

app = Flask(__name__)
CORS(app)


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    print(f"[Unhandled error] {exc}")
    return {"text": "", "error": f"Unexpected server error: {exc}"}, 500


@app.route("/providers", methods=["GET"])
def providers():
    """Report the active provider and supported provider names."""

    return {
        "current": getattr(provider, "name", None),
        "providers": SUPPORTED_PROVIDERS,
    }


@app.route("/confirm", methods=["POST"])
def confirm_action():
    """Explicitly approve or reject a pending model write operation.

    The model never receives a way to set confirm=True. Only this HTTP
    endpoint can consume a pending action and execute its exact stored
    arguments with confirmation enabled.
    """

    data = request.get_json(silent=True) or {}
    action_id = str(data.get("action_id", "")).strip()
    confirmed = data.get("confirmed")

    if not action_id:
        return {"error": "action_id is required."}, 400

    if confirmed is not True:
        action = pop_pending(action_id)
        if action is None:
            return {"error": "Pending action not found or already resolved."}, 404
        return {
            "confirmed": False,
            "action_id": action_id,
            "cancelled": True,
        }

    action = pop_pending(action_id)
    if action is None:
        return {"error": "Pending action not found or already resolved."}, 404

    if action.tool_name not in WRITE_TOOL_NAMES:
        return {"error": "Only pending write actions can be confirmed."}, 400

    function = TOOL_FUNCTIONS.get(action.tool_name)
    if function is None:
        return {"error": f"Tool no longer exists: {action.tool_name}"}, 500

    args = dict(action.args)
    args["confirm"] = True
    timeout_seconds = TOOL_TIMEOUTS.get(action.tool_name, DEFAULT_TOOL_TIMEOUT)
    future = TOOL_EXECUTOR.submit(function, **args)

    try:
        result = future.result(timeout=timeout_seconds)
    except FutureTimeoutError:
        return {
            "error": (
                f"Tool {action.tool_name} exceeded its "
                f"{timeout_seconds}s execution limit."
            )
        }, 504
    except Exception as exc:
        return {"error": f"Tool {action.tool_name} failed: {exc}"}, 500

    if isinstance(result, dict) and result.get("error"):
        return {
            "confirmed": True,
            "action_id": action_id,
            "tool": action.tool_name,
            "result": result,
        }, 400

    return {
        "confirmed": True,
        "action_id": action_id,
        "tool": action.tool_name,
        "result": result,
    }


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    msg = data.get("chat", "")
    history = data.get("history", [])

    if not msg or not str(msg).strip():
        return {"text": "", "error": "Message must not be empty."}, 400

    try:
        contents = provider.build_contents(msg, history)
    except Exception as exc:
        return {
            "text": "",
            "error": f"Could not process conversation history: {exc}",
        }, 400

    tool_activity = []
    final_text = ""
    error_message = None

    try:
        for event in run_agent_loop(provider, contents):
            if event["type"] == "tool_call":
                tool_activity.append({
                    "type": "tool_call",
                    "name": event["name"],
                    "args": event["args"],
                })
            elif event["type"] == "tool_result":
                tool_activity.append({
                    "type": "tool_result",
                    "name": event["name"],
                    "result": event["result"],
                })
            elif event["type"] == "pending_confirmation":
                tool_activity.append(event)
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

    return {"text": final_text, "tool_activity": tool_activity}


@app.route("/stream", methods=["POST"])
def stream():
    """Stream agent activity and the final response as plain text."""

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
            contents = provider.build_contents(msg, history)
        except Exception as exc:
            yield f"[Error building request: {exc}]"
            return

        try:
            for event in run_agent_loop(provider, contents):
                if event["type"] == "tool_call":
                    yield f"\n⚙️ {event['name']}({format_args(event['args'])})\n"
                elif event["type"] == "tool_result":
                    result = event["result"]
                    if isinstance(result, dict) and result.get("error"):
                        yield f"⚠️ {event['name']}: {result['error']}\n"
                elif event["type"] == "pending_confirmation":
                    yield (
                        f"\n[Confirmation required: {event['name']} "
                        f"action_id={event['action_id']}]\n"
                    )
                elif event["type"] == "final":
                    yield event["text"]
                elif event["type"] == "error":
                    yield f"\n[Error: {event['message']}]"
        except Exception as exc:
            yield f"\n[Error: {exc}]"

    return Response(stream_with_context(generate()), mimetype="text/plain")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "9000"))
    app.run(host="127.0.0.1", port=port)
