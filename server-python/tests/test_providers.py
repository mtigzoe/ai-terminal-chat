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
from anthropic_provider import AnthropicProvider  # noqa: E402
from openai_provider import OpenAIProvider  # noqa: E402
from openrouter import OpenRouterProvider  # noqa: E402
from providers import SUPPORTED_PROVIDERS, get_provider  # noqa: E402
from xai import XAIProvider  # noqa: E402
from base import ToolCall  # noqa: E402


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


def test_openai_compatible_parses_tool_call_ids():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    response = provider._parse_completion(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_abc",
                                "type": "function",
                                "function": {
                                    "name": "list_files",
                                    "arguments": '{"path": "."}',
                                },
                            },
                            {
                                "id": "call_def",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": {"path": "a.py"},
                                },
                            },
                        ],
                    }
                }
            ]
        }
    )

    assert len(response.tool_calls) == 2
    assert response.tool_calls[0].name == "list_files"
    assert response.tool_calls[0].args == {"path": "."}
    assert response.tool_calls[0].id == "call_abc"
    assert response.tool_calls[1].name == "read_file"
    assert response.tool_calls[1].args == {"path": "a.py"}
    assert response.tool_calls[1].id == "call_def"


def test_openai_compatible_tool_call_without_id_is_none():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    response = provider._parse_completion(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "type": "function",
                                "function": {
                                    "name": "list_files",
                                    "arguments": "{}",
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )

    assert response.tool_calls[0].id is None
    assert response.tool_calls[0].name == "list_files"


def test_openai_compatible_append_tool_results_synthesizes_missing_ids():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    contents = [
        {
            "role": "assistant",
            "tool_calls": [
                {"function": {"name": "list_files"}},
                {"id": "existing", "function": {"name": "read_file"}},
            ],
        }
    ]

    updated = provider.append_tool_results(
        contents,
        [
            {"name": "list_files", "result": {"ok": 1}},
            {"name": "read_file", "result": {"ok": 2}},
        ],
    )

    assert updated[-2]["tool_call_id"] == "call-0"
    assert updated[-1]["tool_call_id"] == "existing"
    assert contents[0]["tool_calls"][0]["id"] == "call-0"


def test_gemini_constructor_uses_passed_model_without_env(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    monkeypatch.setenv("GEMINI_MODEL", "env-should-not-win")

    fake_client = Mock()
    with patch("gemini.genai.Client", return_value=fake_client) as client_ctor:
        from gemini import GeminiProvider

        provider = GeminiProvider(api_key="explicit-key", model="explicit-model")

    client_ctor.assert_called_once_with(api_key="explicit-key")
    assert provider.model == "explicit-model"
    assert provider.model_name == "explicit-model"
    assert provider.capabilities.requires_api_key is True
    assert provider.capabilities.local is False
    assert provider.capabilities.model_listing is False


def test_gemini_constructor_requires_api_key(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    with patch("gemini.genai.Client"):
        from gemini import GeminiProvider

        try:
            GeminiProvider(api_key=None, model="gemini-3.6-flash")
        except RuntimeError as exc:
            assert "GOOGLE_API_KEY" in str(exc)
        else:
            raise AssertionError("GeminiProvider should require an API key")


def test_gemini_append_model_turn_skips_none_raw():
    """Direct command responses (e.g. git_commit) have raw=None.

    append_model_turn must not append None to the contents list, because
    the next provider.generate() call would pass it to the Gemini SDK,
    which fails pydantic validation with "Input should be a valid
    Content, str, File, Part, or list[union[str, File, Part]]".
    """
    from gemini import GeminiProvider
    from google.genai import types

    fake_client = Mock()
    with patch("gemini.genai.Client", return_value=fake_client):
        provider = GeminiProvider(api_key="test-key", model="gemini-3.6-flash")

    user_content = types.Content(
        role="user",
        parts=[types.Part.from_text(text="git commit -m test")],
    )
    contents = [user_content]

    # Direct command response: raw is None.
    response = ProviderResponse(
        text=None,
        tool_calls=[ToolCall("git_commit", {"message": "test"})],
    )
    updated = provider.append_model_turn(contents, response)
    assert updated == [user_content]
    assert None not in updated


def test_gemini_append_model_turn_appends_valid_raw():
    """Real Gemini responses carry a Content object in response.raw."""
    from gemini import GeminiProvider
    from google.genai import types

    fake_client = Mock()
    with patch("gemini.genai.Client", return_value=fake_client):
        provider = GeminiProvider(api_key="test-key", model="gemini-3.6-flash")

    user_content = types.Content(
        role="user",
        parts=[types.Part.from_text(text="hi")],
    )
    model_content = types.Content(
        role="model",
        parts=[types.Part.from_text(text="hello back")],
    )
    contents = [user_content]

    response = ProviderResponse(text="hello back", tool_calls=[], raw=model_content)
    updated = provider.append_model_turn(contents, response)
    assert updated == [user_content, model_content]


def test_provider_config_to_public_dict_omits_api_key():
    from providers import ProviderConfig

    config = ProviderConfig(
        provider="kilo",
        model="m",
        base_url="https://example",
        api_key="secret-key",
        timeout=30,
    )
    public = config.to_public_dict()
    assert "api_key" not in public
    assert public["provider"] == "kilo"
    assert public["model"] == "m"
    assert public["base_url"] == "https://example"
    assert public["timeout"] == 30


def test_get_provider_passes_resolved_config_to_gemini(monkeypatch):
    monkeypatch.setenv("PROVIDER", "gemini")
    monkeypatch.setenv("GOOGLE_API_KEY", "factory-key")
    monkeypatch.setenv("GEMINI_MODEL", "factory-model")

    with patch("gemini.genai.Client") as client_ctor:
        provider = get_provider("gemini")

    client_ctor.assert_called_once_with(api_key="factory-key")
    assert provider.model == "factory-model"
    assert provider.name == "gemini"
    assert provider.provider_config.api_key == "factory-key"
    assert "api_key" not in provider.provider_config.to_public_dict()


def test_get_provider_model_override(monkeypatch):
    monkeypatch.setenv("PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("OLLAMA_MODEL", "default-model")

    provider = get_provider("ollama", model="override-model")
    assert isinstance(provider, OllamaProvider)
    assert provider.model == "override-model"
    assert provider.provider_config.model == "override-model"


# --- OpenAI ---


def test_openai_is_in_supported_providers():
    assert "openai" in SUPPORTED_PROVIDERS


def test_openai_provider_requires_api_key():
    try:
        OpenAIProvider(api_key=None)
    except RuntimeError as exc:
        assert "OPENAI_API_KEY" in str(exc)
    else:
        raise AssertionError("OpenAIProvider should require an API key")


def test_openai_provider_configuration():
    provider = OpenAIProvider(
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini",
        api_key="test-key",
    )

    assert provider.base_url == "https://api.openai.com/v1"
    assert provider.model == "gpt-4o-mini"
    assert provider.api_key == "test-key"
    assert provider.display_name == "OpenAI"
    assert provider.capabilities.local is False
    assert provider.capabilities.requires_api_key is True
    assert provider.capabilities.tools is True
    assert provider.capabilities.model_listing is True
    assert isinstance(provider, OpenAICompatibleProvider)


def test_openai_provider_default_base_url():
    provider = OpenAIProvider(api_key="test-key")
    assert provider.base_url == "https://api.openai.com/v1"
    assert provider.model == "gpt-4o-mini"


def test_openai_provider_sends_bearer_auth():
    provider = OpenAIProvider(
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini",
        api_key="sk-test-key",
    )
    response = Mock(status_code=200)
    response.json.return_value = {"data": [{"id": "gpt-4o-mini"}, {"id": "gpt-4o"}]}

    with patch("openai_compatible.requests.request", return_value=response) as request:
        models = provider.list_models()

    assert models == [{"id": "gpt-4o-mini"}, {"id": "gpt-4o"}]
    assert request.call_args.kwargs["headers"]["Authorization"] == "Bearer sk-test-key"
    assert request.call_args.args[:2] == (
        "GET",
        "https://api.openai.com/v1/models",
    )


def test_openai_provider_list_models_empty_on_error():
    provider = OpenAIProvider(api_key="test-key")

    with patch(
        "openai_compatible.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        models = provider.list_models()

    assert models == []


def test_openai_provider_parses_text_response():
    provider = OpenAIProvider(api_key="test-key", model="gpt-4o-mini")

    response = provider._parse_completion(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "Hello from OpenAI",
                    }
                }
            ]
        }
    )

    assert response.text == "Hello from OpenAI"
    assert response.tool_calls == []


def test_openai_provider_parses_tool_calls_with_ids():
    provider = OpenAIProvider(api_key="test-key")

    response = provider._parse_completion(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_openai_1",
                                "type": "function",
                                "function": {
                                    "name": "list_files",
                                    "arguments": '{"path": "."}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )

    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].name == "list_files"
    assert response.tool_calls[0].args == {"path": "."}
    assert response.tool_calls[0].id == "call_openai_1"


def test_openai_provider_tool_result_round_trip():
    provider = OpenAIProvider(api_key="test-key")

    contents = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_rt_1",
                    "type": "function",
                    "function": {
                        "name": "list_files",
                        "arguments": '{"path": "."}',
                    },
                }
            ],
        }
    ]

    updated = provider.append_tool_results(
        contents,
        [{"name": "list_files", "result": {"entries": ["a.py"]}}],
    )

    assert updated[-1]["role"] == "tool"
    assert updated[-1]["tool_call_id"] == "call_rt_1"
    assert '"entries"' in updated[-1]["content"]


