#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0

"""Flask HTTP layer for the provider-agnostic terminal agent."""

import json
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
from security import (
    PROJECT_ROOT,
    clear_allowed_read_paths,
    get_project_root,
    is_sensitive_filename,
    load_provider_selection,
    persist_provider_selection,
    safe_path,
    set_allowed_read_paths,
    set_project_root,
)
from tools import (
    TOOL_EXECUTOR,
    TOOL_FUNCTIONS,
    TOOL_TIMEOUTS,
    DEFAULT_TOOL_TIMEOUT,
    GIT_CONFIRM_TOOL_NAMES,
    WRITE_TOOL_NAMES,
    add_allowed_command,
    get_allowed_commands,
    is_command_allowed,
    list_files,
    read_file,
    remove_allowed_command,
    run_command,
)

load_dotenv()
_provider_lock = Lock()
try:
    _saved = load_provider_selection()
except Exception:
    _saved = {}

if _saved.get("provider"):
    try:
        provider = get_provider(_saved["provider"], model=_saved.get("model"))
    except Exception:
        provider = get_provider()
else:
    provider = get_provider()

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
    target = target or provider
    config = getattr(target, "provider_config", None)
    status = {
        "name": getattr(target, "name", None),
        "model": getattr(target, "model", None),
        "capabilities": target.capabilities.to_dict(),
    }
    if config is not None:
        status["base_url"] = config.to_public_dict().get("base_url")
    if probe:
        if getattr(target.capabilities, "local", False):
            try:
                target.refresh_capabilities()
                status["capabilities"] = target.capabilities.to_dict()
            except Exception:
                pass
        probe_result = target.probe()
        status["available"] = probe_result["available"]
        status["error"] = probe_result["error"]
        if not probe_result["available"]:
            status["diagnostics"] = _diagnostics(target, probe_result["error"])
        elif status["capabilities"].get("notes"):
            status["error"] = status["capabilities"]["notes"]
    return status


def _diagnostics(target, error: str) -> dict:
    config = getattr(target, "provider_config", None)
    native_url = getattr(target, "native_base_url", None)
    server_url = native_url or (getattr(config, "base_url", None) if config else None)
    causes = [f"{getattr(target, 'display_name', target.name)} is not running"]
    if bool(target.capabilities.local):
        causes.extend([
            "The host running it is unreachable from this machine",
            "The port is blocked by a firewall",
            "The configured server URL/host environment variable is incorrect",
        ])
        if getattr(target, "display_name", "") == "Ollama":
            causes.append("Start the server with `ollama serve`")
    else:
        causes.extend(["The API key is missing, revoked, or incorrect", "The network connection is down"])
    return {"provider": getattr(target, "display_name", getattr(target, "name", None)), "server": server_url, "model": getattr(target, "model", None), "possible_causes": causes, "detail": error}


@app.route("/providers", methods=["GET"])
def providers():
    probe = request.args.get("probe", "1") != "0"
    status = _provider_status(probe=probe)
    status["current"] = status["name"]
    status["providers"] = SUPPORTED_PROVIDERS
    return status


@app.route("/project-root", methods=["GET", "POST"])
def project_root():
    if request.method == "GET":
        return {"path": str(get_project_root())}
    data = request.get_json(silent=True) or {}
    path = str(data.get("path", "")).strip()
    try:
        root = set_project_root(path)
    except ValueError as exc:
        return {"error": str(exc)}, 400
    except OSError as exc:
        return {"error": f"Could not save project path: {exc}"}, 500
    return {"path": str(root)}


@app.route("/allowed-commands", methods=["GET", "POST"])
def allowed_commands():
    if request.method == "GET":
        return {"commands": get_allowed_commands()}
    data = request.get_json(silent=True) or {}
    prefix = str(data.get("command") or data.get("prefix") or "").strip()
    try:
        commands = add_allowed_command(prefix)
    except ValueError as exc:
        return {"error": str(exc)}, 400
    except OSError as exc:
        return {"error": f"Could not save allowed commands: {exc}"}, 500
    return {"commands": commands, "added": prefix}


