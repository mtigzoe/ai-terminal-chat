"""Dedicated NVIDIA NIM provider.

NVIDIA NIM exposes an OpenAI-compatible Chat Completions API at
https://integrate.api.nvidia.com/v1 (the API-catalog endpoint).
Authentication uses ``Authorization: Bearer $NVIDIA_API_KEY`` and model
identifiers are ``vendor/model`` slugs (e.g. ``meta/llama-3.1-8b-instruct``)
which must be passed through to NVIDIA unchanged.

This adapter keeps NVIDIA-specific configuration, authentication, and
diagnostics separate from the generic OpenAI-compatible implementation
while reusing all chat, tool-calling, and listing logic.
"""

from typing import Optional

from openai_compatible import OpenAICompatibleProvider
from providers.base import ProviderCapabilities

DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
# Model ids are vendor/model slugs from NVIDIA's catalog; users select any
# catalog id via NVIDIA_MODEL or /providers/select. Slugs pass through as-is.
DEFAULT_NVIDIA_MODEL = "meta/llama-3.1-8b-instruct"


class NVIDIAProvider(OpenAICompatibleProvider):
    """NVIDIA NIM provider using the OpenAI-compatible chat interface."""

    def __init__(
        self,
        base_url: str = DEFAULT_NVIDIA_BASE_URL,
        model: str = DEFAULT_NVIDIA_MODEL,
        api_key: Optional[str] = None,
        timeout: int = 120,
    ):
        if not api_key:
            raise RuntimeError(
                "NVIDIA_API_KEY is not set. Add it to your .env file."
            )

        # Preserve the selected model slug exactly (including characters
        # such as '/' in "meta/llama-3.1-8b-instruct"). Do not normalize.
        resolved_model = model if model is not None else DEFAULT_NVIDIA_MODEL
        if not str(resolved_model).strip():
            resolved_model = DEFAULT_NVIDIA_MODEL

        super().__init__(
            base_url=base_url or DEFAULT_NVIDIA_BASE_URL,
            model=resolved_model,
            api_key=api_key,
            timeout=timeout,
            local=False,
            requires_api_key=True,
            display_name="NVIDIA NIM",
            capabilities=ProviderCapabilities(
                tools=True,
                streaming=True,
                model_listing=True,
                requires_api_key=True,
                local=False,
                notes="Model ids are NVIDIA catalog vendor/model slugs.",
            ),
        )

    def _unreachable_message(self, exc: Exception) -> str:
        return (
            f"Could not reach NVIDIA NIM at {self.base_url}. "
            "Check your network connection, NVIDIA_BASE_URL, and "
            f"NVIDIA_API_KEY. {exc}"
        )