def test_openai_provider_generate_posts_chat_completions():
    provider = OpenAIProvider(
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini",
        api_key="sk-test",
    )
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "ok",
                }
            }
        ]
    }
    mock_response.raise_for_status = Mock()

    with patch(
        "openai_compatible.requests.post", return_value=mock_response
    ) as post:
        result = provider.generate(
            [{"role": "user", "content": "hi"}]
        )

    assert result.text == "ok"
    assert post.call_args.args[0] == "https://api.openai.com/v1/chat/completions"
    headers = post.call_args.kwargs["headers"]
    assert headers["Authorization"] == "Bearer sk-test"
    payload = post.call_args.kwargs["json"]
    assert payload["model"] == "gpt-4o-mini"
    assert "tools" in payload


def test_openai_provider_unreachable_probe_returns_actionable_error():
    provider = OpenAIProvider(
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini",
        api_key="test-key",
    )

    with patch(
        "openai_compatible.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        result = provider.probe()

    assert result["available"] is False
    assert "Could not reach OpenAI" in result["error"]
    assert "api.openai.com" in result["error"]


def test_openai_provider_http_error_surfaces_status():
    provider = OpenAIProvider(api_key="test-key")
    mock_response = Mock(status_code=401)
    mock_response.text = "Invalid API key"
    mock_response.raise_for_status.side_effect = __import__(
        "requests"
    ).HTTPError(response=mock_response)

    with patch("openai_compatible.requests.post", return_value=mock_response):
        try:
            provider.generate([{"role": "user", "content": "hi"}])
        except RuntimeError as exc:
            message = str(exc)
            assert "OpenAI" in message
            assert "401" in message
        else:
            raise AssertionError("expected RuntimeError for HTTP 401")


def test_provider_factory_uses_dedicated_openai_provider(monkeypatch):
    monkeypatch.setenv("PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "factory-openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")

    provider = get_provider()

    assert isinstance(provider, OpenAIProvider)
    assert provider.name == "openai"
    assert provider.model == "gpt-4o"
    assert provider.api_key == "factory-openai-key"
    assert provider.base_url == "https://api.openai.com/v1"
    assert provider.provider_config.api_key == "factory-openai-key"
    assert "api_key" not in provider.provider_config.to_public_dict()


def test_provider_factory_openai_model_override(monkeypatch):
    monkeypatch.setenv("PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")

    provider = get_provider("openai", model="gpt-4o")
    assert isinstance(provider, OpenAIProvider)
    assert provider.model == "gpt-4o"
    assert provider.provider_config.model == "gpt-4o"


def test_provider_factory_openai_missing_key_raises(monkeypatch):
    monkeypatch.setenv("PROVIDER", "openai")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    try:
        get_provider("openai")
    except RuntimeError as exc:
        assert "OPENAI_API_KEY" in str(exc)
    else:
        raise AssertionError("get_provider('openai') should require OPENAI_API_KEY")


def test_openai_public_config_never_includes_api_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "secret-should-not-leak")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")

    provider = get_provider("openai")
    public = provider.provider_config.to_public_dict()
    assert "api_key" not in public
    assert "secret" not in str(public).lower()
    assert public["provider"] == "openai"
    assert public["base_url"] == "https://api.openai.com/v1"


# --- xAI ---


def test_xai_is_in_supported_providers():
    assert "xai" in SUPPORTED_PROVIDERS
    assert "grok" not in SUPPORTED_PROVIDERS


def test_xai_provider_requires_api_key():
    try:
        XAIProvider(api_key=None)
    except RuntimeError as exc:
        assert "XAI_API_KEY" in str(exc)
    else:
        raise AssertionError("XAIProvider should require an API key")


def test_xai_provider_configuration():
    provider = XAIProvider(
        base_url="https://api.x.ai/v1",
        model="grok-4.6",
        api_key="test-key",
    )

    assert provider.base_url == "https://api.x.ai/v1"
    assert provider.model == "grok-4.6"
    assert provider.api_key == "test-key"
    assert provider.display_name == "xAI"
    assert provider.capabilities.local is False
    assert provider.capabilities.requires_api_key is True
    assert provider.capabilities.tools is True
    assert provider.capabilities.model_listing is True
    assert isinstance(provider, OpenAICompatibleProvider)


def test_xai_provider_default_base_url_and_model():
    provider = XAIProvider(api_key="test-key")
    assert provider.base_url == "https://api.x.ai/v1"
    assert provider.model == "grok-4.6"


def test_xai_provider_configurable_base_url():
    provider = XAIProvider(
        base_url="https://custom.x.ai/v1",
        model="grok-4.6",
        api_key="test-key",
    )
    assert provider.base_url == "https://custom.x.ai/v1"


def test_xai_provider_sends_bearer_auth():
    provider = XAIProvider(
        base_url="https://api.x.ai/v1",
        model="grok-4.6",
        api_key="xai-test-key",
    )
    response = Mock(status_code=200)
    response.json.return_value = {
        "data": [{"id": "grok-4.6"}, {"id": "grok-4.5"}]
    }

    with patch("openai_compatible.requests.request", return_value=response) as request:
        models = provider.list_models()

    assert models == [{"id": "grok-4.6"}, {"id": "grok-4.5"}]
    assert request.call_args.kwargs["headers"]["Authorization"] == "Bearer xai-test-key"
    assert request.call_args.args[:2] == ("GET", "https://api.x.ai/v1/models")


def test_xai_provider_list_models_empty_on_error():
    provider = XAIProvider(api_key="test-key")

    with patch(
        "openai_compatible.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        models = provider.list_models()

    assert models == []


def test_xai_provider_parses_text_response():
    provider = XAIProvider(api_key="test-key", model="grok-4.6")

    response = provider._parse_completion(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "Hello from Grok",
                    }
                }
            ]
        }
    )

    assert response.text == "Hello from Grok"
    assert response.tool_calls == []


