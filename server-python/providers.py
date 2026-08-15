"""Provider factory for Gemini, Ollama, and Kilo."""

import os
import sys
from dataclasses import dataclass
from typing import Optional

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
    "ProviderConfig",
    "SUPPORTED_PROVIDERS",
    "load_provider_config",
    "get_provider",
]

# Single source of truth for which PROVIDER values are valid — used
# both by get_provider()'s dispatch below and by app.py's /providers
# endpoint, so the two can never drift out of sync.
SUPPORTED_PROVIDERS = ["gemini", "ollama", "kilo"]


@dataclass
class ProviderConfig:
    """Resolved configuration for one provider, before construction.

    Every provider used to read its own environment variables inline
    inside get_provider()'s branches. This dataclass is the single
    place that knows *where configuration comes from*, so
    GeminiProvider, OllamaProvider, and KiloProvider can stay focused
    on talking to their backend rather than on os.getenv() calls.
    Adding a new provider means adding one branch to
    load_provider_config() instead of touching provider classes.
    """

    provider: str
    model: str
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    timeout: int = 120

    def to_public_dict(self) -> dict:
        """Non-secret view of this config, safe to return over HTTP.

        `api_key` is deliberately omitted entirely — never included,
        masked, or hashed — so this method can never become a leak
        vector for a Kilo/Gemini credential regardless of how the
        caller uses the result.
        """

        return {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "timeout": self.timeout,
        }


def load_provider_config(name: str) -> ProviderConfig:
    """Read environment variables for `name` into a ProviderConfig.

    Raises RuntimeError for an unknown provider name; individual
    provider constructors are still responsible for validating that
    required fields (e.g. a Kilo API key) are actually present.
    """

    name = (name or "").lower()

    if name == "gemini":
        return ProviderConfig(
            provider="gemini",
            model=os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
            api_key=os.getenv("GOOGLE_API_KEY"),
        )

    if name == "ollama":
        base_url = (
            os.getenv("OLLAMA_BASE_URL")
            or os.getenv("OLLAMA_HOST")
            or "http://localhost:11434/v1"
        )
        return ProviderConfig(
            provider="ollama",
            model=os.getenv("OLLAMA_MODEL", "llama3.1"),
            base_url=base_url,
            timeout=int(os.getenv("OLLAMA_TIMEOUT", "120")),
        )

    if name == "kilo":
        return ProviderConfig(
            provider="kilo",
            model=os.getenv("KILO_MODEL", "kilocode/kilo-auto/balanced"),
            base_url=os.getenv("KILO_BASE_URL", "https://api.kilo.ai/api/gateway"),
            api_key=os.getenv("KILO_API_KEY"),
            timeout=int(os.getenv("KILO_TIMEOUT", "120")),
        )

    raise RuntimeError(
        f"Unknown PROVIDER '{name}'. Expected one of: "
        f"{', '.join(SUPPORTED_PROVIDERS)}."
    )


def get_provider(name: str = None, model: str = None) -> Provider:
    """Build a Provider from environment configuration.

    `model` optionally overrides the model that would otherwise come
    from the environment — used by the /providers/select endpoint so
    a user can switch models without restarting the server.
    """

    name = (name or os.getenv("PROVIDER", "gemini")).lower()
    config = load_provider_config(name)
    if model:
        config.model = model

    if config.provider == "gemini":
        from gemini import GeminiProvider
        provider = GeminiProvider(api_key=config.api_key, model=config.model)

    elif config.provider == "ollama":
        from ollama import OllamaProvider
        provider = OllamaProvider(
            base_url=config.base_url,
            model=config.model,
            timeout=config.timeout,
        )

    elif config.provider == "kilo":
        from kilo import KiloProvider
        provider = KiloProvider(
            base_url=config.base_url,
            model=config.model,
            api_key=config.api_key,
            timeout=config.timeout,
        )

    else:
        # load_provider_config() already validates this, so this
        # branch only guards against future drift between the two.
        raise RuntimeError(
            f"Unknown PROVIDER '{config.provider}'. Expected one of: "
            f"{', '.join(SUPPORTED_PROVIDERS)}."
        )

    # Tag the instance with the name and resolved config it came from
    # so callers (e.g. the /providers endpoint) can report status
    # without re-deriving it from the environment themselves.
    provider.name = name
    provider.config = config
    return provider
