"""OpenAI-compatible provider.

Ollama's local server, LM Studio, llama.cpp, LocalAI, the Kilo
gateway, and OpenAI itself all expose the same `/chat/completions`
endpoint. One adapter covers them — only base_url, model, whether
an API key is required, and detected capabilities differ.
"""

import json
from dataclasses import replace
from typing import Optional

import requests

from prompts import CHAT_ONLY_INSTRUCTION, SYSTEM_INSTRUCTION
from providers.base import Provider, ProviderCapabilities, ProviderResponse, ToolCall
from tools import TOOL_SCHEMAS

# Phrases that mean "this server/model cannot do function calling".
# Used to drop tools and retry instead of failing the whole turn.
_TOOLS_UNSUPPORTED_MARKERS = (
    "tool",
    "tools",
    "function",
    "functions",
    "function calling",
    "tool_choice",
    "does not support",
    "unsupported",
    "unknown field",
    "unrecognized",
    "invalid parameter",
    "not enabled",
)

_STREAM_UNSUPPORTED_MARKERS = (
    "stream",
    "streaming",
    "does not support",
    "unsupported",
)


def _build_tools() -> list:
    # tools.TOOL_SCHEMAS is already standard (lowercase) JSON Schema,
    # which is exactly what an OpenAI-style `tools` array expects —
    # unlike Gemini, no case translation is needed here.
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": schema["description"],
                "parameters": schema["parameters"],
            },
        }
        for name, schema in TOOL_SCHEMAS.items()
    ]


