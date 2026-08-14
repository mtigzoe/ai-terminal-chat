"""Provider factory for Gemini, Ollama, and Kilo."""

import os
import sys

import base as _base

from base import Provider, ProviderResponse, ToolCall

# Keep the existing provider modules compatible with their
# `from providers.base import ...` imports while providers.py is a
# module rather than a package.
sys.modules.setdefault("providers.base", _base)

__all__ = ["Provider", "ProviderResponse", "ToolCall", "get_provider"]


def get_provider(name: str = None) -> Provider:
    name = (name or os.getenv("PROVIDER", "gemini")).lower()

    if name == "gemini":
        from gemini import GeminiProvider
        return GeminiProvider()

    if name == "ollama":
        from openai_compatible import OpenAICompatibleProvider
        return OpenAICompatibleProvider(
            base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
            model=os.getenv("OLLAMA_MODEL", "llama3.1"),
        )

    if name == "kilo":
        from openai_compatible import OpenAICompatibleProvider
        api_key = os.getenv("KILO_API_KEY")
        if not api_key:
            raise RuntimeError("KILO_API_KEY is not set. Add it to your .env file.")
        return OpenAICompatibleProvider(
            base_url=os.getenv("KILO_BASE_URL", ""),
            model=os.getenv("KILO_MODEL", "kilocode/kilo-auto/balanced"),
            api_key=api_key,
        )

    raise RuntimeError(
        f"Unknown PROVIDER '{name}'. Expected one of: gemini, ollama, kilo."
    )
