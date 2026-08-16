"""Provider factory for Gemini, Ollama, Kilo, OpenAI, xAI, OpenRouter, and Anthropic."""

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import base as _base

from base import Provider, ProviderResponse, ToolCall
from security import set_project_root

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

SUPPORTED_PROVIDERS = [
    "gemini",
    "ollama",
    "kilo",
    "openai",
    "xai",
    "openrouter",
    "anthropic",
]


@dataclass
class ProviderConfig:
    provider: str
    model: str
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    timeout: int = 120

    def to_public_dict(self) -> dict:
        """Non-secret view of this config, safe to return over HTTP."""

        return {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "timeout": self.timeout,
        }


def load_provider_config(name: str) -> ProviderConfig:
    """Read environment variables for `name` into a ProviderConfig."""

    name = (name or "").lower()

    if name == "gemini":
        return ProviderConfig(
            provider="gemini",
            model=os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
            api_key=os.getenv("GOOGLE_API_KEY"),
        )
    if name == "ollama":
        base_url = os.getenv("OLLAMA_BASE_URL") or os.getenv("OLLAMA_HOST") or "http://localhost:11434/v1"
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
    if name == "openai":
        return ProviderConfig(
            provider="openai",
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            api_key=os.getenv("OPENAI_API_KEY"),
            timeout=int(os.getenv("OPENAI_TIMEOUT", "120")),
        )
    if name == "xai":
        return ProviderConfig(
            provider="xai",
            model=os.getenv("XAI_MODEL", "grok-4.6"),
            base_url=os.getenv("XAI_BASE_URL", "https://api.x.ai/v1"),
            api_key=os.getenv("XAI_API_KEY"),
            timeout=int(os.getenv("XAI_TIMEOUT", "120")),
        )
    if name == "openrouter":
        return ProviderConfig(
            provider="openrouter",
            model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
            base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            api_key=os.getenv("OPENROUTER_API_KEY"),
            timeout=int(os.getenv("OPENROUTER_TIMEOUT", "120")),
        )
    if name == "anthropic":
        return ProviderConfig(
            provider="anthropic",
            model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
            base_url=os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            api_key=os.getenv("ANTHROPIC_API_KEY"),
            timeout=int(os.getenv("ANTHROPIC_TIMEOUT", "120")),
        )

    raise RuntimeError(
        f"Unknown PROVIDER '{name}'. Expected one of: "
        f"{', '.join(SUPPORTED_PROVIDERS)}."
    )


def get_provider(name: str = None, model: str = None) -> Provider:
    """Build a Provider from environment configuration.

    A Settings Save request may include ``project_path``. The path is
    validated first, and only persisted after the requested provider is
    successfully constructed, so a failed provider change cannot leave
    the filesystem root partially updated.
    """

    pending_project_path = None

    try:
        from flask import has_request_context, request

        if has_request_context():
            payload = request.get_json(silent=True) or {}
            project_path = payload.get("project_path")
            if project_path is not None:
                if not str(project_path).strip():
                    raise ValueError("A project path is required.")
                pending_project_path = Path(project_path).expanduser().resolve()
                if not pending_project_path.exists():
                    raise ValueError(f"Project path does not exist: {pending_project_path}")
                if not pending_project_path.is_dir():
                    raise ValueError(f"Project path is not a directory: {pending_project_path}")
    except Exception as exc:
        if exc.__class__.__name__ not in {"RuntimeError", "ImportError"}:
            raise

    name = (name or os.getenv("PROVIDER", "gemini")).lower()
    config = load_provider_config(name)
    if model:
        config.model = model

    if config.provider == "gemini":
        from gemini import GeminiProvider
        provider = GeminiProvider(api_key=config.api_key, model=config.model)
    elif config.provider == "ollama":
        from ollama import OllamaProvider
        provider = OllamaProvider(base_url=config.base_url, model=config.model, timeout=config.timeout)
    elif config.provider == "kilo":
        from kilo import KiloProvider
        provider = KiloProvider(base_url=config.base_url, model=config.model, api_key=config.api_key, timeout=config.timeout)
    elif config.provider == "openai":
        from openai_provider import OpenAIProvider
        provider = OpenAIProvider(base_url=config.base_url, model=config.model, api_key=config.api_key, timeout=config.timeout)
    elif config.provider == "xai":
        from xai import XAIProvider
        provider = XAIProvider(base_url=config.base_url, model=config.model, api_key=config.api_key, timeout=config.timeout)
    elif config.provider == "openrouter":
        from openrouter import OpenRouterProvider
        provider = OpenRouterProvider(
            base_url=config.base_url,
            model=config.model,
            api_key=config.api_key,
            timeout=config.timeout,
            http_referer=os.getenv("OPENROUTER_HTTP_REFERER"),
            app_title=os.getenv("OPENROUTER_APP_TITLE"),
        )
    elif config.provider == "anthropic":
        from anthropic_provider import AnthropicProvider
        provider = AnthropicProvider(
            base_url=config.base_url,
            model=config.model,
            api_key=config.api_key,
            timeout=config.timeout,
            max_tokens=int(os.getenv("ANTHROPIC_MAX_TOKENS", "8192")),
        )
    else:
        raise RuntimeError(
            f"Unknown PROVIDER '{config.provider}'. Expected one of: "
            f"{', '.join(SUPPORTED_PROVIDERS)}."
        )

    if pending_project_path is not None:
        set_project_root(str(pending_project_path))

    provider.name = name
    provider.config = config
    return provider
