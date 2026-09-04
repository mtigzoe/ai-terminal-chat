"""Tests for the Settings page's Install/Run Ollama button.

Covers the two pieces that back it:

- `is_ollama_cli_installed()` / `launch_ollama_run()` in ollama.py, which
  check for the `ollama` executable on PATH and start `ollama run <model>`
  in the background.
- The `/providers/ollama/status` and `/providers/ollama/run` Flask routes
  that expose them to the Settings UI.

`launch_ollama_run` never actually spawns a real `ollama` process here —
`subprocess.Popen` is mocked throughout so the suite runs the same way
whether or not Ollama is installed on the machine running the tests.
"""

import os
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

from ollama import is_ollama_cli_installed, launch_ollama_run  # noqa: E402


# ---------------------------------------------------------------------
# is_ollama_cli_installed
# ---------------------------------------------------------------------


def test_is_ollama_cli_installed_true_when_on_path():
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"):
        assert is_ollama_cli_installed() is True


def test_is_ollama_cli_installed_false_when_not_on_path():
    with patch("ollama.shutil.which", return_value=None):
        assert is_ollama_cli_installed() is False


# ---------------------------------------------------------------------
# launch_ollama_run
# ---------------------------------------------------------------------


def test_launch_ollama_run_requires_a_model():
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"):
        result = launch_ollama_run("")
    assert "error" in result
    assert "model" in result["error"].lower()


def test_launch_ollama_run_rejects_flag_like_model_names():
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"):
        result = launch_ollama_run("--rm")
    assert "error" in result
    assert "not a valid" in result["error"]


def test_launch_ollama_run_reports_missing_cli():
    with patch("ollama.shutil.which", return_value=None):
        result = launch_ollama_run("llama3.1")
    assert "error" in result
    assert "was not found on PATH" in result["error"]


def test_launch_ollama_run_starts_detached_process_on_posix():
    fake_process = Mock(pid=4321)
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"), patch(
        "ollama.platform.system", return_value="Linux"
    ), patch("ollama.subprocess.Popen", return_value=fake_process) as popen:
        result = launch_ollama_run("llama3.1")

    assert result == {"started": True, "model": "llama3.1", "pid": 4321}
    args, kwargs = popen.call_args
    assert args[0] == ["ollama", "run", "llama3.1"]
    assert kwargs["start_new_session"] is True
    assert "creationflags" not in kwargs


def test_launch_ollama_run_opens_console_on_windows():
    fake_process = Mock(pid=1111)
    with patch("ollama.shutil.which", return_value="C:\\ollama\\ollama.exe"), patch(
        "ollama.platform.system", return_value="Windows"
    ), patch("ollama.subprocess.Popen", return_value=fake_process) as popen, patch(
        "ollama.subprocess.CREATE_NEW_CONSOLE", 0x00000010, create=True
    ):
        result = launch_ollama_run("qwen3.5:9b")

    assert result == {"started": True, "model": "qwen3.5:9b", "pid": 1111}
    args, kwargs = popen.call_args
    assert args[0] == ["ollama", "run", "qwen3.5:9b"]
    assert kwargs.get("creationflags") == 0x00000010


def test_launch_ollama_run_surfaces_popen_failures():
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"), patch(
        "ollama.platform.system", return_value="Linux"
    ), patch("ollama.subprocess.Popen", side_effect=OSError("boom")):
        result = launch_ollama_run("llama3.1")

    assert "error" in result
    assert "boom" in result["error"]


def test_launch_ollama_run_accepts_namespaced_and_tagged_models():
    fake_process = Mock(pid=1)
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"), patch(
        "ollama.platform.system", return_value="Linux"
    ), patch("ollama.subprocess.Popen", return_value=fake_process) as popen:
        launch_ollama_run("myuser/mymodel:latest")

    args, _ = popen.call_args
    assert args[0] == ["ollama", "run", "myuser/mymodel:latest"]


@pytest.mark.parametrize(
    "model",
    [
        "gpt-oss:20b-cloud",
        # Cloud models can chain more than one colon segment, e.g. what
        # `ollama run gpt-oss:20b:cloud` prints when connecting to
        # ollama.com. This used to be rejected as "not a valid Ollama
        # model name" even though the same string works fine typed
        # directly into a terminal.
        "gpt-oss:20b:cloud",
        "qwen3-coder-480b:cloud",
        "kimi-k2:1t-cloud",
        "leckminartor/qwen3.5-uncensored:397b-cloud",
    ],
)
def test_launch_ollama_run_accepts_cloud_model_names(model):
    fake_process = Mock(pid=1)
    with patch("ollama.shutil.which", return_value="/usr/local/bin/ollama"), patch(
        "ollama.platform.system", return_value="Linux"
    ), patch("ollama.subprocess.Popen", return_value=fake_process) as popen:
        result = launch_ollama_run(model)

    assert result == {"started": True, "model": model, "pid": 1}
    args, _ = popen.call_args
    assert args[0] == ["ollama", "run", model]


# ---------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------


@pytest.fixture
def client():
    import app

    app.app.testing = True
    with app.app.test_client() as client:
        yield client


def test_ollama_status_endpoint_reports_installed(client):
    with patch("ollama.is_ollama_cli_installed", return_value=True):
        response = client.get("/providers/ollama/status")
    assert response.status_code == 200
    assert response.get_json() == {"installed": True}


def test_ollama_status_endpoint_reports_not_installed(client):
    with patch("ollama.is_ollama_cli_installed", return_value=False):
        response = client.get("/providers/ollama/status")
    assert response.status_code == 200
    assert response.get_json() == {"installed": False}


def test_ollama_run_endpoint_starts_model(client):
    with patch(
        "ollama.launch_ollama_run",
        return_value={"started": True, "model": "llama3.1", "pid": 999},
    ):
        response = client.post("/providers/ollama/run", json={"model": "llama3.1"})
    assert response.status_code == 200
    data = response.get_json()
    assert data["started"] is True
    assert data["model"] == "llama3.1"


def test_ollama_run_endpoint_surfaces_errors_as_400(client):
    with patch(
        "ollama.launch_ollama_run",
        return_value={"error": "The `ollama` command was not found on PATH."},
    ):
        response = client.post("/providers/ollama/run", json={"model": "llama3.1"})
    assert response.status_code == 400
    assert "not found on PATH" in response.get_json()["error"]


def test_ollama_run_endpoint_requires_a_model(client):
    with patch("ollama.launch_ollama_run", return_value={"error": "A model name is required."}):
        response = client.post("/providers/ollama/run", json={})
    assert response.status_code == 400
    assert "model" in response.get_json()["error"].lower()
