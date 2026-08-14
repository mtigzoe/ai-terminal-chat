"""Provider factory.

Set PROVIDER=gemini (default), ollama, or kilo in .env to pick a
backend. Each branch below only reads the env vars it needs, and the
corresponding provider module is only imported once selected.
"""

import os

from base import Provider, ProviderResponse, ToolCall

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
            raise RuntimeError(
                "KILO_API_KEY is not set. Add it to your .env file."
            )
        return OpenAICompatibleProvider(
            base_url=os.getenv("KILO_BASE_URL", "https://api.kilo.ai/api/gateway"),
            model=os.getenv("KILO_MODEL", "kilocode/kilo-auto/balanced"),
            api_key=api_key,
        )

    raise RuntimeError(
        f"Unknown PROVIDER '{name}'. Expected one of: gemini, ollama, kilo."
    )
