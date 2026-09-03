"""Anthropic Messages API provider.

Unlike OpenAI, xAI, and OpenRouter, Anthropic uses a distinct
Messages API shape:

* POST /v1/messages with ``x-api-key`` and ``anthropic-version``
* ``system`` is a top-level field (not a message role)
* ``max_tokens`` is required
* tools use ``name`` / ``description`` / ``input_schema``
* tool calls are ``tool_use`` content blocks with ``id`` / ``name`` / ``input``
* tool results are ``tool_result`` content blocks with ``tool_use_id``

This adapter implements the shared Provider interface so agent.py
never sees those differences. Tool execution remains in the agent.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import requests

from prompts import CHAT_ONLY_INSTRUCTION, SYSTEM_INSTRUCTION
from providers.base import Provider, ProviderCapabilities, ProviderResponse, ToolCall
from tools import TOOL_SCHEMAS

DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"
DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MAX_TOKENS = 8192


def _build_tools() -> list:
    """Map shared TOOL_SCHEMAS into Anthropic tool definitions."""

    return [
        {
            "name": name,
            "description": schema["description"],
            "input_schema": schema["parameters"],
        }
        for name, schema in TOOL_SCHEMAS.items()
    ]


class AnthropicProvider(Provider):
    """Native Anthropic Messages API adapter."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = DEFAULT_ANTHROPIC_MODEL,
        base_url: str = DEFAULT_ANTHROPIC_BASE_URL,
        timeout: int = 120,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        anthropic_version: str = DEFAULT_ANTHROPIC_VERSION,
    ):
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Add it to your .env file."
            )

        self.api_key = api_key
        self.model = model or DEFAULT_ANTHROPIC_MODEL
        self.base_url = (base_url or DEFAULT_ANTHROPIC_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.anthropic_version = anthropic_version
        self.tools = _build_tools()
        self._capabilities = ProviderCapabilities(
            tools=True,
            streaming=True,
            model_listing=False,
            requires_api_key=True,
            local=False,
            notes="Native Anthropic Messages API (not OpenAI-compatible).",
        )
        self.display_name = "Anthropic"

    @property
    def capabilities(self) -> ProviderCapabilities:
        return self._capabilities

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": self.anthropic_version,
        }

    def _unreachable_message(self, exc: Exception) -> str:
        return (
            f"Could not reach Anthropic at {self.base_url}. "
            "Check your network connection, ANTHROPIC_BASE_URL, and "
            f"ANTHROPIC_API_KEY. {exc}"
        )

    def probe(self) -> dict:
        # Anthropic has no lightweight public /models probe without a
        # billed request; treat credential presence + DNS reachability
        # via a HEAD/GET to the API host as a soft availability check.
        try:
            response = requests.get(
                f"{self.base_url}/v1/messages",
                headers=self._headers(),
                timeout=min(self.timeout, 10),
            )
            # 405 Method Not Allowed or 401/403 still mean the host is up.
            if response.status_code in (401, 403, 404, 405):
                return {"available": True, "error": None}
            if response.status_code < 500:
                return {"available": True, "error": None}
            return {
                "available": False,
                "error": (
                    f"Anthropic returned HTTP {response.status_code} "
                    f"from {self.base_url}/v1/messages."
                ),
            }
        except requests.RequestException as exc:
            return {"available": False, "error": self._unreachable_message(exc)}
        except Exception as exc:
            return {"available": False, "error": self._unreachable_message(exc)}

    def list_models(self) -> list:
        # Official Messages API does not expose a catalog equivalent to
        # OpenAI /models for general API keys. Return empty (not an error).
        return []

    def _system_instruction(self, user_instructions=None) -> str:
        base = SYSTEM_INSTRUCTION if self._capabilities.tools else CHAT_ONLY_INSTRUCTION
        if user_instructions:
            return base + "\n\n" + user_instructions
        return base

    def build_contents(self, msg: str, history: list, user_instructions=None) -> list:
        """Build Anthropic ``messages`` (no system role in the array)."""

        contents: list[dict] = []
        for item in history:
            role = item.get("role")
            parts = item.get("parts", [])
            text = "".join(
                part.get("text", "")
                for part in parts
                if isinstance(part, dict)
            )
            if not role or not text:
                continue
            # Frontend uses Gemini's "model" role; Anthropic uses "assistant".
            mapped = "assistant" if role == "model" else role
            if mapped not in ("user", "assistant"):
                continue
            contents.append(
                {
                    "role": mapped,
                    "content": [{"type": "text", "text": text}],
                }
            )

        contents.append(
            {
                "role": "user",
                "content": [{"type": "text", "text": msg}],
            }
        )

        self._user_instructions = user_instructions
        return contents

    def _payload(self, contents: list, use_tools: bool) -> dict:
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": self._system_instruction(getattr(self, "_user_instructions", None)),
            "messages": contents,
        }
        if use_tools:
            payload["tools"] = self.tools
        return payload

    def _parse_message(self, data: dict) -> ProviderResponse:
        content = data.get("content") or []
        if not isinstance(content, list):
            raise RuntimeError(f"Unexpected Anthropic response shape: {data}")

        tool_calls: list[ToolCall] = []
        text_parts: list[str] = []

        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                raw_input = block.get("input") or {}
                if not isinstance(raw_input, dict):
                    raw_input = {}
                tool_calls.append(
                    ToolCall(
                        name=block.get("name") or "",
                        args=dict(raw_input),
                        id=block.get("id"),
                    )
                )
            elif block_type == "text":
                piece = block.get("text")
                if piece:
                    text_parts.append(piece)

        text = "".join(text_parts) if text_parts else None
        if tool_calls:
            text = None

        # raw is the assistant message we must replay on the next turn.
        raw = {
            "role": "assistant",
            "content": content,
        }
        return ProviderResponse(text=text, tool_calls=tool_calls, raw=raw)

    def generate(self, contents: list) -> ProviderResponse:
        use_tools = bool(self._capabilities.tools)
        try:
            response = requests.post(
                f"{self.base_url}/v1/messages",
                headers=self._headers(),
                json=self._payload(contents, use_tools=use_tools),
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise RuntimeError(self._unreachable_message(exc)) from exc

        try:
            response.raise_for_status()
        except requests.HTTPError as exc:
            detail = response.text or str(exc)
            raise RuntimeError(
                f"Anthropic request failed "
                f"(HTTP {response.status_code}): {detail}"
            ) from exc

        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError(
                f"Anthropic returned non-JSON body: {response.text!r}"
            ) from exc

        return self._parse_message(data)

    def append_model_turn(self, contents: list, response: ProviderResponse) -> list:
        if isinstance(response.raw, dict) and response.raw.get("role") == "assistant":
            return contents + [response.raw]

        # Fallback if raw is missing: synthesize from normalized fields.
        content_blocks: list[dict] = []
        if response.tool_calls:
            for index, call in enumerate(response.tool_calls):
                content_blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.id or f"toolu_synthetic_{index}",
                        "name": call.name,
                        "input": dict(call.args or {}),
                    }
                )
        elif response.text:
            content_blocks.append({"type": "text", "text": response.text})
        else:
            content_blocks.append({"type": "text", "text": ""})

        return contents + [{"role": "assistant", "content": content_blocks}]

    def append_tool_results(self, contents: list, results: list) -> list:
        """Append a user message of tool_result blocks matched by ToolCall.id.

        Prefer IDs from the preceding assistant tool_use blocks (and
        thus from ToolCall.id on the ProviderResponse). Order matches
        ``results``, which the agent keeps aligned with tool_calls.
        """

        assistant = contents[-1] if contents else {}
        prior_blocks = assistant.get("content") or []
        tool_use_ids: list[str] = []
        for block in prior_blocks:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                tool_use_ids.append(block.get("id") or "")

        result_blocks: list[dict] = []
        for index, item in enumerate(results):
            tool_use_id = (
                tool_use_ids[index]
                if index < len(tool_use_ids) and tool_use_ids[index]
                else f"toolu_synthetic_{index}"
            )
            payload = item.get("result")
            if isinstance(payload, (dict, list)):
                content = json.dumps(payload)
            else:
                content = str(payload)
            is_error = isinstance(payload, dict) and bool(payload.get("error"))
            block: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
            }
            if is_error:
                block["is_error"] = True
            result_blocks.append(block)

        return contents + [{"role": "user", "content": result_blocks}]
