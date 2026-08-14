"""Provider factory.

Set PROVIDER=gemini (default), ollama, or kilo in .env to pick a
backend. Each branch below only reads the env vars it needs, and the
corresponding provider module is only imported once selected — so,
for example, google-genai never has to be installed/importable if
you're only ever running with PROVIDER=ollama.
"""

import os

from providers.base import Provider, ProviderResponse, ToolCall

__all__ = ["Provider", "ProviderResponse", "ToolCall", "get_provider"]


def get_provider(name: str = None) -> Provider:
    name = (name or os.getenv("PROVIDER", "gemini")).lower()

    if name == "gemini":
        from providers.gemini import GeminiProvider

        return GeminiProvider()

    if name == "ollama":
        from providers.openai_compatible import OpenAICompatibleProvider

        return OpenAICompatibleProvider(
            base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
            model=os.getenv("OLLAMA_MODEL", "llama3.1"),
        )

    if name == "kilo":
        from providers.openai_compatible import OpenAICompatibleProvider

        api_key = os.getenv("KILO_API_KEY")

        if not api_key:
            raise RuntimeError(
                "KILO_API_KEY is not set. Add it to your .env file. "
                "Generate one at https://app.kilo.ai."
            )

        return OpenAICompatibleProvider(
            # Kilo's gateway (see https://kilo.ai/docs/gateway/api-reference)
            # base URL as of this writing — double-check it against
            # current docs if requests start failing.
            base_url=os.getenv("KILO_BASE_URL", "https://api.kilo.ai/api/gateway"),
            model=os.getenv("KILO_MODEL", "kilocode/kilo-auto/balanced"),
            api_key=api_key,
        )

    raise RuntimeError(
        f"Unknown PROVIDER '{name}'. Expected one of: gemini, ollama, kilo."
    )
