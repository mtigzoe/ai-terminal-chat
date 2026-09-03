"""Dedicated Ollama provider.

Uses Ollama's native HTTP API for health, model listing, and
capability detection (`/api/tags`, `/api/show`, `/api/version`,
`/api/chat`). Chat completions stay on the OpenAI-compatible
`/v1/chat/completions` path so tool-call ids match the rest of
the OpenAI-compatible adapter.

The constructor never contacts the network, so the app can start
offline even when `ollama serve` is not running.
"""

import platform
import re
import shutil
import subprocess
from dataclasses import replace
from typing import Optional
from urllib.parse import urlparse

import requests

from openai_compatible import (
    OpenAICompatibleProvider,
    looks_like_tools_unsupported,
)
from providers.base import ProviderCapabilities


def native_and_openai_urls(base_url: str) -> tuple[str, str]:
    """Split an Ollama URL into native (`:11434`) and `/v1` forms."""

    url = (base_url or "").strip().rstrip("/")
    if not url:
        url = "http://localhost:11434"

    if url.endswith("/v1"):
        native = url[:-3].rstrip("/") or url
        openai = url
    else:
        native = url
        openai = f"{url}/v1"

    return native, openai


def is_local_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def model_ids_match(requested: str, installed: str) -> bool:
    """True when an installed Ollama tag satisfies the configured model.

    Ollama accepts both short names (``llama3.1``) and full tags
    (``llama3.1:latest``). Treat a bare name as matching the same
    name with the default ``:latest`` tag, and vice versa.
    """

    req = (requested or "").strip().lower()
    inst = (installed or "").strip().lower()
    if not req or not inst:
        return False
    if req == inst:
        return True
    if ":" not in req and inst == f"{req}:latest":
        return True
    if ":" not in inst and req == f"{inst}:latest":
        return True
    return False


# Ollama model names look like ``llama3.1``, ``llama3.1:8b``, or
# ``myuser/mymodel:tag``. Restrict to that shape so a value coming from
# the Settings UI can never be smuggled in as a CLI flag or option.
_SAFE_MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$")


def is_ollama_cli_installed() -> bool:
    """True if the `ollama` executable is recognized on this machine's PATH.

    This checks the CLI binary itself — the same thing a user would learn
    by typing `ollama` at a terminal prompt — which is distinct from
    :meth:`OllamaProvider.probe`, which checks whether the background
    server (`ollama serve`) is reachable over HTTP. The CLI can be
    installed with the server not yet started, so the two checks answer
    different questions.
    """

    return shutil.which("ollama") is not None


