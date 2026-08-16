"""Dedicated xAI provider.

xAI exposes an OpenAI-compatible Chat Completions API at
https://api.x.ai/v1. This adapter keeps xAI-specific configuration,
authentication, and diagnostics separate from the generic
OpenAI-compatible implementation while reusing all chat, tool-calling,
and listing logic.

Grok is the model family; xAI is the provider identifier used
throughout this application (PROVIDER=xai, XAI_API_KEY, etc.).

Server-side xAI tools (web search, X search, code interpreter, and
other hosted tools) are intentionally not enabled. Tool execution
remains backend-controlled via this application's local tool layer.
"""

from typing import Optional

from openai_compatible import OpenAICompatibleProvider
from providers.base import ProviderCapabilities

DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1"
# Official flagship for coding and agentic tool calling (docs.x.ai, Aug 2026).
DEFAULT_XAI_MODEL = "grok-4.6"


class XAIProvider(OpenAICompatibleProvider):
    """xAI API provider using the OpenAI-compatible chat interface."""

    def __init__(
        self,
        base_url: str = DEFAULT_XAI_BASE_URL,
        model: str = DEFAULT_XAI_MODEL,
        api_key: Optional[str] = None,
        timeout: int = 120,
    ):
        if not api_key:
            raise RuntimeError(
                "XAI_API_KEY is not set. Add it to your .env file."
            )

        super().__init__(
            base_url=base_url or DEFAULT_XAI_BASE_URL,
            model=model or DEFAULT_XAI_MODEL,
            api_key=api_key,
            timeout=timeout,
            local=False,
            requires_api_key=True,
            display_name="xAI",
            capabilities=ProviderCapabilities(
                tools=True,
                streaming=True,
                model_listing=True,
                requires_api_key=True,
                local=False,
            ),
        )

    def _unreachable_message(self, exc: Exception) -> str:
        return (
            f"Could not reach xAI at {self.base_url}. "
            "Check your network connection, XAI_BASE_URL, and XAI_API_KEY. "
            f"{exc}"
        )
