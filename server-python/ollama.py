"""Dedicated Ollama provider.

Uses Ollama's native HTTP API for health, model listing, and
capability detection (`/api/tags`, `/api/show`, `/api/version`,
`/api/chat`). Chat completions stay on the OpenAI-compatible
`/v1/chat/completions` path so tool-call ids match the rest of
the OpenAI-compatible adapter.

The constructor never contacts the network, so the app can start
offline even when `ollama serve` is not running.
"""

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
            return {"available": False, "error": str(exc)}

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

        detected = self.capabilities_for_model(self.model)
        self._capabilities = detected
        return self._capabilities

    def generate(self, contents):
        # Detect capabilities on first generate so a no-tools model
        # never receives a `tools` array that would 400 the request.
        if not self._capabilities.notes and self._capabilities.tools:
            self.refresh_capabilities()
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
            raise
