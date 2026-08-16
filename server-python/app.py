# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0

"""Flask HTTP layer for the provider-agnostic terminal agent."""

import os
import uuid

from concurrent.futures import TimeoutError as FutureTimeoutError
from threading import Lock

from dotenv import load_dotenv
from flask import Flask, Response, request, stream_with_context
from flask_cors import CORS

import cancellation
from agent import run_agent_loop
from pending import get_pending, pop_pending
from providers import SUPPORTED_PROVIDERS, get_provider
from security import PROJECT_ROOT, is_sensitive_filename, safe_path  # noqa: F401
from tools import (
    TOOL_EXECUTOR,
    TOOL_FUNCTIONS,
    TOOL_TIMEOUTS,
    DEFAULT_TOOL_TIMEOUT,
    GIT_CONFIRM_TOOL_NAMES,
    WRITE_TOOL_NAMES,
    is_command_allowed,
    run_command,
)  # noqa: F401

load_dotenv()
provider = get_provider()
_provider_lock = Lock()

API_KEY_ENV_VARS = {
    "gemini": "GOOGLE_API_KEY",
    "kilo": "KILO_API_KEY",
    "openai": "OPENAI_API_KEY",
    "xai": "XAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

app = Flask(__name__)
CORS(app)


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    print(f"[Unhandled error] {exc}")
    return {"text": "", "error": f"Unexpected server error: {exc}"}, 500


def _provider_status(target=None, probe: bool = True) -> dict:
    """Build the status payload for one provider instance.

    Never includes an api_key — ProviderConfig.to_public_dict() omits
    it entirely, and nothing below reads provider.api_key either, so
    this can't accidentally leak a Kilo/Gemini credential to the
    browser (see "Don't expose API keys to React" in the README).
    """

    target = target or provider
    config = getattr(target, "config", None)
    status = {
        "name": getattr(target, "name", None),
        "model": getattr(target, "model", None),
        "capabilities": target.capabilities.to_dict(),
    }
    if config is not None:
        status["base_url"] = config.to_public_dict().get("base_url")

    if probe:
        probe_result = target.probe()
        status["available"] = probe_result["available"]
        status["error"] = probe_result["error"]
        if not probe_result["available"]:
            status["diagnostics"] = _diagnostics(target, probe_result["error"])

    return status


def _diagnostics(target, error: str) -> dict:
    """Structured, actionable detail for an unreachable provider.

    Turns "Could not reach Ollama." into something a user can act on
    without inspecting server logs — useful for screen-reader users in
    particular, where a wall of log text is much harder to scan than a
    short list of concrete next steps.
    """

    config = getattr(target, "config", None)
    causes = [f"{getattr(target, 'display_name', target.name)} is not running"]

    is_local = bool(target.capabilities.local)
    if is_local:
        causes.append("The host running it is unreachable from this machine")
        causes.append("The port is blocked by a firewall")
        causes.append(
            "The configured server URL/host environment variable is incorrect"
        )
    else:
        causes.append("The API key is missing, revoked, or incorrect")
        causes.append("The network connection is down")

    return {
        "provider": getattr(target, "display_name", getattr(target, "name", None)),
        "server": getattr(config, "base_url", None),
        "model": getattr(target, "model", None),
        "possible_causes": causes,
        "detail": error,
    }


@app.route("/providers", methods=["GET"])
def providers():
    """Report the active provider's status and the supported provider names.

    Pass `?probe=0` to skip the network probe (faster, but `available`
    will be omitted) — useful for a UI that just wants to know what
    provider/model is currently selected.
    """

    probe = request.args.get("probe", "1") != "0"
    status = _provider_status(probe=probe)
    status["current"] = status["name"]
    status["providers"] = SUPPORTED_PROVIDERS
    return status


@app.route("/providers/<name>/models", methods=["GET"])
def provider_models(name):
    """List installed/available models for a provider, without switching to it.

    Builds a throwaway provider instance from the same environment
    configuration /providers/select would use, so the model list
    reflects the server the user would actually get if they switched.
    Returns an empty list (not an error) when the provider can't be
    reached or doesn't support listing — see Provider.list_models().
    """

    name = (name or "").lower()
    if name not in SUPPORTED_PROVIDERS:
        return {
            "error": (
                f"Unknown provider '{name}'. Expected one of: "
                f"{', '.join(SUPPORTED_PROVIDERS)}."
            )
        }, 404

    try:
        candidate = get_provider(name)
    except Exception as exc:
        return {"provider": name, "models": [], "error": str(exc)}, 200

    return {
        "provider": name,
        "supports_listing": candidate.capabilities.model_listing,
        "models": candidate.list_models(),
    }


@app.route("/providers/select", methods=["POST"])
def select_provider():
    """Switch the active provider, model, and optional API key.

    The browser can only *request* a provider by name. If an API key is
    supplied, it is applied only to the running local server process and
    is never returned by this endpoint. The key is not written to disk.
    """

    global provider

    data = request.get_json(silent=True) or {}
    name = str(data.get("provider", "")).strip().lower()
    model = data.get("model")
    model = str(model).strip() if model else None
    has_api_key = "api_key" in data
    api_key = str(data.get("api_key") or "").strip()

    if not name:
        return {"error": "provider is required."}, 400

    if name not in SUPPORTED_PROVIDERS:
        return {
            "error": (
                f"Unknown provider '{name}'. Expected one of: "
                f"{', '.join(SUPPORTED_PROVIDERS)}."
            )
        }, 400

    env_name = API_KEY_ENV_VARS.get(name)
    previous_api_key = os.environ.get(env_name) if env_name else None

    if has_api_key and env_name:
        if api_key:
            os.environ[env_name] = api_key
        else:
            os.environ.pop(env_name, None)

    try:
        candidate = get_provider(name, model=model)
    except Exception as exc:
        if has_api_key and env_name:
            if previous_api_key is None:
                os.environ.pop(env_name, None)
            else:
                os.environ[env_name] = previous_api_key
        return {"error": f"Could not switch to '{name}': {exc}"}, 400

    with _provider_lock:
        provider = candidate

    return _provider_status(probe=True)


@app.route("/cancel/<request_id>", methods=["POST"])
def cancel_request(request_id):
    """Cooperatively cancel an in-flight /chat or /stream request.

    See cancellation.py: this sets the request's cancellation event,
    which run_agent_loop checks between rounds and tool calls. A
    request the server never registered (already finished, or the
    client never sent a request_id) returns cancelled=False rather
    than an error — the client's own abort of the HTTP connection is
    still effective either way.
    """

    cancelled = cancellation.cancel(request_id)
    return {"request_id": request_id, "cancelled": cancelled}


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

    if (
        action.tool_name not in WRITE_TOOL_NAMES
        and action.tool_name not in GIT_CONFIRM_TOOL_NAMES
    ):
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
    request_id = str(data.get("request_id") or uuid.uuid4().hex)

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
    cancelled = False
    cancel_event = cancellation.register(request_id)

    try:
        for event in run_agent_loop(provider, contents, cancel_event=cancel_event):
            if event["type"] == "progress":
                tool_activity.append({
                    "type": "progress",
                    "phase": event.get("phase"),
                    "message": event.get("message"),
                    "round": event.get("round"),
                    "tool": event.get("tool"),
                })
            elif event["type"] == "tool_call":
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
            elif event["type"] == "cancelled":
                cancelled = True
    except Exception as exc:
        error_message = f"Unexpected server error: {exc}"
    finally:
        cancellation.release(request_id)

    if cancelled:
        return {
            "text": final_text,
            "tool_activity": tool_activity,
            "cancelled": True,
            "request_id": request_id,
        }

    if error_message and not final_text:
        return {
            "text": "",
            "error": error_message,
            "tool_activity": tool_activity,
            "request_id": request_id,
        }, 502

    return {
        "text": final_text,
        "tool_activity": tool_activity,
        "request_id": request_id,
    }


@app.route("/stream", methods=["POST"])
def stream():
    """Stream agent activity and the final response as plain text."""

    def format_args(args):
        return ", ".join(f"{k}={v!r}" for k, v in args.items())

    def generate():
        data = request.get_json(silent=True) or {}
        msg = data.get("chat", "")
        history = data.get("history", [])
        request_id = str(data.get("request_id") or uuid.uuid4().hex)

        if not msg or not str(msg).strip():
            yield "Please enter a message."
            return

        try:
            contents = provider.build_contents(msg, history)
        except Exception as exc:
            yield f"[Error building request: {exc}]"
            return

        cancel_event = cancellation.register(request_id)

        try:
            for event in run_agent_loop(provider, contents, cancel_event=cancel_event):
                if event["type"] == "progress":
                    # Plain-text progress for screen readers and terminals.
                    yield f"\n[{event.get('phase', 'progress')}] {event.get('message', '')}\n"
                elif event["type"] == "tool_call":
                    yield f"\n⚙️ {event['name']}({format_args(event['args'])})\n"
                elif event["type"] == "tool_result":
                    result = event["result"]
                    if isinstance(result, dict) and result.get("error"):
                        yield f"⚠️ {event['name']}: {result['error']}\n"
                elif event["type"] == "pending_confirmation":
                    yield (
                        f"\n[Confirmation required: {event['name']} "
                        f"action_id={event['action_id']}] "
                        f"Waiting for explicit user confirmation.\n"
                    )
                elif event["type"] == "final":
                    yield event["text"]
                elif event["type"] == "error":
                    yield f"\n[Error: {event['message']}]"
                elif event["type"] == "cancelled":
                    yield "\n[cancelled] Cancelled by user request.\n"
        except Exception as exc:
            yield f"\n[Error: {exc}]"
        finally:
            cancellation.release(request_id)

    return Response(stream_with_context(generate()), mimetype="text/plain")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "9000"))
    app.run(host="127.0.0.1", port=port)