@app.route("/allowed-commands/<path:command>", methods=["DELETE"])
def allowed_commands_delete(command):
    try:
        commands = remove_allowed_command(command)
    except ValueError as exc:
        return {"error": str(exc)}, 400
    except OSError as exc:
        return {"error": f"Could not save allowed commands: {exc}"}, 500
    return {"commands": commands, "removed": command}


@app.route("/providers/<name>/models", methods=["GET"])
def provider_models(name):
    name = (name or "").lower()
    if name not in SUPPORTED_PROVIDERS:
        return {"error": f"Unknown provider '{name}'. Expected one of: {', '.join(SUPPORTED_PROVIDERS)}."}, 404
    try:
        candidate = get_provider(name)
    except Exception as exc:
        return {"provider": name, "models": [], "error": str(exc)}, 200
    models = candidate.list_models()
    payload = {"provider": name, "supports_listing": candidate.capabilities.model_listing, "models": models}
    if getattr(candidate.capabilities, "local", False):
        probe = candidate.probe()
        payload["available"] = probe["available"]
        if not probe["available"]:
            payload["error"] = probe["error"] or f"{getattr(candidate, 'display_name', name)} is not reachable."
        elif not models:
            payload["error"] = f"{getattr(candidate, 'display_name', name)} is reachable but reports no installed models."
    return payload


@app.route("/providers/select", methods=["POST"])
def select_provider():
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
        return {"error": f"Unknown provider '{name}'. Expected one of: {', '.join(SUPPORTED_PROVIDERS)}."}, 400
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
    try:
        persist_provider_selection(name, model=model, ollama_base_url=data.get("ollama_base_url"))
    except Exception as exc:
        print(f"[Warning] Could not persist provider selection: {exc}")
    return _provider_status(probe=True)


@app.route("/cancel/<request_id>", methods=["POST"])
def cancel_request(request_id):
    cancelled = cancellation.cancel(request_id)
    return {"request_id": request_id, "cancelled": cancelled}


@app.route("/confirm", methods=["POST"])
def confirm_action():
    """Approve/reject a pending write or file-read permission request."""
    data = request.get_json(silent=True) or {}
    action_id = str(data.get("action_id", "")).strip()
    confirmed = data.get("confirmed")
    if not action_id:
        return {"error": "action_id is required."}, 400

    action = pop_pending(action_id) if confirmed is True else pop_pending(action_id)
    if action is None:
        return {"error": "Pending action not found or already resolved."}, 404

    if action.tool_name == "read_file_permission":
        if confirmed is True:
            path = action.args.get("path")
            return {
                "confirmed": True,
                "action_id": action_id,
                "tool": action.tool_name,
                "permission_granted": True,
                "path": path,
                "result": {
                    "permission_granted": True,
                    "path": path,
                    "message": f"Read access granted for '{path}'.",
                },
            }
        return {
            "confirmed": False,
            "action_id": action_id,
            "tool": action.tool_name,
            "permission_granted": False,
            "cancelled": True,
        }

    if confirmed is not True:
        return {"confirmed": False, "action_id": action_id, "cancelled": True}

    if action.tool_name not in WRITE_TOOL_NAMES and action.tool_name not in GIT_CONFIRM_TOOL_NAMES:
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
        return {"error": f"Tool {action.tool_name} exceeded its {timeout_seconds}s execution limit."}, 504
    except Exception as exc:
        return {"error": f"Tool {action.tool_name} failed: {exc}"}, 500
    if isinstance(result, dict) and result.get("error"):
        return {"confirmed": True, "action_id": action_id, "tool": action.tool_name, "result": result}, 400
    return {"confirmed": True, "action_id": action_id, "tool": action.tool_name, "result": result}


