"""Dedicated OpenRouter gateway provider.

OpenRouter is an OpenAI-compatible *gateway* to many upstream model
vendors behind a single API key and base URL
(https://openrouter.ai/api/v1). Model identifiers are opaque
``provider/model`` (or alias) slugs and must be passed through to
OpenRouter unchanged — this adapter never rewrites or validates slug
shape beyond what the factory already supplies.

Optional attribution headers (HTTP-Referer, X-Title) are configuration
only; they are never part of the agent/tool layer.
"""

from typing import Optional

from openai_compatible import OpenAICompatibleProvider
from providers.base import ProviderCapabilities

DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
# Sensible default slug; users select any OpenRouter catalog id via
# OPENROUTER_MODEL or /providers/select. Slugs are passed through as-is.
DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini"


class OpenRouterProvider(OpenAICompatibleProvider):
    """OpenRouter gateway using the OpenAI-compatible chat interface."""

    def __init__(
        self,
        base_url: str = DEFAULT_OPENROUTER_BASE_URL,
        model: str = DEFAULT_OPENROUTER_MODEL,
        api_key: Optional[str] = None,
        timeout: int = 120,
        http_referer: Optional[str] = None,
        app_title: Optional[str] = None,
    ):
        if not api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set. Add it to your .env file."
            )

        # Preserve the selected model slug exactly (including characters
        # such as '/' in "anthropic/claude-sonnet-4"). Do not normalize.
        resolved_model = model if model is not None else DEFAULT_OPENROUTER_MODEL
        if not str(resolved_model).strip():
            resolved_model = DEFAULT_OPENROUTER_MODEL

        super().__init__(
            base_url=base_url or DEFAULT_OPENROUTER_BASE_URL,
            model=resolved_model,
            api_key=api_key,
            timeout=timeout,
            local=False,
            requires_api_key=True,
            display_name="OpenRouter",
            capabilities=ProviderCapabilities(
                tools=True,
                streaming=True,
                model_listing=True,
                requires_api_key=True,
                local=False,
                notes="Gateway: model ids are upstream provider/model slugs.",
            ),
        )
        self.http_referer = (http_referer or "").strip() or None
        self.app_title = (app_title or "").strip() or None

    def _headers(self) -> dict:
        headers = super()._headers()
        # Optional OpenRouter attribution headers only — not used by agent.
        if self.http_referer:
            headers["HTTP-Referer"] = self.http_referer
        if self.app_title:
            headers["X-Title"] = self.app_title
        return headers

    def _unreachable_message(self, exc: Exception) -> str:
        return (
            f"Could not reach OpenRouter at {self.base_url}. "
            "Check your network connection, OPENROUTER_BASE_URL, and "
            f"OPENROUTER_API_KEY. {exc}"
        )
