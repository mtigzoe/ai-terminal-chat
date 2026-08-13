"""Provider abstraction for the tool-calling agent loop.

A Provider hides everything specific to one backend's chat/tool-
calling API — Gemini's google-genai SDK vs. an OpenAI-compatible
`/chat/completions` endpoint (Ollama, the Kilo gateway, OpenAI) —
behind four methods. agent.run_agent_loop() only ever talks to this
interface, so it doesn't need to know or care which backend is live.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ToolCall:
    """One tool invocation the model asked for, already normalized."""

    name: str
    args: dict


@dataclass
class ProviderResponse:
    """One model turn, normalized across providers.

    Exactly one of `text` or a non-empty `tool_calls` is meaningful at
    a time: a provider turn either asks for more tool calls, or gives
    a final text answer. `raw` carries whatever provider-specific
    object append_model_turn() needs to preserve this turn in the
    conversation — nothing outside a Provider implementation should
    need to touch it.
    """

    text: Optional[str]
    tool_calls: list = field(default_factory=list)
    raw: Any = None


class Provider(ABC):
    """One backend's chat + tool-calling API, normalized to 4 methods."""

    @abstractmethod
    def build_contents(self, msg: str, history: list) -> list:
        """Turn the frontend's (msg, history) into this provider's
        native conversation representation."""

    @abstractmethod
    def generate(self, contents: list) -> ProviderResponse:
        """Ask the model for its next turn given the conversation so far."""

    @abstractmethod
    def append_model_turn(self, contents: list, response: ProviderResponse) -> list:
        """Return a new contents list with the model's turn (the
        ProviderResponse just returned by generate()) appended, so
        it's preserved for the next round."""

    @abstractmethod
    def append_tool_results(self, contents: list, results: list) -> list:
        """Return a new contents list with tool results appended in
        this provider's expected format.

        `results` is a list of {"name": str, "result": dict}, in the
        same order as the ToolCalls on the ProviderResponse that was
        just handled.
        """