def _extract_allowed_paths(data: dict):
    if not isinstance(data, dict):
        return []
    raw = data.get("allowed_paths")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str) and item.strip()]


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
        return {"text": "", "error": f"Could not process conversation history: {exc}"}, 400
    tool_activity = []
    final_text = ""
    error_message = None
    cancelled = False
    cancel_event = cancellation.register(request_id)
    allowed_paths = _extract_allowed_paths(data)
    set_allowed_read_paths(allowed_paths)
    try:
        for event in run_agent_loop(provider, contents, cancel_event=cancel_event):
            if event["type"] == "progress":
                tool_activity.append({"type": "progress", "phase": event.get("phase"), "message": event.get("message"), "round": event.get("round"), "tool": event.get("tool")})
            elif event["type"] == "tool_call":
                tool_activity.append({"type": "tool_call", "name": event["name"], "args": event["args"]})
            elif event["type"] == "tool_result":
                tool_activity.append({"type": "tool_result", "name": event["name"], "result": event["result"]})
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
        clear_allowed_read_paths()
        cancellation.release(request_id)
    if cancelled:
        return {"text": final_text, "tool_activity": tool_activity, "cancelled": True, "request_id": request_id}
    if error_message and not final_text:
        return {"text": "", "error": error_message, "tool_activity": tool_activity, "request_id": request_id}, 502
    return {"text": final_text, "tool_activity": tool_activity, "request_id": request_id}


@app.route("/stream", methods=["POST"])
def stream():
    def generate():
        data = request.get_json(silent=True) or {}
        msg = data.get("chat", "")
        history = data.get("history", [])
        request_id = str(data.get("request_id") or uuid.uuid4().hex)
        if not msg or not str(msg).strip():
            yield json.dumps({"type": "text", "text": "Please enter a message."}) + "\n"
            return
        try:
            contents = provider.build_contents(msg, history)
        except Exception as exc:
            yield json.dumps({"type": "error", "message": f"Error building request: {exc}"}) + "\n"
            return
        cancel_event = cancellation.register(request_id)
        allowed_paths = _extract_allowed_paths(data)
        set_allowed_read_paths(allowed_paths)
        try:
            for event in run_agent_loop(provider, contents, cancel_event=cancel_event):
                yield json.dumps(_stream_event_to_plain(event)) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
        finally:
            clear_allowed_read_paths()
            cancellation.release(request_id)
    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")


def _stream_event_to_plain(event):
    etype = event.get("type")
    if etype == "progress":
        return {"type": "progress", "phase": event.get("phase", "progress"), "message": event.get("message", "")}
    if etype == "tool_call":
        return {
            "type": "tool_call",
            "name": event["name"],
            "args": event.get("args", {}),
        }
    if etype == "tool_result":
        result = event.get("result")
        if isinstance(result, dict) and result.get("error"):
            return {"type": "tool_result", "name": event["name"], "result": {"error": result["error"]}}
        return {"type": "tool_result", "name": event["name"], "result": result}
    if etype == "pending_confirmation":
        return {
            "type": "pending_confirmation",
            "action_id": event["action_id"],
            "name": event["name"],
            "args": event.get("args", {}),
            "preview": event.get("preview"),
        }
    if etype == "final":
        return {"type": "final", "text": event.get("text", "")}
    if etype == "error":
        return {"type": "error", "message": event.get("message", "")}
    if etype == "cancelled":
        return {"type": "cancelled"}
    return {"type": "progress", "phase": "progress", "message": ""}


@app.route("/project/list", methods=["GET"])
def project_list():
    path = request.args.get("path", ".") or "."
    result = list_files(path)
    if isinstance(result, dict) and result.get("error"):
        return result, 400
    return result


@app.route("/project/read", methods=["GET"])
def project_read():
    path = request.args.get("path", "") or ""
    if not str(path).strip():
        return {"error": "path is required."}, 400
    result = read_file(path)
    if isinstance(result, dict) and result.get("error"):
        status = 400
        err = str(result["error"]).lower()
        if "does not exist" in err:
            status = 404
        elif "refusing" in err or "outside" in err or "absolute" in err:
            status = 403
        return result, status
    return result


@app.route("/terminal/run", methods=["POST"])
def terminal_run():
    data = request.get_json(silent=True) or {}
    command = str(data.get("command", "")).strip()
    if not command:
        return {"error": "command is required."}, 400
    result = run_command(command)
    if isinstance(result, dict) and result.get("error"):
        return result, 400
    return result


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "9000"))
    app.run(host=host, port=port)
