"""Tests for resuming the agent loop after a confirmation is resolved.

Before this, confirming (or declining) a pending write/git action executed
that one tool in isolation and stopped — the model never found out what
happened, so a natural-language request like "add, commit, and push"
required the user to re-ask for every remaining step by hand. These tests
cover agent.resume_agent_loop() directly and the /confirm route end to end,
verifying that a multi-step git workflow now completes across successive
Allow clicks, that declining lets the model react instead of the
conversation just stopping, and that other tool calls already queued up in
the same model turn still run once the confirmed one is resolved.
"""

import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import os  # noqa: E402

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import agent  # noqa: E402
import app  # noqa: E402
import security  # noqa: E402
import tools  # noqa: E402
from agent import resume_agent_loop, run_agent_loop  # noqa: E402
from base import Provider, ProviderResponse, ToolCall  # noqa: E402
from pending import clear_pending, get_pending  # noqa: E402


class ScriptedProvider(Provider):
    """A minimal Provider that returns a pre-scripted sequence of turns,
    like FakeProvider in test_agent.py, but also records every contents
    list it is asked to generate() from so tests can assert on it."""

    name = "scripted"
    model = "scripted-1"

    def __init__(self, responses):
        self.responses = iter(responses)
        self.generate_calls = []

    def build_contents(self, msg, history, user_instructions=None):
        return [{"role": "user", "content": msg}]

    def generate(self, contents):
        self.generate_calls.append(contents)
        return next(self.responses)

    def append_model_turn(self, contents, response):
        return contents + [{"role": "assistant", "tool_calls": response.tool_calls}]

    def append_tool_results(self, contents, results):
        return contents + [{"role": "tool", "results": results}]


@pytest.fixture
def git_repo_with_remote(tmp_path, monkeypatch):
    remote = tmp_path / "remote.git"
    remote.mkdir()
    subprocess.run(["git", "init", "--bare", str(remote)], check=True)

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=repo, check=True)

    (repo / "file.txt").write_text("initial\n")
    subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    subprocess.run(["git", "push", "-u", "origin", "main"], cwd=repo, check=True)

    monkeypatch.setattr(security, "PROJECT_ROOT", repo)
    monkeypatch.setattr(tools, "PROJECT_ROOT", repo)
    return repo


def _events_of_type(events, event_type):
    return [e for e in events if e["type"] == event_type]


def test_confirming_add_then_commit_then_push_completes_without_reasking(git_repo_with_remote):
    """The core scenario from the bug report: a single natural-language
    request that implies three git steps should finish across three Allow
    clicks, with the model seeing each result and moving on by itself."""

    (git_repo_with_remote / "file.txt").write_text("v2\n")

    provider = ScriptedProvider([
        ProviderResponse(text=None, tool_calls=[
            ToolCall("git_add", {"path": "file.txt"}),
            ToolCall("git_commit", {"message": "update file"}),
            ToolCall("git_push", {}),
        ]),
        ProviderResponse(text="Done — added, committed, and pushed file.txt."),
    ])

    events = list(run_agent_loop(provider, provider.build_contents("add, commit, and push", [])))
    pending = _events_of_type(events, "pending_confirmation")
    assert len(pending) == 1
    assert pending[0]["name"] == "git_add"
    action = get_pending(pending[0]["action_id"])
    assert action.resume is not None

    # Confirm git_add. The loop should immediately move on to git_commit
    # (queued in the same original model turn) rather than stopping.
    events = list(resume_agent_loop(provider, action, confirmed=True))
    results = _events_of_type(events, "tool_result")
    assert results[0]["name"] == "git_add"
    assert results[0]["result"].get("staged") is True
    pending = _events_of_type(events, "pending_confirmation")
    assert len(pending) == 1
    assert pending[0]["name"] == "git_commit"
    action = get_pending(pending[0]["action_id"])

    # Confirm git_commit -> should move on to git_push next.
    events = list(resume_agent_loop(provider, action, confirmed=True))
    results = _events_of_type(events, "tool_result")
    assert results[0]["name"] == "git_commit"
    assert results[0]["result"].get("committed") is True
    pending = _events_of_type(events, "pending_confirmation")
    assert len(pending) == 1
    assert pending[0]["name"] == "git_push"
    action = get_pending(pending[0]["action_id"])

    # Confirm git_push -> all three tool calls from the original turn are
    # now resolved, so the loop should call the provider again and finish
    # with the model's final text, exactly as if there had been no pauses.
    events = list(resume_agent_loop(provider, action, confirmed=True))
    results = _events_of_type(events, "tool_result")
    assert results[0]["name"] == "git_push"
    assert results[0]["result"].get("pushed") is True
    final = _events_of_type(events, "final")
    assert final and "pushed" in final[0]["text"]

    # The final provider.generate() call must have seen all three tool
    # results, not just the last one — this is what append_tool_results()
    # relies on to line results back up with the original tool_calls.
    last_contents = provider.generate_calls[-1]
    tool_message = last_contents[-1]
    assert tool_message["role"] == "tool"
    assert [r["name"] for r in tool_message["results"]] == ["git_add", "git_commit", "git_push"]


