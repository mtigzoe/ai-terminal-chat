"""Dedicated OpenAI provider.

OpenAI exposes the standard OpenAI-compatible `/v1/chat/completions`
API. This adapter keeps OpenAI-specific configuration, authentication,
and diagnostics separate from the generic OpenAI-compatible
implementation while reusing all chat, tool-calling, and listing logic.
"""

from typing import Optional

from openai_compatible import OpenAICompatibleProvider
from providers.base import ProviderCapabilities

DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"


class OpenAIProvider(OpenAICompatibleProvider):
    """OpenAI API provider using the OpenAI-compatible chat interface."""

    def __init__(
        self,
        base_url: str = DEFAULT_OPENAI_BASE_URL,
        model: str = DEFAULT_OPENAI_MODEL,
        api_key: Optional[str] = None,
        timeout: int = 120,
    ):
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY is not set. Add it to your .env file."
            )

        super().__init__(
            base_url=base_url or DEFAULT_OPENAI_BASE_URL,
            model=model or DEFAULT_OPENAI_MODEL,
            api_key=api_key,
            timeout=timeout,
            local=False,
            requires_api_key=True,
            display_name="OpenAI",
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
            f"Could not reach OpenAI at {self.base_url}. "
            "Check your network connection, OPENAI_BASE_URL, and OPENAI_API_KEY. "
            f"{exc}"
        )
