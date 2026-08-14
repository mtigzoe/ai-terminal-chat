"""OpenAI-compatible provider.

Ollama's local server, the Kilo gateway, and OpenAI itself all expose
the same `/chat/completions` endpoint with `tools` in the request and
`tool_calls` in the response, so one adapter covers all three — only
base_url, model, and whether an API key is required differ. See
providers/__init__.get_provider() for how each is constructed.
"""

import json
from typing import Optional

import requests

from prompts import SYSTEM_INSTRUCTION
from providers.base import Provider, ProviderResponse, ToolCall
from tools import TOOL_SCHEMAS


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


class OpenAICompatibleProvider(Provider):

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: Optional[str] = None,
        timeout: int = 120,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.tools = _build_tools()

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}

        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        return headers

    def build_contents(self, msg, history):
        contents = [{"role": "system", "content": SYSTEM_INSTRUCTION}]

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

    def generate(self, contents) -> ProviderResponse:
        response = requests.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json={
                "model": self.model,
                "messages": contents,
                "tools": self.tools,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        data = response.json()

        try:
            choice = data["choices"][0]
        except (KeyError, IndexError) as exc:
            raise RuntimeError(f"Unexpected response shape: {data}") from exc

        message = choice.get("message", {})
        raw_tool_calls = message.get("tool_calls") or []

        tool_calls = []

        for call in raw_tool_calls:
            function = call.get("function", {})

            try:
                args = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}

            tool_calls.append(
                ToolCall(name=function.get("name", ""), args=args)
            )

        return ProviderResponse(
            text=message.get("content"),
            tool_calls=tool_calls,
            raw=message,
        )

    def append_model_turn(self, contents, response):
        message = dict(response.raw)
        message.setdefault("role", "assistant")
        return contents + [message]

    def append_tool_results(self, contents, results):
        # OpenAI-compatible APIs expect one "tool" message per call,
        # each referencing the matching tool_call id from the
        # assistant turn appended in append_model_turn() just before
        # this — call order is preserved end to end, so zip() lines
        # them back up correctly.
        assistant_turn = contents[-1]
        call_ids = [
            call.get("id") for call in assistant_turn.get("tool_calls", [])
        ]

        new_messages = [
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": json.dumps(item["result"]),
            }
            for call_id, item in zip(call_ids, results)
        ]

        return contents + new_messages
