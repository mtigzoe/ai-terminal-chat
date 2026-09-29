"""Round-3 regression tests: _sanitized_git_config must not lose user config.

The sanitization temporarily strips url.*.insteadOf, include.path and
filter.* settings from the repository's .git/config so a hostile repo config
cannot execute programs. Restoring the backup must be as careful as writing the
sanitized version.

These tests pin three defects:
  1. A concurrent edit made while the config was sanitized was clobbered.
  2. A failed restore was swallowed, leaving the stripped config in place
     permanently with no indication anything had gone wrong.
  3. (covered) The ordinary restore path still works.
"""

import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import security
import tools

MARKER = '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n'
CONCURRENT = "[user]\n\tsigningkey = ~/my_new_key\n"


@pytest.fixture
def repo(tmp_path):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=False, capture_output=True)
    config = tmp_path / ".git" / "config"
    config.write_text("[core]\n\trepositoryformatversion = 0\n" + MARKER, encoding="utf-8")
    security.PROJECT_ROOT.set(tmp_path)
    yield {"root": tmp_path, "config": config}
    security.PROJECT_ROOT.set(SERVER_DIR)


class TestSanitizedGitConfigRestore:
    def test_untouched_config_is_restored(self, repo):
        """The normal path must keep working: strip, run, put it back."""
        with tools._sanitized_git_config():
            inside = repo["config"].read_text(encoding="utf-8")
            assert MARKER not in inside, "config should be sanitized inside the block"

        assert MARKER in repo["config"].read_text(encoding="utf-8")

    # Regression: the restore wrote the backup back unconditionally, so any
    # edit the user (or another tool) made while the operation was running was
    # silently destroyed. Mirrors the content check the TypeScript backend
    # already performs in withSanitizedGitConfigUnlocked().
    def test_concurrent_edit_is_not_clobbered(self, repo):
        with tools._sanitized_git_config():
            text = repo["config"].read_text(encoding="utf-8")
            repo["config"].write_text(text + CONCURRENT, encoding="utf-8")

        after = repo["config"].read_text(encoding="utf-8")
        assert CONCURRENT in after, "the user's concurrent edit was destroyed"
        recoveries = list(repo["config"].parent.glob("config.ai-terminal-chat-recovery-*"))
        assert len(recoveries) == 1
        assert MARKER in recoveries[0].read_text(encoding="utf-8")

    def test_concurrent_change_without_dangerous_keys_still_survives(self, repo):
        with tools._sanitized_git_config():
            repo["config"].write_text(
                "[core]\n\trepositoryformatversion = 0\n[user]\n\tname = Someone\n",
                encoding="utf-8",
            )

        assert "[user]" in repo["config"].read_text(encoding="utf-8")
        recoveries = list(repo["config"].parent.glob("config.ai-terminal-chat-recovery-*"))
        assert len(recoveries) == 1
        assert MARKER in recoveries[0].read_text(encoding="utf-8")

    # Regression: a failed restore raised OSError inside the finally block,
    # which was caught by `except OSError: pass`. The repository was left with
    # the dangerous settings stripped out forever and no error surfaced
    # anywhere -- the user's url.*.insteadOf simply vanished.
    def test_failed_restore_warns_instead_of_failing_silently(self, repo, monkeypatch, capsys):
        real = tools._atomic_replace_text
        calls = {"n": 0}

        def failing(path, content):
            calls["n"] += 1
            if calls["n"] == 2:  # the restore
                raise OSError(13, "Permission denied")
            return real(path, content)

        monkeypatch.setattr(tools, "_atomic_replace_text", failing)
        with tools._sanitized_git_config():
            pass

        captured = capsys.readouterr()
        assert "could not restore" in captured.err
        assert str(repo["config"]) in captured.err
        recoveries = list(repo["config"].parent.glob("config.ai-terminal-chat-recovery-*"))
        assert len(recoveries) == 1
        assert MARKER in recoveries[0].read_text(encoding="utf-8")

    def test_failed_read_during_restore_warns(self, repo, monkeypatch, capsys):
        real_replace = tools._atomic_replace_text
        real_read = Path.read_text
        state = {"sanitized": False}

        def tracking_replace(path, content):
            state["sanitized"] = content
            return real_replace(path, content)

        def exploding_read(self, *a, **kw):
            if state.get("sanitized") and self.name == "config":
                raise OSError(13, "Permission denied")
            return real_read(self, *a, **kw)

        monkeypatch.setattr(tools, "_atomic_replace_text", tracking_replace)
        monkeypatch.setattr(Path, "read_text", exploding_read)
        with tools._sanitized_git_config():
            pass

        assert "could not read" in capsys.readouterr().err
        recoveries = list(repo["config"].parent.glob("config.ai-terminal-chat-recovery-*"))
        assert len(recoveries) == 1
        assert MARKER in recoveries[0].read_text(encoding="utf-8")

    def test_exception_inside_the_block_still_restores(self, repo):
        class Boom(RuntimeError):
            pass

        with pytest.raises(Boom), tools._sanitized_git_config():
            raise Boom("operation failed")

        assert MARKER in repo["config"].read_text(encoding="utf-8")

    def test_exception_inside_the_block_is_not_masked_by_a_restore_failure(
        self, repo, monkeypatch
    ):
        real = tools._atomic_replace_text
        calls = {"n": 0}

        def failing(path, content):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError(13, "Permission denied")
            return real(path, content)

        monkeypatch.setattr(tools, "_atomic_replace_text", failing)

        class Boom(RuntimeError):
            pass

        with pytest.raises(Boom), tools._sanitized_git_config():
            raise Boom("original failure")
