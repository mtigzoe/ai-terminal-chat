import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402
import security  # noqa: E402
import tools  # noqa: E402


@pytest.fixture
def isolated_project(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(tools, "PROJECT_ROOT", tmp_path)
    security.clear_allowed_read_paths()
    yield tmp_path
    security.clear_allowed_read_paths()


def _install_fake_agent(monkeypatch, observed):
    monkeypatch.setattr(app.provider, "build_contents", lambda message, history: [])

    def fake_agent_loop(provider, contents, cancel_event=None):
        observed["selected"] = tools.read_file("selected.txt")
        observed["unselected"] = tools.read_file("unselected.txt")
        yield {"type": "final", "text": "permission test passed"}

    monkeypatch.setattr(app, "run_agent_loop", fake_agent_loop)


def test_chat_passes_selected_paths_into_agent_context(isolated_project, monkeypatch):
    (isolated_project / "selected.txt").write_text("selected contents")
    (isolated_project / "unselected.txt").write_text("secret contents")
    observed = {}
    _install_fake_agent(monkeypatch, observed)

    response = app.app.test_client().post(
        "/chat",
        json={
            "chat": "Read selected.txt",
            "history": [],
            "allowed_paths": ["selected.txt"],
        },
    )

    assert response.status_code == 200
    assert response.get_json()["text"] == "permission test passed"
    assert observed["selected"]["contents"] == "selected contents"
    assert "error" in observed["unselected"]
    assert "contents" not in observed["unselected"]
    assert security.get_allowed_read_paths() == frozenset()


def test_chat_with_no_selection_denies_file_reads(isolated_project, monkeypatch):
    (isolated_project / "selected.txt").write_text("selected contents")
    observed = {}
    monkeypatch.setattr(app.provider, "build_contents", lambda message, history: [])

    def fake_agent_loop(provider, contents, cancel_event=None):
        observed["result"] = tools.read_file("selected.txt")
        yield {"type": "final", "text": "done"}

    monkeypatch.setattr(app, "run_agent_loop", fake_agent_loop)

    response = app.app.test_client().post(
        "/chat",
        json={"chat": "Read the file", "history": [], "allowed_paths": []},
    )

    assert response.status_code == 200
    assert "error" in observed["result"]
    assert "selected" in observed["result"]["error"].lower()
    assert security.get_allowed_read_paths() == frozenset()


def test_stream_passes_selected_paths_into_agent_context(isolated_project, monkeypatch):
    (isolated_project / "selected.txt").write_text("selected contents")
    (isolated_project / "unselected.txt").write_text("secret contents")
    observed = {}
    _install_fake_agent(monkeypatch, observed)

    response = app.app.test_client().post(
        "/stream",
        json={
            "chat": "Read selected.txt",
            "history": [],
            "allowed_paths": ["selected.txt"],
        },
    )

    assert response.status_code == 200
    assert "permission test passed" in response.get_data(as_text=True)
    assert observed["selected"]["contents"] == "selected contents"
    assert "error" in observed["unselected"]
    assert "contents" not in observed["unselected"]
    assert security.get_allowed_read_paths() == frozenset()
