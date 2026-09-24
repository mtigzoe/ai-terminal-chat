"""Regression tests for _sanitized_terminal_env() / run_command()'s
non-Git subprocess environment.

Mirrors server-typescript/src/terminal.env-isolation.test.ts. Before this,
run_command()'s non-Git path called run_cancellable() with no `env=`
argument at all, so subprocess.Popen(env=None) inherited the *entire*
server process environment - every provider API key, plus
PYTHONPATH/NODE_OPTIONS/proxy variables that can change what a
"pytest"/"npm test" subprocess actually executes.
"""

import json
import os
import shutil
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import security  # noqa: E402
import tools  # noqa: E402


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    return tmp_path


def test_strips_known_provider_service_credential_variables(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-sentinel")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-sentinel")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp-sentinel")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "sentinel")

    with tools._sanitized_terminal_env() as env:
        assert "OPENAI_API_KEY" not in env
        assert "ANTHROPIC_API_KEY" not in env
        assert "GITHUB_TOKEN" not in env
        assert "AWS_SECRET_ACCESS_KEY" not in env


def test_strips_generic_api_key_secret_token_password_variables(monkeypatch):
    monkeypatch.setenv("SOME_SERVICE_API_KEY", "sentinel")
    monkeypatch.setenv("MY_APP_SECRET", "sentinel")
    monkeypatch.setenv("SESSION_TOKEN", "sentinel")
    monkeypatch.setenv("DB_PASSWORD", "sentinel")
    monkeypatch.setenv("db_password", "sentinel")  # case-insensitive sweep

    with tools._sanitized_terminal_env() as env:
        assert "SOME_SERVICE_API_KEY" not in env
        assert "MY_APP_SECRET" not in env
        assert "SESSION_TOKEN" not in env
        assert "DB_PASSWORD" not in env
        assert "db_password" not in env


def test_strips_python_interpreter_module_loading_variables(monkeypatch):
    names = [
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PYTHONUSERBASE",
        "PYTHONBREAKPOINT",
        "PYTHONPYCACHEPREFIX",
        "PYTHONPRESITE",
    ]
    for name in names:
        monkeypatch.setenv(name, "/tmp/evil")

    with tools._sanitized_terminal_env() as env:
        for name in names:
            assert name not in env, f"{name} must be stripped"


def test_strips_node_runtime_module_loading_variables(monkeypatch):
    monkeypatch.setenv("NODE_OPTIONS", "--require=/tmp/evil.js")
    monkeypatch.setenv("NODE_PATH", "/tmp/evil")
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", "/tmp/evil.pem")
    monkeypatch.setenv("NODE_V8_COVERAGE", "/tmp/evil")
    monkeypatch.setenv("NODE_ICU_DATA", "/tmp/evil")
    monkeypatch.setenv("NODE_TLS_REJECT_UNAUTHORIZED", "0")

    with tools._sanitized_terminal_env() as env:
        for name in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "NODE_EXTRA_CA_CERTS",
            "NODE_V8_COVERAGE",
            "NODE_ICU_DATA",
            "NODE_TLS_REJECT_UNAUTHORIZED",
        ]:
            assert name not in env, f"{name} must be stripped"


def test_strips_config_namespaces_but_preserves_npm_lifecycle_vars(monkeypatch):
    monkeypatch.setenv("npm_config_registry", "http://evil.example/")
    monkeypatch.setenv("NPM_CONFIG_USERCONFIG", "/tmp/evil/.npmrc")
    monkeypatch.setenv("PIP_INDEX_URL", "http://evil.example/simple")
    monkeypatch.setenv("PIP_CONFIG_FILE", "/tmp/evil/pip.conf")
    monkeypatch.setenv("PYTEST_ADDOPTS", "-p evil_plugin")
    monkeypatch.setenv("PYTEST_PLUGINS", "evil_plugin")
    monkeypatch.setenv("RUFF_CACHE_DIR", "/tmp/evil")
    # npm's own lifecycle metadata (created by npm itself, not a
    # configuration override) - must survive.
    monkeypatch.setenv("npm_package_name", "sentinel-project")
    monkeypatch.setenv("npm_lifecycle_event", "test")

    with tools._sanitized_terminal_env() as env:
        for name in [
            "npm_config_registry",
            "NPM_CONFIG_USERCONFIG",
            "PIP_INDEX_URL",
            "PIP_CONFIG_FILE",
            "PYTEST_ADDOPTS",
            "PYTEST_PLUGINS",
            "RUFF_CACHE_DIR",
        ]:
            assert name not in env, f"{name} must be stripped"
        assert env["npm_package_name"] == "sentinel-project"
        assert env["npm_lifecycle_event"] == "test"



def test_trusted_executable_skips_project_local_hijacks(project_root, monkeypatch):
    local_bin = project_root / "bin"
    local_bin.mkdir()
    local_exe = local_bin / ("python.exe" if os.name == "nt" else "python")
    local_exe.write_text("not a real executable", encoding="utf-8")
    if os.name != "nt":
        local_exe.chmod(0o755)

    monkeypatch.setenv("PATH", os.pathsep.join([str(local_bin), os.environ.get("PATH", "")]))
    resolved = tools._trusted_executable("python")
    assert Path(resolved).resolve() != local_exe.resolve()


