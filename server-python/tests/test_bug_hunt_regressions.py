"""Regression tests for base-URL validation and provider response parsing.

Each test here pins a defect that was confirmed by direct reproduction before
being fixed.
"""

import sys
from pathlib import Path
from urllib.parse import urlsplit

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

# Imported after sys.path is set up, matching the convention in
# test_ollama_offline.py so this module is runnable on its own.
import ollama
import security
from openai_compatible import OpenAICompatibleProvider

# ---------------------------------------------------------------------------
# validate_provider_base_url rebuilt the authority from ``urlparse().hostname``,
# which strips the brackets around an IPv6 literal. The rebuilt URL was
# therefore not a URL: ``http://[2606:4700:4700::1111]:8080`` came back as
# ``http://2606:4700:4700::1111:8080``, which re-parses with hostname "2606"
# and raises ValueError on the port.
# ---------------------------------------------------------------------------

class TestIPv6BaseUrlRoundTrip:
    @pytest.mark.parametrize(
        "raw",
        [
            "http://[2606:4700:4700::1111]:8080",
            "https://[2606:4700:4700::1111]:8080/v1",
            "https://[2606:4700:4700::1111]/v1",
            "https://[2001:4860:4860::8888]:443",
        ],
    )
    def test_ipv6_brackets_are_preserved(self, raw):
        result = security.validate_provider_base_url(raw)

        assert "[" in result and "]" in result, result
        parsed = urlsplit(result)  # must not raise
        # The hostname must survive the round trip intact, not be truncated at
        # the first colon.
        assert parsed.hostname == urlsplit(raw).hostname
        # A bracketed authority must never re-parse to a single-label host.
        assert parsed.hostname.count(":") > 1

    def test_ipv4_and_hostname_urls_are_unchanged(self):
        for raw in [
            "http://example.com:8080/v1",
            "https://api.kilo.ai/api/gateway",
            "http://8.8.8.8:11434/v1",
        ]:
            result = security.validate_provider_base_url(raw)
            assert result == raw
            assert urlsplit(result).hostname == urlsplit(raw).hostname

    def test_blocked_ipv6_still_rejected(self):
        # The fix must not weaken the existing private/reserved checks.
        for raw in [
            "http://[::1]:11434/v1",
            "http://[fe80::1]:8080/v1",
            "http://[fc00::1]:8080/v1",
        ]:
            with pytest.raises(ValueError):
                security.validate_provider_base_url(raw)


# ---------------------------------------------------------------------------
# _parse_completion trusted the provider's ``tool_calls`` payload. A
# non-dict entry raised AttributeError, a non-str/bytes ``arguments`` value
# raised TypeError (json.loads raises TypeError, not JSONDecodeError), and any
# valid-but-non-object JSON ("[1,2]", '"x"', "5") was stored as ToolCall.args.
# Downstream, agent.py does ``dict(call.args or {})``, so those raised
# TypeError/ValueError, while ``null`` silently ran the tool with no arguments.
# ---------------------------------------------------------------------------

def _provider():
    return OpenAICompatibleProvider(
        base_url="http://localhost:11434/v1",
        model="test-model",
        api_key="test-key",
        display_name="Test",
        local=True,
        requires_api_key=False,
    )


def _parse(tool_calls):
    provider = _provider()
    return provider._parse_completion(
        {"choices": [{"message": {"content": None, "tool_calls": tool_calls}}]}
    )


def _call(arguments, function_is_dict=True):
    function = {"name": "create_file", "arguments": arguments}
    return {"id": "call_1", "function": function if function_is_dict else "nope"}


class TestMalformedToolCalls:
    @pytest.mark.parametrize(
        "arguments",
        [
            12345,             # int -> json.loads raises TypeError
            True,
            ["a"],             # list, not a dict
            "[1,2]",           # valid JSON, wrong type
            '"hello"',         # valid JSON, wrong type
            "5",               # valid JSON, wrong type
            "null",            # valid JSON, wrong type -> ran with no args
            "{oops",           # undecodable
            "",                # falsy -> treated as "{}"
        ],
    )
    def test_bad_arguments_degrade_to_empty_dict(self, arguments):
        response = _parse([_call(arguments)])
        assert len(response.tool_calls) == 1
        args = response.tool_calls[0].args
        assert args == {}
        # Must survive the downstream conversion the agent loop performs.
        assert dict(args or {}) == {}

    def test_valid_arguments_are_preserved(self):
        response = _parse([_call('{"path": "a.txt"}')])
        assert response.tool_calls[0].args == {"path": "a.txt"}
        assert response.tool_calls[0].name == "create_file"
        assert response.tool_calls[0].id == "call_1"

    def test_dict_arguments_pass_through(self):
        response = _parse([_call({"path": "b.txt"})])
        assert response.tool_calls[0].args == {"path": "b.txt"}

    @pytest.mark.parametrize(
        "entry",
        [
            "not-a-dict",
            42,
            None,
            {"id": "x"},                                  # no "function"
            {"id": "x", "function": "nope"},               # function not a dict
            {"id": "x", "function": None},
        ],
    )
    def test_malformed_entries_are_skipped_not_raised(self, entry):
        response = _parse([entry])
        assert response.tool_calls == []

    def test_malformed_entry_does_not_discard_valid_siblings(self):
        response = _parse(["junk", _call('{"path": "ok.txt"}')])
        assert len(response.tool_calls) == 1
        assert response.tool_calls[0].args == {"path": "ok.txt"}

    def test_empty_tool_calls_list(self):
        response = _parse([])
        assert response.tool_calls == []


# ---------------------------------------------------------------------------
# OllamaProvider.list_models() called data.get(...) outside its try/except, so
# a 200 response carrying a JSON array or string raised AttributeError that
# escaped the function's error handling and surfaced as a 502.
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class TestOllamaListModelsShape:
    def _provider(self, payload):
        provider = ollama.OllamaProvider(base_url="http://localhost:11434/v1", model="m")
        provider._native_request = lambda *a, **k: _FakeResponse(payload)
        return provider

    @pytest.mark.parametrize("payload", [[], ["a"], "gpt-4o", 5, None, True])
    def test_non_dict_body_returns_empty_list(self, payload):
        assert self._provider(payload).list_models() == []

    def test_dict_body_with_models(self):
        provider = self._provider(
            {"models": [{"name": "llama3.1", "size": 1, "digest": "abc", "details": {}}]}
        )
        assert provider.list_models() == [
            {"id": "llama3.1", "size": 1, "digest": "abc", "details": {}}
        ]

    def test_dict_body_without_models_key(self):
        assert self._provider({}).list_models() == []
