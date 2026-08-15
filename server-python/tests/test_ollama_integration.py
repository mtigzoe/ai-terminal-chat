"""Real end-to-end Ollama integration test.

Unlike the rest of the provider test suite, this test talks to an
actual Ollama server instead of mocking `requests`. The unit tests in
test_providers.py verify HTTP request/response shapes; this verifies
the whole reason the Ollama provider exists — that a live local model
can carry a conversation and call a project tool through the real
backend loop, exactly as it would through the /chat endpoint in
production:

    Windows Flask -> cyber.local:11434 -> Linux Ollama -> model ->
    tool call -> Windows Flask tool execution

Skipped by default. Opt in by pointing at a running `ollama serve`
(locally or over the network) with a pulled model:

    OLLAMA_INTEGRATION_TEST=1 pytest tests/test_ollama_integration.py

    # or, equivalently, if these are already set for real use:
    OLLAMA_BASE_URL=http://cyber.local:11434 OLLAMA_MODEL=qwen3.5:9b \\
        pytest tests/test_ollama_integration.py

If the server configured this way is unreachable, or has no models
pulled, individual tests skip themselves with an actionable reason
rather than failing — an offline dev machine or CI runner without
Ollama installed should never see a red build for this file.
"""

import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from agent import run_agent_loop  # noqa: E402
from ollama import OllamaProvider  # noqa: E402
from tools import TOOL_FUNCTIONS  # noqa: E402


def _integration_enabled() -> bool:
    return bool(
        os.getenv("OLLAMA_INTEGRATION_TEST")
        or os.getenv("OLLAMA_BASE_URL")
        or os.getenv("OLLAMA_HOST")
    )


def _make_provider() -> OllamaProvider:
    base_url = (
        os.getenv("OLLAMA_BASE_URL")
        or os.getenv("OLLAMA_HOST")
        or "http://localhost:11434/v1"
    )
    model = os.getenv("OLLAMA_MODEL", "qwen3.5:9b")
    return OllamaProvider(base_url=base_url, model=model, timeout=60)


pytestmark = pytest.mark.skipif(
    not _integration_enabled(),
    reason=(
        "Set OLLAMA_INTEGRATION_TEST=1 (or OLLAMA_BASE_URL/OLLAMA_HOST) "
        "to run the live Ollama integration test against a real server."
    ),
)


@pytest.fixture(scope="module")
def live_provider():
    provider = _make_provider()
    probe = provider.probe()
    if not probe["available"]:
        pytest.skip(
            f"Ollama is not reachable at {provider.native_base_url}: "
            f"{probe['error']}. Start `ollama serve` (and confirm "
            "OLLAMA_BASE_URL/OLLAMA_HOST) to run this test."
        )
    return provider


def test_ollama_server_is_reachable(live_provider):
    result = live_provider.probe()
    assert result["available"] is True
    assert result["error"] is None


def test_ollama_lists_at_least_one_installed_model(live_provider):
    models = live_provider.list_models()
    assert isinstance(models, list)
    assert len(models) >= 1, (
        "Ollama is reachable but reports no installed models. Run "
        f"`ollama pull {live_provider.model}` and retry."
    )


def test_ollama_chat_only_round_trip(live_provider):
    """A plain chat turn with no tool calling involved."""

    contents = live_provider.build_contents(
        "Reply with exactly one word: hello", []
    )
    response = live_provider.generate(contents)

    assert response.text
    assert isinstance(response.text, str)


def test_ollama_full_tool_call_round_trip(live_provider):
    """Exercise the complete split-machine architecture end to end:

    provider.generate() asks the real model for a tool call, the real
    agent loop executes it against the real `list_files` tool, the
    result is sent back to the model, and the model produces a final
    answer — the same path /chat uses in production.
    """

    if not live_provider.capabilities.tools:
        live_provider.refresh_capabilities()
    if not live_provider.capabilities.tools:
        pytest.skip(
            f"Model {live_provider.model} does not advertise tool "
            "calling; cannot exercise the tool-call round trip. Try a "
            "model built for function calling (e.g. qwen3.5, llama3.1)."
        )

    contents = live_provider.build_contents(
        'Call the list_files tool with path "." to see what is in the '
        "current directory, then briefly tell me how many entries it "
        "returned. You must call the tool rather than guessing.",
        [],
    )

    calls = []
    original_list_files = TOOL_FUNCTIONS.get("list_files")

    def counting_list_files(*args, **kwargs):
        calls.append((args, kwargs))
        return original_list_files(*args, **kwargs)

    TOOL_FUNCTIONS["list_files"] = counting_list_files
    try:
        events = list(run_agent_loop(live_provider, contents))
    finally:
        TOOL_FUNCTIONS["list_files"] = original_list_files

    tool_calls = [e for e in events if e["type"] == "tool_call"]
    tool_results = [e for e in events if e["type"] == "tool_result"]
    final = [e for e in events if e["type"] == "final"]

    assert calls, (
        "The model never actually invoked list_files — check that "
        f"{live_provider.model} supports tool calling and that the "
        "backend->Ollama->model->tool-call->backend path is wired up "
        "correctly end to end."
    )
    assert tool_calls, "No tool_call event was emitted by the agent loop."
    assert not any(
        isinstance(r["result"], dict) and r["result"].get("error")
        for r in tool_results
    ), f"Tool execution reported an error: {tool_results}"
    assert final, "Agent loop never reached a final answer after the tool call."
    assert final[-1]["text"], "Final answer text was empty."
