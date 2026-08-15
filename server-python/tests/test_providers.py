import sys
from pathlib import Path
from unittest.mock import Mock, patch

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from base import ProviderResponse  # noqa: E402
from gemini import _to_gemini_schema  # noqa: E402
from kilo import KiloProvider  # noqa: E402
from ollama import OllamaProvider, native_and_openai_urls  # noqa: E402
from openai_compatible import OpenAICompatibleProvider  # noqa: E402
from providers import get_provider  # noqa: E402


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


def test_ollama_url_normalization():
    native, openai = native_and_openai_urls("http://linux-host:11434/v1/")
    assert native == "http://linux-host:11434"
    assert openai == "http://linux-host:11434/v1"


def test_ollama_provider_is_local_and_requires_no_key():
    provider = OllamaProvider(
        base_url="http://linux-host:11434/v1",
        model="qwen3.5:9b",
    )

    assert provider.native_base_url == "http://linux-host:11434"
    assert provider.base_url == "http://linux-host:11434/v1"
    assert provider.api_key is None
    assert provider.capabilities.local is True
    assert provider.capabilities.requires_api_key is False


def test_ollama_probe_uses_native_api():
    provider = OllamaProvider(
        base_url="http://linux-host:11434/v1",
        model="qwen3.5:9b",
    )
    response = Mock(status_code=200)

    with patch("ollama.requests.request", return_value=response) as request:
        result = provider.probe()

    assert result == {"available": True, "error": None}
    request.assert_called_once()
    assert request.call_args.args[:2] == ("GET", "http://linux-host:11434/api/tags")


def test_ollama_lists_native_models():
    provider = OllamaProvider(
        base_url="http://linux-host:11434/v1",
        model="qwen3.5:9b",
    )
    response = Mock(status_code=200)
    response.json.return_value = {
        "models": [
            {"name": "qwen3.5:9b", "size": 123, "digest": "abc"},
            {"name": "llama3.1", "size": 456},
        ]
    }

    with patch("ollama.requests.request", return_value=response):
        models = provider.list_models()

    assert [item["id"] for item in models] == ["qwen3.5:9b", "llama3.1"]
    assert models[0]["size"] == 123


def test_provider_factory_uses_dedicated_ollama_provider(monkeypatch):
    monkeypatch.setenv("PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://linux-host:11434/v1")
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3.5:9b")

    provider = get_provider()

    assert isinstance(provider, OllamaProvider)
    assert provider.name == "ollama"
    assert provider.native_base_url == "http://linux-host:11434"
    assert provider.model == "qwen3.5:9b"


def test_ollama_unreachable_probe_returns_actionable_error():
    provider = OllamaProvider(
        base_url="http://linux-host:11434/v1",
        model="qwen3.5:9b",
    )

    with patch(
        "ollama.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        result = provider.probe()

    assert result["available"] is False
    assert "Could not reach Ollama" in result["error"]
    assert "linux-host:11434" in result["error"]


def test_kilo_provider_requires_api_key():
    try:
        KiloProvider(api_key=None)
    except RuntimeError as exc:
        assert "KILO_API_KEY" in str(exc)
    else:
        raise AssertionError("KiloProvider should require an API key")


def test_kilo_provider_configuration():
    provider = KiloProvider(
        base_url="https://api.kilo.ai/api/gateway",
        model="kilocode/kilo-auto/balanced",
        api_key="test-key",
    )

    assert provider.base_url == "https://api.kilo.ai/api/gateway"
    assert provider.model == "kilocode/kilo-auto/balanced"
    assert provider.api_key == "test-key"
    assert provider.capabilities.local is False
    assert provider.capabilities.requires_api_key is True


def test_kilo_provider_sends_bearer_auth():
    provider = KiloProvider(
        base_url="https://api.kilo.ai/api/gateway",
        model="test-model",
        api_key="test-key",
    )
    response = Mock(status_code=200)
    response.json.return_value = {"data": [{"id": "test-model"}]}

    with patch("openai_compatible.requests.request", return_value=response) as request:
        models = provider.list_models()

    assert models == [{"id": "test-model"}]
    assert request.call_args.kwargs["headers"]["Authorization"] == "Bearer test-key"


def test_provider_factory_uses_dedicated_kilo_provider(monkeypatch):
    monkeypatch.setenv("PROVIDER", "kilo")
    monkeypatch.setenv("KILO_API_KEY", "test-key")
    monkeypatch.setenv("KILO_BASE_URL", "https://api.kilo.ai/api/gateway")
    monkeypatch.setenv("KILO_MODEL", "test-model")

    provider = get_provider()

    assert isinstance(provider, KiloProvider)
    assert provider.name == "kilo"
    assert provider.model == "test-model"
    assert provider.api_key == "test-key"


def test_kilo_unreachable_probe_returns_actionable_error():
    provider = KiloProvider(
        base_url="https://api.kilo.ai/api/gateway",
        model="test-model",
        api_key="test-key",
    )

    with patch(
        "openai_compatible.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        result = provider.probe()

    assert result["available"] is False
    assert "Could not reach Kilo Gateway" in result["error"]
