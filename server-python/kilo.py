"""Dedicated Kilo Gateway provider.

Kilo's gateway exposes an OpenAI-compatible API. This adapter keeps
Kilo-specific configuration, authentication, probing, and model
listing separate from the generic OpenAI-compatible implementation.
"""

from typing import Optional

from openai_compatible import OpenAICompatibleProvider
from providers.base import ProviderCapabilities


class KiloProvider(OpenAICompatibleProvider):
    """Kilo Gateway provider using the OpenAI-compatible API."""

    def __init__(
        self,
        base_url: str = "https://api.kilo.ai/api/gateway",
        model: str = "kilocode/kilo-auto/balanced",
        api_key: Optional[str] = None,
        timeout: int = 120,
    ):
        if not api_key:
            raise RuntimeError(
                "KILO_API_KEY is not set. Add it to your .env file."
            )

        super().__init__(
            base_url=base_url,
            model=model,
            api_key=api_key,
            timeout=timeout,
            local=False,
            requires_api_key=True,
            display_name="Kilo",
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
            f"Could not reach Kilo Gateway at {self.base_url}. "
            "Check your network connection, KILO_BASE_URL, and KILO_API_KEY. "
            f"{exc}"
        )
