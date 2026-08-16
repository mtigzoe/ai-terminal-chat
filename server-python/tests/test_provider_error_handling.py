"""Provider-adapter error handling: malformed responses and timeouts.

test_providers.py already covers unreachable-server and HTTP-error
status codes for these adapters. What was missing is coverage for a
*reachable* server that responds with something unexpected: a body
missing expected keys, a non-JSON body, an empty candidate list, or a
request that times out rather than failing outright. Every one of
these must surface as a clear RuntimeError that agent.py's existing
`except Exception` around provider.generate() turns into a normal
error event — never an unhandled exception that could crash the
request.
"""

import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from anthropic_provider import AnthropicProvider  # noqa: E402
from openai_provider import OpenAIProvider  # noqa: E402


# ---------------------------------------------------------
# OpenAI-compatible family (also covers Kilo, xAI, OpenRouter, Ollama,
# which all share OpenAICompatibleProvider.generate()/_parse_completion)
# ---------------------------------------------------------


def test_openai_compatible_missing_choices_key_raises_clear_error():
    provider = OpenAIProvider(api_key="test-key")
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {"unexpected": "shape"}
    mock_response.raise_for_status = Mock()

    with patch("openai_compatible.requests.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="Unexpected response shape"):
            provider.generate([{"role": "user", "content": "hi"}])


def test_openai_compatible_empty_choices_list_raises_clear_error():
    provider = OpenAIProvider(api_key="test-key")
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {"choices": []}
    mock_response.raise_for_status = Mock()

    with patch("openai_compatible.requests.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="Unexpected response shape"):
            provider.generate([{"role": "user", "content": "hi"}])


def test_openai_compatible_non_json_body_raises_clear_error():
    """A 200 response whose body isn't valid JSON must fail with a
    clear, provider-attributed RuntimeError (matching how the
    Anthropic adapter already handles this) rather than leaking a
    raw ValueError with no context about which provider failed.
    """

    provider = OpenAIProvider(api_key="test-key")
    mock_response = Mock(status_code=200)
    mock_response.json.side_effect = ValueError("Expecting value: line 1 column 1")
    mock_response.text = "<html>not json</html>"
    mock_response.raise_for_status = Mock()

    with patch("openai_compatible.requests.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="non-JSON response body"):
            provider.generate([{"role": "user", "content": "hi"}])


def test_openai_compatible_malformed_tool_call_arguments_degrade_gracefully():
    """Malformed (non-JSON) tool_call arguments from the model must not
    crash parsing — the call should come through with empty args
    rather than raising, so the agent loop can still report a normal
    tool-execution error instead of losing the whole turn.
    """

    provider = OpenAIProvider(api_key="test-key")
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "function": {
                                "name": "read_file",
                                "arguments": "{not valid json",
                            },
                        }
                    ],
                }
            }
        ]
    }
    mock_response.raise_for_status = Mock()

    with patch("openai_compatible.requests.post", return_value=mock_response):
        result = provider.generate([{"role": "user", "content": "hi"}])

    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "read_file"
    assert result.tool_calls[0].args == {}


def test_openai_compatible_timeout_raises_actionable_runtime_error():
    provider = OpenAIProvider(api_key="test-key")

    with patch(
        "openai_compatible.requests.post",
        side_effect=requests.Timeout("Read timed out"),
    ):
        with pytest.raises(RuntimeError, match="Could not reach OpenAI"):
            provider.generate([{"role": "user", "content": "hi"}])


def test_openai_compatible_connection_error_is_wrapped_not_raw():
    """A raw ConnectionError must never reach the agent loop unwrapped —
    it should always come back as an actionable RuntimeError.
    """

    provider = OpenAIProvider(api_key="test-key")

    with patch(
        "openai_compatible.requests.post",
        side_effect=requests.ConnectionError("Connection refused"),
    ):
        try:
            provider.generate([{"role": "user", "content": "hi"}])
        except RuntimeError as exc:
            assert "OpenAI" in str(exc)
        except requests.ConnectionError:
            raise AssertionError(
                "raw requests.ConnectionError leaked instead of being wrapped"
            )


