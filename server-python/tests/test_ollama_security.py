"""Regression tests for Ollama CLI executable resolution."""

import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import ollama  # noqa: E402


def test_ollama_executable_is_resolved_to_absolute_path(monkeypatch, tmp_path):
    executable = tmp_path / "ollama"
    executable.write_text("stub", encoding="utf-8")
    monkeypatch.setattr(ollama.shutil, "which", lambda name: str(executable))
    monkeypatch.setattr(ollama, "get_project_root", lambda: tmp_path / "project")
    (tmp_path / "project").mkdir()

    assert ollama._resolve_ollama_executable() == str(executable.resolve())


def test_project_local_ollama_executable_is_rejected(monkeypatch, tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    executable = project / "ollama"
    executable.write_text("stub", encoding="utf-8")
    monkeypatch.setattr(ollama.shutil, "which", lambda name: str(executable))
    monkeypatch.setattr(ollama, "get_project_root", lambda: project)

    assert ollama._resolve_ollama_executable() is None


def test_missing_ollama_executable_is_rejected(monkeypatch):
    monkeypatch.setattr(ollama.shutil, "which", lambda name: None)
    assert ollama._resolve_ollama_executable() is None
