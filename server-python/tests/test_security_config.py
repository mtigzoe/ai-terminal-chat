import json

import pytest

import security


def test_persist_config_fails_closed_when_atomic_replace_fails(tmp_path, monkeypatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    config_file = config_dir / "config.json"
    sentinel = config_dir / "sentinel.txt"
    sentinel.write_text("unchanged", encoding="utf-8")

    monkeypatch.setattr(security, "_CONFIG_DIR", config_dir)
    monkeypatch.setattr(security, "_CONFIG_FILE", config_file)

    def fail_replace(source, target):
        # Simulate a target lock/replacement failure without allowing the
        # implementation to fall back to a pathname-based write.
        raise OSError("simulated replace failure")

    monkeypatch.setattr(security.os, "replace", fail_replace)

    with pytest.raises(OSError, match="simulated replace failure"):
        security._persist_config({"allowed_commands": ["git status"]})

    assert not config_file.exists()
    assert sentinel.read_text(encoding="utf-8") == "unchanged"
    assert list(config_dir.glob("config-*.tmp")) == []