def test_declining_lets_the_model_react_instead_of_the_loop_just_stopping(git_repo_with_remote):
    (git_repo_with_remote / "file.txt").write_text("v2\n")
    subprocess.run(["git", "add", "file.txt"], cwd=git_repo_with_remote, check=True)

    provider = ScriptedProvider([
        ProviderResponse(text=None, tool_calls=[ToolCall("git_commit", {"message": "update file"})]),
        ProviderResponse(text="Okay, I won't commit that."),
    ])

    events = list(run_agent_loop(provider, provider.build_contents("commit my change", [])))
    pending = _events_of_type(events, "pending_confirmation")
    action = get_pending(pending[0]["action_id"])

    events = list(resume_agent_loop(provider, action, confirmed=False))
    results = _events_of_type(events, "tool_result")
    assert results[0]["name"] == "git_commit"
    assert results[0]["result"] == {"cancelled": True, "message": "Action declined by user."}
    final = _events_of_type(events, "final")
    assert final == [{"type": "final", "text": "Okay, I won't commit that."}]

    # The declined result must have reached the model, in this provider's
    # tool-result message shape, so it actually knows what happened.
    last_contents = provider.generate_calls[-1]
    tool_message = last_contents[-1]
    assert tool_message["results"][0]["result"]["cancelled"] is True


def test_confirm_route_resumes_multi_step_git_workflow(git_repo_with_remote, monkeypatch):
    """End-to-end through the Flask /confirm route, matching what the
    client actually calls after the user clicks Allow."""

    (git_repo_with_remote / "file.txt").write_text("v2\n")

    provider = ScriptedProvider([
        ProviderResponse(text=None, tool_calls=[
            ToolCall("git_add", {"path": "file.txt"}),
            ToolCall("git_commit", {"message": "update file"}),
        ]),
        ProviderResponse(text="Added and committed file.txt."),
    ])
    monkeypatch.setattr(app, "provider", provider)

    client = app.app.test_client()
    chat_response = client.post("/chat", json={"chat": "add and commit file.txt", "history": []})
    assert chat_response.status_code == 200
    body = chat_response.get_json()
    pending = [e for e in body["tool_activity"] if e.get("type") == "pending_confirmation"]
    assert len(pending) == 1
    action_id = pending[0]["action_id"]

    confirm_response = client.post("/confirm", json={"action_id": action_id, "confirmed": True})
    assert confirm_response.status_code == 200
    confirm_body = confirm_response.get_json()
    # Should NOT be fully done yet: git_commit is still pending.
    assert confirm_body.get("cancelled") is not True
    assert confirm_body.get("pending_confirmation") is not None
    assert confirm_body["pending_confirmation"]["name"] == "git_commit"
    assert confirm_body["text"] == ""

    next_action_id = confirm_body["pending_confirmation"]["action_id"]
    confirm_response_2 = client.post("/confirm", json={"action_id": next_action_id, "confirmed": True})
    assert confirm_response_2.status_code == 200
    confirm_body_2 = confirm_response_2.get_json()
    assert confirm_body_2.get("pending_confirmation") is None
    assert confirm_body_2["text"] == "Added and committed file.txt."
    result_names = [e["name"] for e in confirm_body_2["tool_activity"] if e.get("type") == "tool_result"]
    assert result_names == ["git_commit"]


def test_confirm_route_falls_back_when_provider_changed(git_repo_with_remote, monkeypatch):
    """If the active provider changes between the pause and the confirm
    (e.g. the user switched providers), resuming with the old provider's
    saved `contents` would be unsafe — those are provider-specific
    objects. The route should degrade to a one-off execution instead of
    trying to resume against a mismatched provider."""

    (git_repo_with_remote / "file.txt").write_text("v2\n")
    provider_a = ScriptedProvider([
        ProviderResponse(text=None, tool_calls=[ToolCall("git_add", {"path": "file.txt"})]),
    ])
    monkeypatch.setattr(app, "provider", provider_a)

    client = app.app.test_client()
    chat_response = client.post("/chat", json={"chat": "add file.txt", "history": []})
    pending = [e for e in chat_response.get_json()["tool_activity"] if e.get("type") == "pending_confirmation"]
    action_id = pending[0]["action_id"]

    class OtherProvider(ScriptedProvider):
        name = "other"

    monkeypatch.setattr(app, "provider", OtherProvider([]))

    confirm_response = client.post("/confirm", json={"action_id": action_id, "confirmed": True})
    assert confirm_response.status_code == 200
    body = confirm_response.get_json()
    # Legacy fallback shape: a flat single result, no tool_activity/pending_confirmation.
    assert body["result"]["staged"] is True
    assert "tool_activity" not in body
    assert "pending_confirmation" not in body


@pytest.fixture(autouse=True)
def _clear_pending_actions():
    clear_pending()
    yield
    clear_pending()
