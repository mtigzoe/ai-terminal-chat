from pathlib import Path

import security


def test_set_project_root_persists_and_updates_proxy(tmp_path, monkeypatch):
    config_dir = tmp_path / "config"
    config_file = config_dir / "config.json"
    project_root = tmp_path / "project"
    project_root.mkdir()

    monkeypatch.setattr(security, "_CONFIG_DIR", config_dir)
    monkeypatch.setattr(security, "_CONFIG_FILE", config_file)

    original_root = security.get_project_root()
    try:
        selected = security.set_project_root(str(project_root))

        assert selected == project_root.resolve()
        assert security.get_project_root() == project_root.resolve()
        assert security.safe_path("example.txt") == project_root.resolve() / "example.txt"
        assert config_file.exists()
        assert str(project_root.resolve()) in config_file.read_text(encoding="utf-8")
    finally:
        security.PROJECT_ROOT.set(Path(original_root))


def test_choose_project_root_uses_native_picker_and_persists(tmp_path, monkeypatch):
    config_dir = tmp_path / "config"
    config_file = config_dir / "config.json"
    project_root = tmp_path / "chosen-project"
    project_root.mkdir()

    monkeypatch.setattr(security, "_CONFIG_DIR", config_dir)
    monkeypatch.setattr(security, "_CONFIG_FILE", config_file)
    monkeypatch.setattr(security, "_choose_project_root", lambda: project_root.resolve())

    original_root = security.get_project_root()
    try:
        selected = security.set_project_root(security.CHOOSE_PROJECT_ROOT)

        assert selected == project_root.resolve()
        assert security.get_project_root() == project_root.resolve()
        assert str(project_root.resolve()) in config_file.read_text(encoding="utf-8")
    finally:
        security.PROJECT_ROOT.set(Path(original_root))


def test_safe_path_still_rejects_escape_from_configured_root(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    original_root = security.get_project_root()

    try:
        security.PROJECT_ROOT.set(project_root)

        try:
            security.safe_path("../outside.txt")
        except ValueError as exc:
            assert "outside the project directory" in str(exc)
        else:
            raise AssertionError("Expected traversal outside the project root to fail")
    finally:
        security.PROJECT_ROOT.set(Path(original_root))