def test_xai_provider_parses_tool_calls_with_ids():
    provider = XAIProvider(api_key="test-key")

    response = provider._parse_completion(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_xai_1",
                                "type": "function",
                                "function": {
                                    "name": "list_files",
                                    "arguments": '{"path": "."}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )

    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].name == "list_files"
    assert response.tool_calls[0].args == {"path": "."}
    assert response.tool_calls[0].id == "call_xai_1"


def test_xai_provider_tool_result_round_trip():
    provider = XAIProvider(api_key="test-key")

    contents = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_xai_rt",
                    "type": "function",
                    "function": {
                        "name": "list_files",
                        "arguments": '{"path": "."}',
                    },
                }
            ],
        }
    ]

    updated = provider.append_tool_results(
        contents,
        [{"name": "list_files", "result": {"entries": ["xai.py"]}}],
    )

    assert updated[-1]["role"] == "tool"
    assert updated[-1]["tool_call_id"] == "call_xai_rt"
    assert "xai.py" in updated[-1]["content"]


def test_xai_provider_generate_posts_chat_completions():
    provider = XAIProvider(
        base_url="https://api.x.ai/v1",
        model="grok-4.6",
        api_key="xai-key",
    )
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "ok",
                }
            }
        ]
    }
    mock_response.raise_for_status = Mock()

    with patch(
        "openai_compatible.requests.post", return_value=mock_response
    ) as post:
        result = provider.generate([{"role": "user", "content": "hi"}])

    assert result.text == "ok"
    assert post.call_args.args[0] == "https://api.x.ai/v1/chat/completions"
    headers = post.call_args.kwargs["headers"]
    assert headers["Authorization"] == "Bearer xai-key"
    payload = post.call_args.kwargs["json"]
    assert payload["model"] == "grok-4.6"
    assert "tools" in payload
    # Application-local tools only; no xAI server-side tool types.
    for tool in payload["tools"]:
        assert tool.get("type") == "function"
        assert "web_search" not in str(tool).lower()
        assert "x_search" not in str(tool).lower()


