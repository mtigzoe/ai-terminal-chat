from pathlib import Path
import sys

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from agent import _direct_git_command  # noqa: E402
from base import ToolCall, ProviderResponse  # noqa: E402


def test_direct_git_add_routes_to_git_add_tool():
    contents = [{"role": "user", "content": "git add hellov2.txt"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_add"
    assert result.tool_calls[0].args == {"path": "hellov2.txt"}


def test_direct_git_add_supports_double_dash():
    contents = [{"role": "user", "content": "git add -- hellov2.txt"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_add"
    assert result.tool_calls[0].args == {"path": "hellov2.txt"}


def test_direct_git_status_routes_to_git_status_tool():
    contents = [{"role": "user", "content": "git status"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_status"
    assert result.tool_calls[0].args == {}


def test_direct_git_branch_show_current_routes_to_run_command():
    contents = [{"role": "user", "content": "git branch --show-current"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "run_command"
    assert result.tool_calls[0].args == {"command": "git branch --show-current"}


def test_direct_git_commit_with_message_routes_to_git_commit_tool():
    contents = [{"role": "user", "content": 'git commit -m "Hellov2.txt"'}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_commit"
    assert result.tool_calls[0].args == {"message": "Hellov2.txt"}


def test_direct_git_commit_without_message_returns_text():
    contents = [{"role": "user", "content": "git commit"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert result.tool_calls == []
    assert "message" in result.text.lower()


def test_direct_git_push_routes_to_git_push_tool():
    contents = [{"role": "user", "content": "git push origin real-time-git-status-clean"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_push"
    assert result.tool_calls[0].args == {"remote": "origin", "branch": "real-time-git-status-clean"}


def test_natural_language_git_request_still_uses_model():
    contents = [{"role": "user", "content": "Can you explain what git add does?"}]

    assert _direct_git_command(contents) is None


def test_direct_git_fetch_routes_to_git_fetch_tool():
    contents = [{"role": "user", "content": "git fetch"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_fetch"
    assert result.tool_calls[0].args == {"remote": ""}


def test_direct_git_fetch_with_remote_routes_to_git_fetch_tool():
    contents = [{"role": "user", "content": "git fetch origin"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_fetch"
    assert result.tool_calls[0].args == {"remote": "origin"}


def test_direct_git_pull_routes_to_git_pull_tool():
    contents = [{"role": "user", "content": "git pull"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_pull"
    assert result.tool_calls[0].args == {"remote": "", "branch": ""}


def test_direct_git_pull_with_remote_and_branch():
    contents = [{"role": "user", "content": "git pull origin main"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_pull"
    assert result.tool_calls[0].args == {"remote": "origin", "branch": "main"}


def test_direct_git_restore_routes_to_git_restore_tool():
    contents = [{"role": "user", "content": "git restore file.txt"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_restore"
    assert result.tool_calls[0].args == {"path": "file.txt", "staged": False}


def test_direct_git_restore_staged_routes_correctly():
    contents = [{"role": "user", "content": "git restore --staged file.txt"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_restore"
    assert result.tool_calls[0].args == {"path": "file.txt", "staged": True}


def test_direct_git_commit_with_message_routes_to_git_commit_tool():
    contents = [{"role": "user", "content": 'git commit -m "update feature"'}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_commit"
    assert result.tool_calls[0].args == {"message": "update feature"}


def test_direct_git_commit_without_message_returns_text():
    contents = [{"role": "user", "content": "git commit"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert result.tool_calls == []
    assert "message" in result.text.lower()


def test_direct_git_push_routes_to_git_push_tool():
    contents = [{"role": "user", "content": "git push origin main"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_push"
    assert result.tool_calls[0].args == {"remote": "origin", "branch": "main"}


def test_direct_git_push_without_args_routes_correctly():
    contents = [{"role": "user", "content": "git push"}]

    result = _direct_git_command(contents)

    assert isinstance(result, ProviderResponse)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "git_push"
    assert result.tool_calls[0].args == {"remote": "", "branch": ""}
