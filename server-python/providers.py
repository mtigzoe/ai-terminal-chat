"""Provider factory for Gemini, Ollama, and Kilo."""

import os
import sys

import base as _base

from base import Provider, ProviderResponse, ToolCall

# Keep the existing provider modules compatible with their
# `from providers.base import ...` imports while providers.py is a
# module rather than a package.
sys.modules.setdefault("providers.base", _base)

__all__ = [
    "Provider",
    "ProviderResponse",
    "ToolCall",
    "SUPPORTED_PROVIDERS",
    "get_provider",
]

# Single source of truth for which PROVIDER values are valid — used
# both by get_provider()'s dispatch below and by app.py's /providers
# endpoint, so the two can never drift out of sync.
SUPPORTED_PROVIDERS = ["gemini", "ollama", "kilo"]


def get_provider(name: str = None) -> Provider:
    name = (name or os.getenv("PROVIDER", "gemini")).lower()

    if name == "gemini":
        from gemini import GeminiProvider
        provider = GeminiProvider()

    elif name == "ollama":
        from ollama import OllamaProvider

        ollama_url = (
            os.getenv("OLLAMA_BASE_URL")
            or os.getenv("OLLAMA_HOST")
            or "http://localhost:11434/v1"
        )
        provider = OllamaProvider(
            base_url=ollama_url,
            model=os.getenv("OLLAMA_MODEL", "llama3.1"),
            timeout=int(os.getenv("OLLAMA_TIMEOUT", "120")),
        )

    elif name == "kilo":
        from kilo import KiloProvider
        provider = KiloProvider(
            base_url=os.getenv("KILO_BASE_URL", "https://api.kilo.ai/api/gateway"),
            model=os.getenv("KILO_MODEL", "kilocode/kilo-auto/balanced"),
            api_key=os.getenv("KILO_API_KEY"),
            timeout=int(os.getenv("KILO_TIMEOUT", "120")),
        )

    else:
        raise RuntimeError(
            f"Unknown PROVIDER '{name}'. Expected one of: "
            f"{', '.join(SUPPORTED_PROVIDERS)}."
        )

    # Tag the instance with the name it was resolved from so callers
    # (e.g. the /providers endpoint) can report "current" without
    # re-deriving it from the environment themselves.
    provider.name = name
    return provider