def test_xai_provider_unreachable_probe_returns_actionable_error():
    provider = XAIProvider(
        base_url="https://api.x.ai/v1",
        model="grok-4.6",
        api_key="test-key",
    )

    with patch(
        "openai_compatible.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        result = provider.probe()

    assert result["available"] is False
    assert "Could not reach xAI" in result["error"]
    assert "api.x.ai" in result["error"]


def test_xai_provider_http_error_surfaces_status():
    provider = XAIProvider(api_key="test-key")
    mock_response = Mock(status_code=401)
    mock_response.text = "Invalid API key"
    mock_response.raise_for_status.side_effect = __import__(
        "requests"
    ).HTTPError(response=mock_response)

    with patch("openai_compatible.requests.post", return_value=mock_response):
        try:
            provider.generate([{"role": "user", "content": "hi"}])
        except RuntimeError as exc:
            message = str(exc)
            assert "xAI" in message
            assert "401" in message
        else:
            raise AssertionError("expected RuntimeError for HTTP 401")


def test_provider_factory_uses_dedicated_xai_provider(monkeypatch):
    monkeypatch.setenv("PROVIDER", "xai")
    monkeypatch.setenv("XAI_API_KEY", "factory-xai-key")
    monkeypatch.setenv("XAI_BASE_URL", "https://api.x.ai/v1")
    monkeypatch.setenv("XAI_MODEL", "grok-4.6")

    provider = get_provider()

    assert isinstance(provider, XAIProvider)
    assert provider.name == "xai"
    assert provider.model == "grok-4.6"
    assert provider.api_key == "factory-xai-key"
    assert provider.base_url == "https://api.x.ai/v1"
    assert provider.provider_config.api_key == "factory-xai-key"
    assert "api_key" not in provider.provider_config.to_public_dict()


def test_provider_factory_xai_model_override(monkeypatch):
    monkeypatch.setenv("PROVIDER", "xai")
    monkeypatch.setenv("XAI_API_KEY", "key")
    monkeypatch.setenv("XAI_MODEL", "grok-4.6")

    provider = get_provider("xai", model="grok-4.5")
    assert isinstance(provider, XAIProvider)
    assert provider.model == "grok-4.5"
    assert provider.provider_config.model == "grok-4.5"


def test_provider_factory_xai_missing_key_raises(monkeypatch):
    monkeypatch.setenv("PROVIDER", "xai")
    monkeypatch.delenv("XAI_API_KEY", raising=False)

    try:
        get_provider("xai")
    except RuntimeError as exc:
        assert "XAI_API_KEY" in str(exc)
    else:
        raise AssertionError("get_provider('xai') should require XAI_API_KEY")


def test_xai_public_config_never_includes_api_key(monkeypatch):
    monkeypatch.setenv("XAI_API_KEY", "secret-xai-key-should-not-leak")
    monkeypatch.setenv("XAI_MODEL", "grok-4.6")

    provider = get_provider("xai")
    public = provider.provider_config.to_public_dict()
    assert "api_key" not in public
    assert "secret" not in str(public).lower()
    assert public["provider"] == "xai"
    assert public["base_url"] == "https://api.x.ai/v1"


# --- OpenRouter (gateway) ---


def test_openrouter_is_in_supported_providers():
    assert "openrouter" in SUPPORTED_PROVIDERS


def test_openrouter_provider_requires_api_key():
    try:
        OpenRouterProvider(api_key=None)
    except RuntimeError as exc:
        assert "OPENROUTER_API_KEY" in str(exc)
    else:
        raise AssertionError("OpenRouterProvider should require an API key")


def test_openrouter_provider_configuration():
    provider = OpenRouterProvider(
        base_url="https://openrouter.ai/api/v1",
        model="openai/gpt-4o-mini",
        api_key="test-key",
    )

    assert provider.base_url == "https://openrouter.ai/api/v1"
    assert provider.model == "openai/gpt-4o-mini"
    assert provider.api_key == "test-key"
    assert provider.display_name == "OpenRouter"
    assert provider.capabilities.local is False
    assert provider.capabilities.requires_api_key is True
    assert provider.capabilities.tools is True
    assert provider.capabilities.model_listing is True
    assert isinstance(provider, OpenAICompatibleProvider)


def test_openrouter_provider_default_base_url_and_model():
    provider = OpenRouterProvider(api_key="test-key")
    assert provider.base_url == "https://openrouter.ai/api/v1"
    assert provider.model == "openai/gpt-4o-mini"


def test_openrouter_passes_model_slug_unchanged():
    """Gateway must not rewrite provider/model slugs."""
    slug = "anthropic/claude-sonnet-4"
    provider = OpenRouterProvider(api_key="test-key", model=slug)
    assert provider.model == slug

    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {
        "choices": [{"message": {"role": "assistant", "content": "ok"}}]
    }
    mock_response.raise_for_status = Mock()

    with patch(
        "openai_compatible.requests.post", return_value=mock_response
    ) as post:
        provider.generate([{"role": "user", "content": "hi"}])

    assert post.call_args.kwargs["json"]["model"] == slug


def test_openrouter_model_override_preserves_slug(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "key")
    monkeypatch.setenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")

    provider = get_provider("openrouter", model="meta-llama/llama-3.1-70b-instruct")
    assert isinstance(provider, OpenRouterProvider)
    assert provider.model == "meta-llama/llama-3.1-70b-instruct"
    assert provider.provider_config.model == "meta-llama/llama-3.1-70b-instruct"


def test_openrouter_optional_attribution_headers():
    provider = OpenRouterProvider(
        api_key="test-key",
        http_referer="https://example.com",
        app_title="AI Terminal Chat",
    )
    headers = provider._headers()
    assert headers["Authorization"] == "Bearer test-key"
    assert headers["HTTP-Referer"] == "https://example.com"
    assert headers["X-Title"] == "AI Terminal Chat"


def test_openrouter_omits_attribution_headers_when_unset():
    provider = OpenRouterProvider(api_key="test-key")
    headers = provider._headers()
    assert "HTTP-Referer" not in headers
    assert "X-Title" not in headers


def test_openrouter_provider_sends_bearer_auth():
    provider = OpenRouterProvider(
        base_url="https://openrouter.ai/api/v1",
        model="openai/gpt-4o-mini",
        api_key="or-test-key",
    )
    response = Mock(status_code=200)
    response.json.return_value = {
        "data": [{"id": "openai/gpt-4o-mini"}, {"id": "anthropic/claude-sonnet-4"}]
    }

    with patch("openai_compatible.requests.request", return_value=response) as request:
        models = provider.list_models()

    assert models == [
        {"id": "openai/gpt-4o-mini"},
        {"id": "anthropic/claude-sonnet-4"},
    ]
    assert request.call_args.kwargs["headers"]["Authorization"] == "Bearer or-test-key"
    assert request.call_args.args[:2] == (
        "GET",
        "https://openrouter.ai/api/v1/models",
    )


def test_openrouter_provider_parses_tool_calls_with_ids():
    provider = OpenRouterProvider(api_key="test-key")

    response = provider._parse_completion(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_or_1",
                                "type": "function",
                                "function": {
                                    "name": "list_files",
                                    "arguments": '{"path": "."}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )

    assert response.tool_calls[0].name == "list_files"
    assert response.tool_calls[0].id == "call_or_1"


def test_openrouter_provider_tool_result_round_trip():
    provider = OpenRouterProvider(api_key="test-key")
    contents = [
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call_or_rt",
                    "function": {"name": "list_files", "arguments": "{}"},
                }
            ],
        }
    ]
    updated = provider.append_tool_results(
        contents,
        [{"name": "list_files", "result": {"ok": True}}],
    )
    assert updated[-1]["tool_call_id"] == "call_or_rt"