def _response_text(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if response is None:
        return str(exc)
    try:
        return response.text or str(exc)
    except Exception:
        return str(exc)


def _http_response(exc: Exception):
    response = getattr(exc, "response", None)
    if response is not None:
        return response
    cause = getattr(exc, "__cause__", None)
    return getattr(cause, "response", None)


def looks_like_tools_unsupported(exc: Exception) -> bool:
    """True when an HTTP error is likely caused by sending tools."""

    response = _http_response(exc)
    status = getattr(response, "status_code", None)
    if status is not None and status not in (400, 404, 422):
        return False
    text = (_response_text(exc) if response is None else (response.text or "")).lower()
    if not text:
        text = str(exc).lower()
    return any(marker in text for marker in _TOOLS_UNSUPPORTED_MARKERS)


def looks_like_streaming_unsupported(exc: Exception) -> bool:
    response = _http_response(exc)
    status = getattr(response, "status_code", None)
    if status is not None and status not in (400, 404, 422):
        return False
    text = (_response_text(exc) if response is None else (response.text or "")).lower()
    if not text:
        text = str(exc).lower()
    return any(marker in text for marker in _STREAM_UNSUPPORTED_MARKERS)


class OpenAICompatibleProvider(Provider):

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: Optional[str] = None,
        timeout: int = 120,
        local: bool = False,
        requires_api_key: bool = False,
        display_name: str = "OpenAI-compatible",
        capabilities: Optional[ProviderCapabilities] = None,
    ):
        if not (base_url or "").strip():
            raise RuntimeError(
                f"{display_name} base URL is not set. Configure it in "
                "the application or in your .env file."
            )

        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.display_name = display_name
        self.tools = _build_tools()
        self._capabilities = capabilities or ProviderCapabilities(
            tools=True,
            streaming=True,
            model_listing=True,
            requires_api_key=requires_api_key,
            local=local,
        )

    @property
    def capabilities(self) -> ProviderCapabilities:
        return self._capabilities

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}

        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        return headers

    def _unreachable_message(self, exc: Exception) -> str:
        return (
            f"Could not reach {self.display_name} at {self.base_url}. "
            f"{exc}"
        )

    def _request(self, method: str, url: str, **kwargs):
        kwargs.setdefault("headers", self._headers())
        kwargs.setdefault("timeout", min(self.timeout, 10))
        try:
            return requests.request(method, url, **kwargs)
        except requests.RequestException as exc:
            raise RuntimeError(self._unreachable_message(exc)) from exc

    def probe(self) -> dict:
        try:
            response = self._request("GET", f"{self.base_url}/models")
            if response.status_code < 400:
                return {"available": True, "error": None}
            # Some local servers expose chat but not /models.
            if response.status_code in (404, 405):
                return {"available": True, "error": None}
            return {
                "available": False,
                "error": (
                    f"{self.display_name} returned HTTP "
                    f"{response.status_code} from {self.base_url}/models."
                ),
            }
        except Exception as exc:
            # _request() already wraps requests.RequestException in an
            # actionable RuntimeError via _unreachable_message(). Route
            # anything else (e.g. a raw ConnectionError that didn't come
            # through requests) through the same message builder so a
            # caller never sees a bare "connection refused" instead of
            # a diagnosable "Could not reach <provider> at <url>".
            message = str(exc)
            if not message.startswith(f"Could not reach {self.display_name}"):
                message = self._unreachable_message(exc)
            return {"available": False, "error": message}

    def list_models(self) -> list:
        try:
            response = self._request("GET", f"{self.base_url}/models")
            response.raise_for_status()
            data = response.json()
        except Exception:
            return []

        raw_models = []
        if isinstance(data, dict):
            raw_models = data.get("data") or data.get("models") or []
        elif isinstance(data, list):
            raw_models = data

        models = []
        for item in raw_models:
            if isinstance(item, str):
                model_id = item
            elif isinstance(item, dict):
                model_id = item.get("id") or item.get("name") or item.get("model")
            else:
                continue
            if model_id:
                models.append({"id": model_id})
        return models

    def refresh_capabilities(self) -> ProviderCapabilities:
        probe = self.probe()
        notes = []
        if not probe["available"]:
            notes.append(probe["error"] or f"{self.display_name} is not reachable.")
        elif not self.list_models():
            # Reachable but no catalog — listing is still supported in
            # principle; the user can type a model name.
            pass

        self._capabilities = replace(
            self._capabilities,
            notes="; ".join(note for note in notes if note),
        )
        return self._capabilities

    def _system_instruction(self) -> str:
        if self._capabilities.tools:
            return SYSTEM_INSTRUCTION
        return CHAT_ONLY_INSTRUCTION

    def build_contents(self, msg, history):
        contents = [{"role": "system", "content": self._system_instruction()}]

        for item in history:
            role = item.get("role")
            parts = item.get("parts", [])
            text = "".join(
                part.get("text", "")
                for part in parts
                if isinstance(part, dict)
            )

            if role and text:
                # The frontend's history format uses Gemini's "model"
                # role; OpenAI-compatible APIs call that "assistant".
                contents.append(
                    {
                        "role": "assistant" if role == "model" else role,
                        "content": text,
                    }
                )

        contents.append({"role": "user", "content": msg})
        return contents

    def _chat_payload(self, contents, use_tools: bool) -> dict:
        payload = {
            "model": self.model,
            "messages": contents,
        }
        if use_tools:
            payload["tools"] = self.tools
        return payload

    def _parse_completion(self, data: dict) -> ProviderResponse:
        try:
            choice = data["choices"][0]
        except (KeyError, IndexError) as exc:
            raise RuntimeError(f"Unexpected response shape: {data}") from exc

        message = choice.get("message", {})
        raw_tool_calls = message.get("tool_calls") or []

        tool_calls = []

        for call in raw_tool_calls:
            function = call.get("function", {})
            raw_args = function.get("arguments") or "{}"

            if isinstance(raw_args, dict):
                args = raw_args
            else:
                try:
                    args = json.loads(raw_args)
                except json.JSONDecodeError:
                    args = {}

            tool_calls.append(
                ToolCall(
                    name=function.get("name", ""),
                    args=args,
                    id=call.get("id"),
                )
            )

        return ProviderResponse(
            text=message.get("content"),
            tool_calls=tool_calls,
            raw=message,
        )

    def generate(self, contents) -> ProviderResponse:
        use_tools = bool(self._capabilities.tools)
        try:
            return self._complete(contents, use_tools=use_tools)
        except Exception as exc:
            if use_tools and looks_like_tools_unsupported(exc):
                self._capabilities = replace(
                    self._capabilities,
                    tools=False,
                    notes=(
                        "This model or server rejected tool calling. "
                        "Continuing in chat-only mode."
                    ),
                )
                return self._complete(contents, use_tools=False)
            raise

    def _complete(self, contents, use_tools: bool) -> ProviderResponse:
        try:
            response = requests.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=self._chat_payload(contents, use_tools),
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise RuntimeError(self._unreachable_message(exc)) from exc

        try:
            response.raise_for_status()
        except requests.HTTPError as exc:
            detail = _response_text(exc)
            raise RuntimeError(
                f"{self.display_name} request failed "
                f"(HTTP {response.status_code}): {detail}"
            ) from exc

        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError(
                f"{self.display_name} returned a non-JSON response body: "
                f"{response.text!r}"
            ) from exc

        return self._parse_completion(data)

    def append_model_turn(self, contents, response):
        message = dict(response.raw) if isinstance(response.raw, dict) else {
            "role": "assistant",
            "content": response.text or "",
        }
        message.setdefault("role", "assistant")
        # Ollama (and some other OpenAI-compatible servers) reject
        # "content": null on assistant messages. The OpenAI spec allows
        # null content when tool_calls are present, but Ollama returns
        # HTTP 400 "invalid message content type: <nil>". Normalize to an
        # empty string so the conversation history round-trips cleanly.
        if message.get("content") is None:
            message["content"] = ""
        return contents + [message]

    def append_tool_results(self, contents, results):
        # OpenAI-compatible APIs expect one "tool" message per call,
        # each referencing the matching tool_call id from the
        # assistant turn appended in append_model_turn() just before
        # this — call order is preserved end to end, so zip() lines
        # them back up correctly. Native Ollama tool calls may omit
        # ids; synthesize stable ones so the next turn still works.
        assistant_turn = contents[-1]
        raw_calls = assistant_turn.get("tool_calls") or []
        call_ids = []
        for index, call in enumerate(raw_calls):
            call_id = call.get("id") or f"call-{index}"
            call.setdefault("id", call_id)
            call_ids.append(call_id)

        new_messages = [
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": json.dumps(item["result"]),
            }
            for call_id, item in zip(call_ids, results)
        ]

        return contents + new_messages
