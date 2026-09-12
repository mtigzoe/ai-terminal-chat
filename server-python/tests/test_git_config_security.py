import subprocess
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))
import tools  # noqa: E402


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=True)


def _repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    _git(root, "config", "user.name", "Test")
    _git(root, "config", "user.email", "test@example.com")
    (root / "file.txt").write_text("base\n", encoding="utf-8")
    _git(root, "add", "file.txt")
    _git(root, "commit", "-m", "base")
    return root


def test_strip_dangerous_git_config_removes_execution_sections():
    config = "[core]\n\tbare = false\n[filter \"evil\"]\n\tclean = sh -c \"touch pwned; cat\"\n[url \"file:///evil/\"]\n\tinsteadOf = https://example.com/\n[include]\n\tpath = evil.conf\n[merge \"evil\"]\n\tdriver = sh -c \"touch merge-pwned\"\n"
    sanitized = tools._strip_dangerous_git_config(config)
    assert 'filter "evil"' not in sanitized
    assert 'url "file:///evil/"' not in sanitized
    assert '[include]' not in sanitized
    assert 'merge "evil"' in sanitized


def test_git_diff_disables_textconv(monkeypatch):
    captured = {}
    class Result:
        returncode = 0
        stdout = "diff --git a/file.txt b/file.txt\n"
        stderr = ""
    def fake_run(args, timeout):
        captured["args"] = args
        return Result()
    monkeypatch.setattr(tools, "_run_git", fake_run)
    result = tools.git_diff()
    assert "error" not in result
    assert captured["args"][:3] == ["diff", "--no-ext-diff", "--no-textconv"]


def test_dynamic_git_config_overrides_execution_paths(tmp_path, monkeypatch):
    root = _repo(tmp_path)
    _git(root, 'config', 'filter.evil.clean', "sh -c 'touch pwned; cat'")
    _git(root, 'config', 'merge.evil.driver', "sh -c 'touch merge-pwned'")
    _git(root, 'config', 'remote.origin.uploadpack', 'touch upload-pwned')
    monkeypatch.setattr(tools, 'PROJECT_ROOT', root)
    flattened = ' '.join(tools._dynamic_git_config_overrides())
    assert 'filter.evil.clean=' in flattened
    assert 'merge.evil.driver=' in flattened
    assert 'remote.origin.uploadpack=' in flattened


def test_git_config_symlink_is_rejected(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    (root / "external-config").write_text("[filter \"evil\"]\n\tclean = touch pwned\n", encoding="utf-8")
    git_dir = root / ".git"
    git_dir.mkdir()
    (git_dir / "config").symlink_to(root / "external-config")
    monkeypatch.setattr(tools, "PROJECT_ROOT", root)
    try:
        tools._git_config_files()
    except ValueError as exc:
        assert "symlink" in str(exc).lower()
    else:
        raise AssertionError("symlinked Git config must be rejected")
