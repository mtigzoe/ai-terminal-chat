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


@pytest.mark.parametrize("address", ["fec0::1", "feff::1"])
def test_provider_url_rejects_deprecated_ipv6_site_local_addresses(address):
    with pytest.raises(ValueError, match="not allowed"):
        security.validate_provider_base_url(f"http://[{address}]:11434")


@pytest.mark.parametrize("address", ["100.64.0.1", "100.127.255.255"])
def test_provider_url_rejects_cgnat_addresses(address):
    # 100.64.0.0/10 is neither private nor reserved by ipaddress's own
    # definitions, so the config-time check used to accept it while
    # safe_fetch.blocked_address_reason rejected it at request time. The
    # settings page then persisted a URL the server itself refused to use.
    with pytest.raises(ValueError, match="not allowed"):
        security.validate_provider_base_url(f"http://{address}:11434")


def test_config_time_and_request_time_ip_policies_agree():
    # The two classifiers are documented as implementing one policy. Compare
    # them over a representative set of special-purpose addresses.
    from safe_fetch import blocked_address_reason

    addresses = [
        "10.0.0.1",
        "100.64.0.1",
        "100.127.255.255",
        "192.168.1.1",
        "192.0.0.1",
        "198.18.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "169.254.169.254",
        "100.100.100.200",
        "fec0::1",
        "fc00::1",
        "fe80::1",
        "8.8.8.8",
        "172.15.0.1",
        "100.128.0.1",
        "2606:4700::1111",
    ]
    for address in addresses:
        config_time_blocked = security._is_blocked_ip(address) is not None
        request_time_blocked = blocked_address_reason(address) is not None
        assert config_time_blocked == request_time_blocked, address