def test_execution_path_boundary_blocks_external_package_manager_targets(project_root):
    assert tools._execution_path_permission_error(
        ["npm", "install", "--global", "example"]
    ) is not None
    assert tools._execution_path_permission_error(
        ["npm", "install", "--userconfig", "/tmp/evil.npmrc", "example"]
    ) is not None
    assert tools._execution_path_permission_error(
        ["pip", "install", "--target", "/tmp/evil", "example"]
    ) is not None
    assert tools._execution_path_permission_error(
        ["pip", "install", "--user", "example"]
    ) is not None
    assert tools._execution_path_permission_error(
        ["pip", "install", str(Path("/tmp/outside-package"))]
    ) is not None



def test_strips_proxy_tls_variables(monkeypatch):
    names = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
    ]
    for name in names:
        monkeypatch.setenv(name, "evil-value")

    with tools._sanitized_terminal_env() as env:
        for name in names:
            assert name not in env, f"{name} must be stripped"


def test_isolates_home_userprofile_xdg_config_home_and_cleans_up():
    captured_home = None
    with tools._sanitized_terminal_env() as env:
        captured_home = env["HOME"]
        assert env["HOME"] != os.environ.get("HOME")
        assert env["USERPROFILE"] == env["HOME"]
        assert os.path.isdir(env["HOME"])
        assert env["XDG_CONFIG_HOME"].startswith(env["HOME"])
        assert os.path.isdir(env["XDG_CONFIG_HOME"])
        assert "XDG_CONFIG_DIRS" not in env

    assert not os.path.exists(captured_home), (
        "cleanup must remove the isolated HOME on context exit"
    )


def test_each_invocation_gets_its_own_isolated_home_directory():
    with tools._sanitized_terminal_env() as first_env:
        with tools._sanitized_terminal_env() as second_env:
            assert first_env["HOME"] != second_env["HOME"]


def test_leaves_unrelated_variables_untouched(monkeypatch):
    monkeypatch.setenv("MY_APP_SETTING", "keep-me")

    with tools._sanitized_terminal_env() as env:
        assert env["MY_APP_SETTING"] == "keep-me"
        assert env.get("PATH"), "PATH must be preserved"


def test_home_is_removed_even_if_the_caller_raises():
    captured_home = None
    with pytest.raises(RuntimeError):
        with tools._sanitized_terminal_env() as env:
            captured_home = env["HOME"]
            raise RuntimeError("boom")

    assert not os.path.exists(captured_home)


# --- End-to-end: prove run_command() actually wires the sanitized
# --- environment through to the real spawned subprocess tree, and that a
# --- CONFIRMED execution-risk command is not exempt from it.


@pytest.mark.skipif(shutil.which("npm") is None, reason="npm not available")
def test_npm_test_does_not_leak_sensitive_config_env_vars_even_when_confirmed(
    project_root, monkeypatch
):
    marker = project_root / "env-dump.json"

    (project_root / "package.json").write_text(
        json.dumps(
            {
                "name": "env-isolation-probe",
                "version": "1.0.0",
                "scripts": {"test": "node dump-env.js"},
            }
        ),
        encoding="utf-8",
    )
    (project_root / "dump-env.js").write_text(
        "\n".join(
            [
                'const fs = require("fs");',
                "fs.writeFileSync(",
                f"  {json.dumps(str(marker))},",
                "  JSON.stringify({",
                "    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,",
                "    PYTHONPATH: process.env.PYTHONPATH ?? null,",
                "    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,",
                "    HTTP_PROXY: process.env.HTTP_PROXY ?? null,",
                "    npm_config_registry: process.env.npm_config_registry ?? null,",
                "    KEEP_ME: process.env.KEEP_ME ?? null,",
                "  }),",
                ");",
                "",
            ]
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("OPENAI_API_KEY", "sk-sentinel-should-not-leak")
    monkeypatch.setenv("PYTHONPATH", "/tmp/evil")
    monkeypatch.setenv("NODE_OPTIONS", "--require=/tmp/evil.js")
    monkeypatch.setenv("HTTP_PROXY", "http://evil.example:8080")
    monkeypatch.setenv("npm_config_registry", "http://evil.example/")
    monkeypatch.setenv("KEEP_ME", "still-here")

    # "npm test" is an execution-risk prefix: pass confirm=True to prove the
    # sanitized environment applies on the confirmed path too, not only to
    # the pre-confirmation preview.
    result = tools.run_command("npm test", confirm=True)
    assert "error" not in result or not result["error"], (
        f"npm test failed unexpectedly: {result.get('error')}"
    )

    assert marker.exists(), "dump-env.js must have run and written the marker"
    dumped = json.loads(marker.read_text(encoding="utf-8"))
    assert dumped["OPENAI_API_KEY"] is None
    assert dumped["PYTHONPATH"] is None
    assert dumped["NODE_OPTIONS"] is None
    assert dumped["HTTP_PROXY"] is None
    assert dumped["npm_config_registry"] is None
    assert dumped["KEEP_ME"] == "still-here"