def test_openrouter_provider_generate_posts_chat_completions():
    provider = OpenRouterProvider(
        base_url="https://openrouter.ai/api/v1",
        model="openai/gpt-4o",
        api_key="or-key",
        http_referer="https://example.com/app",
        app_title="Terminal",
    )
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {
        "choices": [{"message": {"role": "assistant", "content": "ok"}}]
    }
    mock_response.raise_for_status = Mock()

    with patch(
        "openai_compatible.requests.post", return_value=mock_response
    ) as post:
        result = provider.generate([{"role": "user", "content": "hi"}])

    assert result.text == "ok"
    assert post.call_args.args[0] == "https://openrouter.ai/api/v1/chat/completions"
    headers = post.call_args.kwargs["headers"]
    assert headers["Authorization"] == "Bearer or-key"
    assert headers["HTTP-Referer"] == "https://example.com/app"
    assert headers["X-Title"] == "Terminal"
    assert post.call_args.kwargs["json"]["model"] == "openai/gpt-4o"
    assert "tools" in post.call_args.kwargs["json"]


def test_openrouter_provider_unreachable_probe():
    provider = OpenRouterProvider(api_key="test-key")

    with patch(
        "openai_compatible.requests.request",
        side_effect=ConnectionError("connection refused"),
    ):
        result = provider.probe()

    assert result["available"] is False
    assert "Could not reach OpenRouter" in result["error"]


