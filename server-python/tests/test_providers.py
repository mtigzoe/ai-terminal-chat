import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from base import ProviderResponse  # noqa: E402
from gemini import _to_gemini_schema  # noqa: E402
from openai_compatible import OpenAICompatibleProvider  # noqa: E402


def test_gemini_schema_conversion_is_recursive():
    schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "flags": {
                "type": "array",
                "items": {"type": "boolean"},
            },
        },
    }

    converted = _to_gemini_schema(schema)

    assert converted["type"] == "OBJECT"
    assert converted["properties"]["path"]["type"] == "STRING"
    assert converted["properties"]["flags"]["type"] == "ARRAY"
    assert converted["properties"]["flags"]["items"]["type"] == "BOOLEAN"


def test_openai_provider_maps_model_history_role():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    contents = provider.build_contents(
        "new question",
        [
            {"role": "user", "parts": [{"text": "hello"}]},
            {"role": "model", "parts": [{"text": "hi"}]},
        ],
    )

    assert contents[0]["role"] == "system"
    assert contents[1] == {"role": "user", "content": "hello"}
    assert contents[2] == {"role": "assistant", "content": "hi"}
    assert contents[3] == {"role": "user", "content": "new question"}


def test_openai_provider_appends_tool_results_with_call_ids():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    contents = [
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "call-1", "function": {"name": "read_file"}},
                {"id": "call-2", "function": {"name": "list_files"}},
            ],
        }
    ]

    updated = provider.append_tool_results(
        contents,
        [
            {"name": "read_file", "result": {"ok": 1}},
            {"name": "list_files", "result": {"ok": 2}},
        ],
    )

    assert updated[-2]["tool_call_id"] == "call-1"
    assert updated[-1]["tool_call_id"] == "call-2"


def test_provider_response_defaults_to_no_tool_calls():
    response = ProviderResponse(text="hello")
    assert response.tool_calls == []
