"""Compatibility entry point with transactional provider selection.

The original Flask application lives in ``app_original`` so this module can
replace only the provider-selection endpoint without duplicating the rest of
the HTTP layer.
"""

import os
import sys
from types import ModuleType

import app_original as _original
from flask import request

app = _original.app
_provider_lock = _original._provider_lock
SUPPORTED_PROVIDERS = _original.SUPPORTED_PROVIDERS
API_KEY_ENV_VARS = _original.API_KEY_ENV_VARS
get_provider = _original.get_provider
persist_provider_selection = _original.persist_provider_selection
_provider_status = _original._provider_status
PROJECT_ROOT = _original.PROJECT_ROOT
get_project_root = _original.get_project_root
set_project_root = _original.set_project_root
provider = _original.provider


def _restore_provider_runtime_state(
    previous_provider,
    previous_api_key,
    env_name,
    previous_ollama_url,
    previous_project_root,
):
    """Restore every runtime value touched while building a candidate."""

    global provider

    if previous_ollama_url is None:
        os.environ.pop("OLLAMA_BASE_URL", None)
    else:
        os.environ["OLLAMA_BASE_URL"] = previous_ollama_url

    if env_name:
        if previous_api_key is None:
            os.environ.pop(env_name, None)
        else:
            os.environ[env_name] = previous_api_key

    # get_provider() may activate and persist a request's project_path before
    # returning its candidate. Restore the saved project root in both the
    # config file and the in-memory proxy when possible. A rollback error
    # must never hide the original provider-persistence failure.
    try:
        set_project_root(str(previous_project_root))
    except Exception as exc:
        print(f"[Warning] Could not restore project root after provider rollback: {exc}")
        try:
            PROJECT_ROOT.set(previous_project_root)
        except Exception:
            pass

    _original.provider = previous_provider
    provider = previous_provider


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
        return {
            "error": f"Unknown provider '{name}'. Expected one of: {', '.join(SUPPORTED_PROVIDERS)}."
        }, 400

    env_name = API_KEY_ENV_VARS.get(name)
    with _provider_lock:
        previous_provider = _original.provider
        previous_api_key = os.environ.get(env_name) if env_name else None
        previous_ollama_url = os.environ.get("OLLAMA_BASE_URL")
        previous_project_root = get_project_root()

        if has_api_key and env_name:
            if api_key:
                os.environ[env_name] = api_key
            else:
                os.environ.pop(env_name, None)

        try:
            candidate = get_provider(name, model=model)
        except Exception as exc:
            _restore_provider_runtime_state(
                previous_provider,
                previous_api_key,
                env_name,
                previous_ollama_url,
                previous_project_root,
            )
            return {"error": f"Could not switch to '{name}': {exc}"}, 400

        if name != "ollama":
            os.environ.pop("OLLAMA_BASE_URL", None)

        try:
            persist_provider_selection(
                name,
                model=model,
                ollama_base_url=data.get("ollama_base_url"),
            )
        except ValueError as exc:
            _restore_provider_runtime_state(
                previous_provider,
                previous_api_key,
                env_name,
                previous_ollama_url,
                previous_project_root,
            )
            return {"error": f"Could not switch to '{name}': {exc}"}, 400
        except Exception as exc:
            _restore_provider_runtime_state(
                previous_provider,
                previous_api_key,
                env_name,
                previous_ollama_url,
                previous_project_root,
            )
            return {"error": f"Could not switch to '{name}': {exc}"}, 500

        _original.provider = candidate
        provider = candidate

    return _provider_status(probe=True)


# Replace the original view function while retaining its existing URL rule.
app.view_functions["select_provider"] = select_provider


class _AppModule(ModuleType):
    """Keep provider assignment compatible with the original app module."""

    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        if name == "provider":
            _original.provider = value


sys.modules[__name__].__class__ = _AppModule


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "9000"))
    app.run(host=host, port=port)