def test_provider_factory_uses_dedicated_openrouter_provider(monkeypatch):
    monkeypatch.setenv("PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "factory-or-key")
    monkeypatch.setenv("OPENROUTER_MODEL", "google/gemini-2.0-flash")
    monkeypatch.setenv("OPENROUTER_HTTP_REFERER", "https://localhost")
    monkeypatch.setenv("OPENROUTER_APP_TITLE", "AI Terminal Chat")

    provider = get_provider()

    assert isinstance(provider, OpenRouterProvider)
    assert provider.name == "openrouter"
    assert provider.model == "google/gemini-2.0-flash"
    assert provider.api_key == "factory-or-key"
    assert provider.http_referer == "https://localhost"
    assert provider.app_title == "AI Terminal Chat"
    assert "api_key" not in provider.provider_config.to_public_dict()


def test_provider_factory_openrouter_missing_key_raises(monkeypatch):
    monkeypatch.setenv("PROVIDER", "openrouter")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    try:
        get_provider("openrouter")
    except RuntimeError as exc:
        assert "OPENROUTER_API_KEY" in str(exc)
    else:
        raise AssertionError(
            "get_provider('openrouter') should require OPENROUTER_API_KEY"
        )


def test_openrouter_public_config_never_includes_api_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret-or-key-should-not-leak")
    monkeypatch.setenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")

    provider = get_provider("openrouter")
    public = provider.provider_config.to_public_dict()
    assert "api_key" not in public
    assert "secret" not in str(public).lower()
    assert public["provider"] == "openrouter"
    assert public["base_url"] == "https://openrouter.ai/api/v1"


# --- Anthropic (native Messages API) ---


def test_anthropic_is_in_supported_providers():
    assert "anthropic" in SUPPORTED_PROVIDERS


def test_anthropic_provider_requires_api_key():
    try:
        AnthropicProvider(api_key=None)
    except RuntimeError as exc:
        assert "ANTHROPIC_API_KEY" in str(exc)
    else:
        raise AssertionError("AnthropicProvider should require an API key")


def test_anthropic_provider_configuration():
    provider = AnthropicProvider(
        api_key="test-key",
        model="claude-sonnet-4-5",
        base_url="https://api.anthropic.com",
    )
    assert provider.model == "claude-sonnet-4-5"
    assert provider.base_url == "https://api.anthropic.com"
    assert provider.api_key == "test-key"
    assert provider.capabilities.requires_api_key is True
    assert provider.capabilities.tools is True
    assert provider.capabilities.model_listing is False
    assert provider.capabilities.local is False
    assert not isinstance(provider, OpenAICompatibleProvider)


def test_anthropic_headers_use_x_api_key():
    provider = AnthropicProvider(api_key="sk-ant-test")
    headers = provider._headers()
    assert headers["x-api-key"] == "sk-ant-test"
    assert headers["anthropic-version"] == "2023-06-01"
    assert "Authorization" not in headers


def test_anthropic_build_contents_maps_model_role_and_omits_system():
    provider = AnthropicProvider(api_key="test-key")
    contents = provider.build_contents(
        "follow up",
        [
            {"role": "user", "parts": [{"text": "hello"}]},
            {"role": "model", "parts": [{"text": "hi"}]},
        ],
    )
    assert all(item["role"] in ("user", "assistant") for item in contents)
    assert contents[-1] == {
        "role": "user",
        "content": [{"type": "text", "text": "follow up"}],
    }
    assert any(
        item["role"] == "assistant"
        and item["content"][0]["text"] == "hi"
        for item in contents
    )


def test_anthropic_parses_text_response():
    provider = AnthropicProvider(api_key="test-key")
    response = provider._parse_message(
        {
            "content": [{"type": "text", "text": "Hello from Claude"}],
            "stop_reason": "end_turn",
        }
    )
    assert response.text == "Hello from Claude"
    assert response.tool_calls == []


def test_anthropic_parses_tool_use_with_ids():
    provider = AnthropicProvider(api_key="test-key")
    response = provider._parse_message(
        {
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_01ABC",
                    "name": "list_files",
                    "input": {"path": "."},
                }
            ],
            "stop_reason": "tool_use",
        }
    )
    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].name == "list_files"
    assert response.tool_calls[0].args == {"path": "."}
    assert response.tool_calls[0].id == "toolu_01ABC"
    assert response.text is None