def launch_ollama_run(model: str) -> dict:
    """Start `ollama run <model>` in the background, without blocking.

    This is what the Settings page's "Run Ollama" button calls so a user
    never has to type `ollama run <model>` into a terminal themselves.
    `ollama run` pulls the model if needed, starts the server if it isn't
    already running, and then drops into an interactive chat — it does
    not exit on its own — so this launches it as a detached process
    rather than waiting for it to finish.

    On Windows it opens in its own console window so pull/startup
    progress stays visible, mirroring what the user would see if they
    ran the command themselves. Elsewhere it runs fully detached in the
    background, since there is no single cross-platform way to open a
    new terminal window.
    """

    model = (model or "").strip()
    if not model:
        return {"error": "A model name is required."}
    if not _SAFE_MODEL_NAME.match(model):
        return {"error": f"'{model}' is not a valid Ollama model name."}
    if not is_ollama_cli_installed():
        return {
            "error": (
                "The `ollama` command was not found on PATH. Install "
                "Ollama first, then try again."
            )
        }

    try:
        if platform.system() == "Windows":
            process = subprocess.Popen(
                ["ollama", "run", model],
                creationflags=subprocess.CREATE_NEW_CONSOLE,
            )
        else:
            process = subprocess.Popen(
                ["ollama", "run", model],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
    except FileNotFoundError:
        return {
            "error": (
                "The `ollama` command was not found on PATH. Install "
                "Ollama first, then try again."
            )
        }
    except OSError as exc:
        return {"error": f"Could not start `ollama run {model}`: {exc}"}

    return {"started": True, "model": model, "pid": process.pid}


class OllamaProvider(OpenAICompatibleProvider):
    """Ollama local server with native catalog and capability APIs."""

    def __init__(
        self,
        base_url: str = "http://localhost:11434/v1",
        model: str = "llama3.1",
        api_key: Optional[str] = None,
        timeout: int = 120,
    ):
        native, openai = native_and_openai_urls(base_url)
        self.native_base_url = native
        super().__init__(
            base_url=openai,
            model=model,
            api_key=api_key,
            timeout=timeout,
            local=True,
            requires_api_key=False,
            display_name="Ollama",
            capabilities=ProviderCapabilities(
                tools=True,
                streaming=True,
                model_listing=True,
                requires_api_key=False,
                local=True,
            ),
        )

    def _unreachable_message(self, exc: Exception) -> str:
        hint = ""
        if is_local_url(self.native_base_url):
            hint = " Is Ollama running? Start it with `ollama serve`."
        return (
            f"Could not reach Ollama at {self.native_base_url}.{hint} {exc}"
        ).strip()

    def _missing_model_message(self, model: str = None) -> str:
        name = model or self.model
        return (
            f"Ollama is reachable at {self.native_base_url}, but model "
            f"'{name}' is not installed. Pull it with `ollama pull {name}` "
            "or choose an installed model in Settings."
        )

    def _native_request(self, method: str, path: str, **kwargs):
        kwargs.setdefault("headers", self._headers())
        kwargs.setdefault("timeout", min(self.timeout, 10))
        url = f"{self.native_base_url}{path}"
        try:
            return requests.request(method, url, **kwargs)
        except requests.RequestException as exc:
            raise RuntimeError(self._unreachable_message(exc)) from exc

    def probe(self) -> dict:
        try:
            response = self._native_request("GET", "/api/tags")
            if response.status_code < 400:
                return {"available": True, "error": None}
            return {
                "available": False,
                "error": (
                    f"Ollama returned HTTP {response.status_code} "
                    f"from {self.native_base_url}/api/tags."
                ),
            }
        except Exception as exc:
            # See OpenAICompatibleProvider.probe() for why this routes
            # through _unreachable_message() rather than str(exc).
            message = str(exc)
            if not message.startswith("Could not reach Ollama"):
                message = self._unreachable_message(exc)
            return {"available": False, "error": message}

    def list_models(self) -> list:
        try:
            response = self._native_request("GET", "/api/tags")
            response.raise_for_status()
            data = response.json()
        except Exception:
            return []

        models = []
        for item in data.get("models") or []:
            if not isinstance(item, dict):
                continue
            model_id = item.get("name") or item.get("model")
            if not model_id:
                continue
            models.append({
                "id": model_id,
                "size": item.get("size"),
                "digest": item.get("digest"),
                "details": item.get("details") or {},
            })
        return models

    def has_model(self, model: str = None) -> bool:
        """Return True if the configured (or given) model is installed."""

        target = model or self.model
        for item in self.list_models():
            if model_ids_match(target, item.get("id") or ""):
                return True
        return False

    def show_model(self, model: str = None) -> dict:
        """Return `/api/show` data for a model, or {} if unavailable."""

        try:
            response = self._native_request(
                "POST",
                "/api/show",
                json={"model": model or self.model},
                timeout=min(self.timeout, 15),
            )
            if response.status_code >= 400:
                return {}
            data = response.json()
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def capabilities_for_model(self, model: str = None) -> ProviderCapabilities:
        info = self.show_model(model)
        raw = info.get("capabilities")
        notes = []

        if raw is None:
            # Older Ollama builds omit the field. Keep optimistic
            # defaults so a capable model is not silently downgraded.
            return replace(
                self._capabilities,
                notes="",
            )

        flags = {str(item).lower() for item in raw} if isinstance(raw, list) else set()
        tools = "tools" in flags
        completion = "completion" in flags or not flags
        if not tools:
            notes.append(
                f"Model {model or self.model} does not advertise tool "
                "calling. Chat will run without project tools."
            )
        if not completion:
            notes.append(
                f"Model {model or self.model} does not advertise chat "
                "completion support."
            )

        return ProviderCapabilities(
            tools=tools,
            streaming=True,
            model_listing=True,
            requires_api_key=False,
            local=True,
            notes=" ".join(notes),
        )

    def refresh_capabilities(self) -> ProviderCapabilities:
        probe = self.probe()
        if not probe["available"]:
            self._capabilities = replace(
                self._capabilities,
                notes=probe["error"] or "Ollama is not reachable.",
            )
            return self._capabilities

        installed = self.list_models()
        if not installed:
            self._capabilities = replace(
                self._capabilities,
                notes=(
                    f"Ollama is reachable at {self.native_base_url}, but no "
                    "models are installed. Pull one with `ollama pull "
                    f"{self.model}` (or another model name) and select it "
                    "in Settings."
                ),
            )
            return self._capabilities

        if not any(model_ids_match(self.model, item.get("id") or "") for item in installed):
            self._capabilities = replace(
                self._capabilities,
                notes=self._missing_model_message(),
            )
            return self._capabilities

        detected = self.capabilities_for_model(self.model)
        self._capabilities = detected
        return self._capabilities

    def generate(self, contents):
        # Detect capabilities on first generate so a no-tools model
        # never receives a `tools` array that would 400 the request.
        if not self._capabilities.notes and self._capabilities.tools:
            self.refresh_capabilities()

        # Surface a missing-model error before the OpenAI-compatible
        # path produces a less actionable HTTP 404 from /v1.
        if self._capabilities.notes and "is not installed" in self._capabilities.notes:
            raise RuntimeError(self._capabilities.notes)
        if self._capabilities.notes and "no models are installed" in self._capabilities.notes:
            raise RuntimeError(self._capabilities.notes)

        try:
            return super().generate(contents)
        except Exception as exc:
            if self._capabilities.tools and looks_like_tools_unsupported(exc):
                self._capabilities = replace(
                    self._capabilities,
                    tools=False,
                    notes=(
                        f"Ollama model {self.model} rejected tool calling. "
                        "Continuing in chat-only mode."
                    ),
                )
                return super().generate(contents)

            message = str(exc).lower()
            if (
                "not found" in message
                or ("model" in message and ("pull" in message or "404" in message))
            ):
                raise RuntimeError(self._missing_model_message()) from exc
            raise