# ---------------------------------------------------------
# Gemini
# ---------------------------------------------------------


def test_gemini_generate_raises_when_no_candidates():
    fake_response = Mock(candidates=[])
    fake_client = Mock()
    fake_client.models.generate_content.return_value = fake_response

    with patch("gemini.genai.Client", return_value=fake_client):
        from gemini import GeminiProvider

        provider = GeminiProvider(api_key="test-key", model="gemini-3.6-flash")
        with pytest.raises(RuntimeError, match="no response candidates"):
            provider.generate([])


def test_gemini_generate_raises_when_content_is_empty():
    fake_candidate = Mock()
    fake_candidate.content = None
    fake_response = Mock(candidates=[fake_candidate])
    fake_client = Mock()
    fake_client.models.generate_content.return_value = fake_response

    with patch("gemini.genai.Client", return_value=fake_client):
        from gemini import GeminiProvider

        provider = GeminiProvider(api_key="test-key", model="gemini-3.6-flash")
        with pytest.raises(RuntimeError, match="empty response"):
            provider.generate([])


def test_gemini_generate_raises_when_parts_are_empty():
    fake_content = Mock(parts=[])
    fake_candidate = Mock(content=fake_content)
    fake_response = Mock(candidates=[fake_candidate])
    fake_client = Mock()
    fake_client.models.generate_content.return_value = fake_response

    with patch("gemini.genai.Client", return_value=fake_client):
        from gemini import GeminiProvider

        provider = GeminiProvider(api_key="test-key", model="gemini-3.6-flash")
        with pytest.raises(RuntimeError, match="empty response"):
            provider.generate([])


# ---------------------------------------------------------
# Anthropic
# ---------------------------------------------------------


def test_anthropic_unexpected_content_shape_raises_clear_error():
    provider = AnthropicProvider(api_key="sk-ant")
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {"content": "not-a-list"}
    mock_response.raise_for_status = Mock()

    with patch("anthropic_provider.requests.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="Unexpected Anthropic response shape"):
            provider.generate([{"role": "user", "content": [{"type": "text", "text": "hi"}]}])


def test_anthropic_non_json_body_raises_clear_error():
    provider = AnthropicProvider(api_key="sk-ant")
    mock_response = Mock(status_code=200)
    mock_response.json.side_effect = ValueError("Expecting value")
    mock_response.text = "<html>not json</html>"
    mock_response.raise_for_status = Mock()

    with patch("anthropic_provider.requests.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="non-JSON body"):
            provider.generate([{"role": "user", "content": [{"type": "text", "text": "hi"}]}])


def test_anthropic_timeout_raises_actionable_runtime_error():
    provider = AnthropicProvider(api_key="sk-ant")

    with patch(
        "anthropic_provider.requests.post",
        side_effect=requests.Timeout("Read timed out"),
    ):
        with pytest.raises(RuntimeError, match="Could not reach Anthropic"):
            provider.generate([{"role": "user", "content": [{"type": "text", "text": "hi"}]}])


def test_anthropic_malformed_tool_use_input_defaults_to_empty_dict():
    """A tool_use block whose `input` isn't a JSON object must not
    crash parsing — degrade to empty args instead.
    """

    provider = AnthropicProvider(api_key="sk-ant")
    mock_response = Mock(status_code=200)
    mock_response.json.return_value = {
        "content": [
            {
                "type": "tool_use",
                "id": "toolu_1",
                "name": "read_file",
                "input": "not-a-dict",
            }
        ],
    }
    mock_response.raise_for_status = Mock()

    with patch("anthropic_provider.requests.post", return_value=mock_response):
        result = provider.generate(
            [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
        )

    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "read_file"
    assert result.tool_calls[0].args == {}
