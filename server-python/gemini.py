"""Gemini provider: wraps google-genai's explicit function/tool calling.

This is a behavior-preserving move of what used to be inline in
app.py (client construction, GENERATE_CONFIG, build_contents, and the
Gemini-specific parts of run_agent_loop) — nothing about how Gemini is
called has changed, it's just reachable through the Provider interface
now so agent.py doesn't need to import google.genai at all.
"""

import os

from google import genai
from google.genai import types

from prompts import SYSTEM_INSTRUCTION
from providers.base import Provider, ProviderCapabilities, ProviderResponse, ToolCall
from tools import TOOL_SCHEMAS

# tools.TOOL_SCHEMAS is written in standard (lowercase) JSON Schema so
# it can be shared as-is with OpenAICompatibleProvider. Gemini's
# FunctionDeclaration.parameters expects the same shape but with
# uppercase type names (OBJECT, STRING, ...), so this is the one
# Gemini-specific translation step.
_GEMINI_TYPE_MAP = {
    "object": "OBJECT",
    "string": "STRING",
    "boolean": "BOOLEAN",
    "integer": "INTEGER",
    "number": "NUMBER",
    "array": "ARRAY",
}


def _to_gemini_schema(schema: dict) -> dict:
    """Recursively uppercase JSON Schema `type` values for Gemini."""

    converted = dict(schema)

    if "type" in converted:
        converted["type"] = _GEMINI_TYPE_MAP.get(
            converted["type"], converted["type"]
        )

    if "properties" in converted:
        converted["properties"] = {
            key: _to_gemini_schema(value)
            for key, value in converted["properties"].items()
        }

    if "items" in converted:
        converted["items"] = _to_gemini_schema(converted["items"])

    return converted


def _build_tools() -> list:
    return [
        types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name=name,
                    description=schema["description"],
                    parameters=_to_gemini_schema(schema["parameters"]),
                )
                for name, schema in TOOL_SCHEMAS.items()
            ]
        )
    ]


class GeminiProvider(Provider):

    def __init__(self, api_key: str = None, model: str = None):
        api_key = api_key or os.getenv("GOOGLE_API_KEY")

        if not api_key:
            raise RuntimeError(
                "GOOGLE_API_KEY is not set. Add it to your .env file."
            )

        self.client = genai.Client(api_key=api_key)

        # Gemini 3.6 Flash is Google's current GA Flash model tuned for
        # coding, tool-use, and multi-step agentic workloads, so it's
        # the default here. Override with GEMINI_MODEL if you want a
        # different currently supported Gemini model (e.g. a Pro
        # model for harder tasks).
        self.model_name = model or os.getenv("GEMINI_MODEL", "gemini-3.6-flash")

        self.model = self.model_name
        self._capabilities = ProviderCapabilities(
            tools=True,
            streaming=True,
            model_listing=False,
            requires_api_key=True,
            local=False,
        )

        self.config = types.GenerateContentConfig(
            tools=_build_tools(),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                disable=True
            ),
            system_instruction=SYSTEM_INSTRUCTION,
        )

    @property
    def capabilities(self) -> ProviderCapabilities:
        return self._capabilities

    def build_contents(self, msg, history):
        contents = []

        for item in history:
            role = item.get("role")
            parts = item.get("parts", [])

            if role and parts:
                converted_parts = []

                for part in parts:
                    if isinstance(part, dict) and "text" in part:
                        converted_parts.append(
                            types.Part.from_text(text=part["text"])
                        )
                    else:
                        converted_parts.append(part)

                contents.append(
                    types.Content(role=role, parts=converted_parts)
                )

        contents.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=msg)],
            )
        )

        return contents

    def generate(self, contents) -> ProviderResponse:
        response = self.client.models.generate_content(
            model=self.model_name,
            contents=contents,
            config=self.config,
        )

        if not response.candidates:
            raise RuntimeError("Gemini returned no response candidates.")

        model_content = response.candidates[0].content

        if model_content is None or not model_content.parts:
            raise RuntimeError("Gemini returned an empty response.")

        tool_calls = [
            ToolCall(
                name=part.function_call.name,
                args=dict(part.function_call.args or {}),
            )
            for part in model_content.parts
            if part.function_call
        ]

        text = None

        if not tool_calls:
            try:
                text = response.text
            except Exception:
                text = None

            if not text:
                # Fall back to manually concatenating any text parts.
                text = "".join(
                    part.text
                    for part in model_content.parts
                    if getattr(part, "text", None)
                ) or None

        return ProviderResponse(text=text, tool_calls=tool_calls, raw=model_content)

    def append_model_turn(self, contents, response):
        # Preserve Gemini's function-call (or text) message.
        return contents + [response.raw]

    def append_tool_results(self, contents, results):
        # IMPORTANT: google-genai 2.17.0 does not accept id= here.
        parts = [
            types.Part.from_function_response(
                name=item["name"],
                response={"result": item["result"]},
            )
            for item in results
        ]

        return contents + [types.Content(role="user", parts=parts)]
