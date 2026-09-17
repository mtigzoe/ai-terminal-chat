"""Regression tests for OpenAI-compatible error classification."""

import sys
from pathlib import Path
from types import SimpleNamespace

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from openai_compatible import looks_like_tools_unsupported  # noqa: E402


def _exception(status_code, text):
    exc = RuntimeError("provider request failed")
    exc.response = SimpleNamespace(status_code=status_code, text=text)
    return exc


def test_tool_fallback_detects_explicit_tool_rejection():
    exc = _exception(400, "This model does not support tools.")
    assert looks_like_tools_unsupported(exc) is True


def test_tool_fallback_detects_unknown_tools_field():
    exc = _exception(422, "Unknown field 'tools' in request body.")
    assert looks_like_tools_unsupported(exc) is True


def test_tool_fallback_does_not_match_unrelated_invalid_parameter():
    exc = _exception(400, "Invalid parameter: temperature must be between 0 and 2.")
    assert looks_like_tools_unsupported(exc) is False


def test_tool_fallback_does_not_match_unrelated_unsupported_error():
    exc = _exception(400, "Unsupported response format 'xml'.")
    assert looks_like_tools_unsupported(exc) is False


def test_tool_fallback_does_not_match_tool_word_in_unrelated_error():
    exc = _exception(400, "Tool 'read_file' returned an invalid path argument.")
    assert looks_like_tools_unsupported(exc) is False


def test_tool_fallback_rejects_non_client_error_status():
    exc = _exception(500, "This model does not support tools.")
    assert looks_like_tools_unsupported(exc) is False