def test_anthropic_tool_result_round_trip_uses_tool_use_id():
    provider = AnthropicProvider(api_key="test-key")
    contents = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_99",
                    "name": "list_files",
                    "input": {"path": "."},
                }
            ],
        }
    ]
    updated = provider.append_tool_results(
        contents,
        [{"name": "list_files", "result": {"entries": ["a.py"]}}],
    )
    assert updated[-1]["role"] == "user"
    block = updated[-1]["content"][0]
    assert block["type"] == "tool_result"
    assert block["tool_use_id"] == "toolu_99"
    assert "a.py" in block["content"]


def test_anthropic_append_model_turn_preserves_raw():
    provider = AnthropicProvider(api_key="test-key")
    raw = {
        "role": "assistant",
        "content": [
            {
                "type": "tool_use",
                "id": "toolu_1",
                "name": "read_file",
                "input": {"path": "x"},
            }
        ],
    }
    response = ProviderResponse(
        text=None,
        tool_calls=[ToolCall("read_file", {"path": "x"}, id="toolu_1")],
        raw=raw,
    )
    updated = provider.append_model_turn([], response)
    assert updated[-1] is raw or updated[-1] == raw


def test_anthropic_generate_posts_messages_api():
    provider = AnthropicProvider(
        api_key="sk-ant",
        model="claude-sonnet-4-5",
        base_url="https://api.anthropic.com",
    )
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {
        "content": [{"type": "text", "text": "ok"}],
        "stop_reason": "end_turn",
    }
    mock_response.raise_for_status = Mock()

    with patch(
        "anthropic_provider.requests.post", return_value=mock_response
    ) as post:
        result = provider.generate(
            [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
        )

    assert result.text == "ok"
    assert post.call_args.args[0] == "https://api.anthropic.com/v1/messages"
    headers = post.call_args.kwargs["headers"]
    assert headers["x-api-key"] == "sk-ant"
    assert headers["anthropic-version"] == "2023-06-01"
    payload = post.call_args.kwargs["json"]
    assert payload["model"] == "claude-sonnet-4-5"
    assert payload["max_tokens"] == 8192
    assert "system" in payload
    assert "tools" in payload
    assert payload["tools"][0]["input_schema"]


def test_anthropic_list_models_empty():
    provider = AnthropicProvider(api_key="test-key")
    assert provider.list_models() == []


def test_provider_factory_uses_anthropic_provider(monkeypatch):
    monkeypatch.setenv("PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "factory-ant-key")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    provider = get_provider()
    assert isinstance(provider, AnthropicProvider)
    assert provider.name == "anthropic"
    assert provider.model == "claude-sonnet-4-5"
    assert provider.api_key == "factory-ant-key"
    assert "api_key" not in provider.provider_config.to_public_dict()


def test_provider_factory_anthropic_missing_key_raises(monkeypatch):
    monkeypatch.setenv("PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    try:
        get_provider("anthropic")
    except RuntimeError as exc:
        assert "ANTHROPIC_API_KEY" in str(exc)
    else:
        raise AssertionError(
            "get_provider('anthropic') should require ANTHROPIC_API_KEY"
        )


def test_anthropic_public_config_never_includes_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret-ant-key-should-not-leak")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    provider = get_provider("anthropic")
    public = provider.provider_config.to_public_dict()
    assert "api_key" not in public
    assert "secret" not in str(public).lower()
    assert public["provider"] == "anthropic"


# --- User Instructions ---


def test_openai_compatible_build_contents_appends_user_instructions_to_system():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    contents = provider.build_contents(
        "hi",
        [],
        user_instructions="Prefer TypeScript.",
    )

    assert contents[0]["role"] == "system"
    assert "Prefer TypeScript." in contents[0]["content"]
    assert "You are a local coding/project agent" in contents[0]["content"]


def test_openai_compatible_build_contents_omits_user_instructions_when_none():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    contents = provider.build_contents("hi", [])

    assert contents[0]["role"] == "system"
    assert "You are a local coding/project agent" in contents[0]["content"]
    assert "Prefer TypeScript." not in contents[0]["content"]


def test_openai_compatible_build_contents_treats_empty_instructions_as_none():
    provider = OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
    )

    contents = provider.build_contents("hi", [], user_instructions="   ")

    assert contents[0]["role"] == "system"
    assert "You are a local coding/project agent" in contents[0]["content"]
    assert "You are a local coding/project agent\n\n" not in contents[0]["content"]


def test_anthropic_build_contents_stores_user_instructions_for_payload():
    provider = AnthropicProvider(api_key="test-key")
    provider.build_contents("hi", [], user_instructions="Use tabs.")
    payload = provider._payload([], use_tools=True)
    assert "Use tabs." in payload["system"]
    assert "You are a local coding/project agent" in payload["system"]


def test_anthropic_payload_omits_user_instructions_when_none():
    provider = AnthropicProvider(api_key="test-key")
    provider.build_contents("hi", [])
    payload = provider._payload([], use_tools=True)
    assert "You are a local coding/project agent" in payload["system"]
    assert "Use tabs." not in payload["system"]


def test_gemini_build_contents_stores_user_instructions():
    from unittest.mock import Mock, patch
    from google.genai import types

    fake_client = Mock()
    with patch("gemini.genai.Client", return_value=fake_client):
        from gemini import GeminiProvider

        provider = GeminiProvider(api_key="test-key", model="gemini-3.6-flash")

    provider.build_contents("hi", [], user_instructions="Be concise.")
    fake_client.models.generate_content.assert_not_called()

    fake_client.reset_mock()
    fake_response = Mock()
    fake_model_content = Mock()
    fake_part = Mock(text="ok")
    fake_part.function_call = None
    fake_model_content.parts = [fake_part]
    fake_model_content.text = "ok"
    fake_response.candidates = [Mock(content=fake_model_content)]
    fake_client.models.generate_content.return_value = fake_response

    provider.generate([types.Content(role="user", parts=[types.Part.from_text(text="hi")])])

    call_kwargs = fake_client.models.generate_content.call_args.kwargs
    config = call_kwargs.get("config")
    assert config is not None
    assert "Be concise." in config.system_instruction
    assert "You are a local coding/project agent" in config.system_instruction
