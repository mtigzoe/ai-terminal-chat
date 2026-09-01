from pathlib import Path
import sys

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from agent import _direct_git_command  # noqa: E402
from base import ToolCall, ProviderResponse  # noqa: E402


def test_direct_git_add_routes_to_git_add_tool():
    contents = [{"role": "user", "content": "git add hellov2.txt"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ToolCall)
    assert result.name == "git_add"
    assert result.args == {"path": "hellov2.txt"}


def test_direct_git_add_supports_double_dash():
    contents = [{"role": "user", "content": "git add -- hellov2.txt"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ToolCall)
    assert result.name == "git_add"
    assert result.args == {"path": "hellov2.txt"}


def test_direct_git_status_routes_to_git_status_tool():
    contents = [{"role": "user", "content": "git status"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ToolCall)
    assert result.name == "git_status"
    assert result.args == {}


def test_direct_git_branch_show_current_routes_to_run_command():
    contents = [{"role": "user", "content": "git branch --show-current"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ToolCall)
    assert result.name == "run_command"
    assert result.args == {"command": "git branch --show-current"}


def test_direct_git_commit_is_rejected_without_calling_model_tool():
    contents = [{"role": "user", "content": "git commit -m \"Hellov2.txt\""}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert result.tool_calls == []
    assert "not available" in result.text.lower()


def test_direct_git_push_is_rejected_without_calling_model_tool():
    contents = [{"role": "user", "content": "git push origin real-time-git-status-clean"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert result.tool_calls == []
    assert "not available" in result.text.lower()


def test_natural_language_git_request_still_uses_model():
    contents = [{"role": "user", "content": "Can you explain what git add does?"}]

    assert _direct_git_command(contents) is None
