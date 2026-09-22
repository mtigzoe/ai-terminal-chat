"""Tests for safe_fetch.py -- SSRF / DNS-rebinding protection.

Mirrors the scenarios server-typescript/tests/ssrf-vuln-confirmation.test.ts
exercises for safe-fetch.ts, with a DNS-rebinding-specific proof that a
pinned connection can't be redirected mid-request by a second,
uncontrolled resolver call.

No real network access is used anywhere in this file: a local
http.server instance stands in for "the internet", and
safe_fetch._real_getaddrinfo is monkeypatched to a small fake DNS map
so every hostname's resolution is fully controlled and deterministic.
"""

import http.server
import socket
import sys
import threading
from pathlib import Path
from urllib.parse import unquote

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import safe_fetch  # noqa: E402


# ---------------------------------------------------------------------------
# Local HTTP server standing in for "the internet"
# ---------------------------------------------------------------------------


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _redirect(self, status: int, location: str):
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/final":
            body = b"final response"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/host-echo":
            body = (self.headers.get("Host") or "").encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/redirect/"):
            # /redirect/<status>/<url-quoted-location>
            _, _, rest = self.path.partition("/redirect/")
            status_str, _, location = rest.partition("/")
            self._redirect(int(status_str), unquote(location))
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_POST = do_GET


@pytest.fixture
def server():
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


@pytest.fixture
def dns(monkeypatch):
    """A fully controlled fake DNS map: hostname -> [(family, address), ...]."""
    mapping: dict[str, list[tuple[int, str]]] = {}

    def fake_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        entries = mapping.get(host)
        if not entries:
            raise socket.gaierror(f"no fake DNS entry for {host!r}")
        results = []
        for fam, addr in entries:
            sockaddr = (addr, port or 0) if fam == socket.AF_INET else (addr, port or 0, 0, 0)
            results.append((fam, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr))
        return results

    monkeypatch.setattr(safe_fetch, "_real_getaddrinfo", fake_getaddrinfo)
    return mapping


def _server_addr(server) -> tuple[str, int]:
    return "127.0.0.1", server.server_port


# ---------------------------------------------------------------------------
# blocked_address_reason: the full address-classification matrix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "8.8.8.8",
        "93.184.216.34",
        "2001:4860:4860::8888",
    ],
)
def test_public_addresses_are_allowed(address):
    assert safe_fetch.blocked_address_reason(address) is None


@pytest.mark.parametrize(
    "address,label",
    [
        ("127.0.0.1", "IPv4 loopback"),
        ("127.255.255.254", "IPv4 loopback range"),
        ("::1", "IPv6 loopback"),
    ],
)
def test_loopback_is_blocked_by_default(address, label):
    assert safe_fetch.blocked_address_reason(address) is not None, label


@pytest.mark.parametrize("address", ["127.0.0.1", "::1"])
def test_loopback_is_allowed_when_hostname_permits_it(address):
    assert safe_fetch.blocked_address_reason(address, allow_loopback=True) is None


@pytest.mark.parametrize(
    "address",
    ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255"],
)
def test_rfc1918_private_ipv4_is_blocked(address):
    assert safe_fetch.blocked_address_reason(address) is not None


@pytest.mark.parametrize("address", ["169.254.1.1", "169.254.255.255"])
def test_ipv4_link_local_is_blocked(address):
    assert safe_fetch.blocked_address_reason(address) is not None


@pytest.mark.parametrize("address", ["fe80::1", "fe80::abcd:1234"])
def test_ipv6_link_local_is_blocked(address):
    assert safe_fetch.blocked_address_reason(address) is not None


@pytest.mark.parametrize("address", ["fc00::1", "fd12:3456::1"])
def test_ipv6_unique_local_is_blocked(address):
    assert safe_fetch.blocked_address_reason(address) is not None


@pytest.mark.parametrize("address", ["0.0.0.0", "0.1.2.3"])
def test_ipv4_unspecified_range_is_blocked(address):
    assert safe_fetch.blocked_address_reason(address) is not None


def test_ipv6_unspecified_is_blocked():
    assert safe_fetch.blocked_address_reason("::") is not None


@pytest.mark.parametrize("address", ["224.0.0.1", "239.255.255.255", "ff02::1"])
def test_multicast_is_blocked(address):
    assert safe_fetch.blocked_address_reason(address) is not None


@pytest.mark.parametrize("address", ["240.0.0.1", "255.255.255.255"])
def test_ipv4_reserved_range_is_blocked(address):
    assert safe_fetch.blocked_address_reason(address) is not None


@pytest.mark.parametrize("address", ["100.64.0.1", "100.127.255.255"])
def test_cgnat_is_blocked(address):
    # Not private/loopback/link-local/multicast/reserved/unspecified by
    # ipaddress's own definitions -- this is the one range that needs an
    # explicit check to match safe-fetch.ts's policy.
    assert safe_fetch.blocked_address_reason(address) is not None


@pytest.mark.parametrize("address", ["169.254.169.254", "169.254.169.253", "100.100.100.200"])
def test_cloud_metadata_addresses_are_blocked(address):
    reason = safe_fetch.blocked_address_reason(address)
    assert reason is not None
    assert "metadata" in reason.lower()


def test_cloud_metadata_is_blocked_even_when_loopback_allowed():
    # allow_loopback only concerns loopback; a metadata IP is never
    # loopback, so it must still be blocked regardless.
    reason = safe_fetch.blocked_address_reason("169.254.169.254", allow_loopback=True)
    assert reason is not None


@pytest.mark.parametrize(
    "address",
    [
        "::ffff:192.168.1.1",   # dotted-decimal IPv4-mapped IPv6
        "::ffff:c0a8:101",      # hex IPv4-mapped IPv6 (same address, hex form)
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
    ],
)
def test_ipv4_mapped_ipv6_is_evaluated_against_the_embedded_ipv4(address):
    assert safe_fetch.blocked_address_reason(address) is not None


def test_ipv4_mapped_ipv6_loopback_respects_allow_loopback():
    assert safe_fetch.blocked_address_reason("::ffff:127.0.0.1") is not None
    assert safe_fetch.blocked_address_reason("::ffff:127.0.0.1", allow_loopback=True) is None


@pytest.mark.parametrize(
    "hostname,expected",
    [
        ("localhost", True),
        ("LOCALHOST", True),
        ("localhost.", True),
        ("foo.localhost", True),
        ("notlocalhost", False),
        ("localhost.evil.test", False),
        ("example.com", False),
    ],
)
def test_hostname_allows_loopback(hostname, expected):
    assert safe_fetch.hostname_allows_loopback(hostname) is expected


# ---------------------------------------------------------------------------
# safe_request: end-to-end resolution + connection pinning
# ---------------------------------------------------------------------------


def test_safe_public_resolution_succeeds(server, dns):
    host, port = _server_addr(server)
    dns["safe-example.localhost"] = [(socket.AF_INET, host)]
    resp = safe_fetch.safe_request("GET", f"http://safe-example.localhost:{port}/final")
    assert resp.status_code == 200
    assert resp.text == "final response"


def test_loopback_resolution_fails(dns):
    dns["attacker-controlled.test"] = [(socket.AF_INET, "127.0.0.1")]
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request("GET", "http://attacker-controlled.test:9/final")


def test_private_ipv4_resolution_fails(dns):
    dns["attacker-controlled.test"] = [(socket.AF_INET, "10.1.2.3")]
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request("GET", "http://attacker-controlled.test:9/final")


def test_private_or_loopback_ipv6_resolution_fails(dns):
    dns["attacker-v6-loop.test"] = [(socket.AF_INET6, "::1")]
    dns["attacker-v6-priv.test"] = [(socket.AF_INET6, "fd00::1")]
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request("GET", "http://attacker-v6-loop.test:9/final")
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request("GET", "http://attacker-v6-priv.test:9/final")


def test_metadata_resolution_fails(dns):
    dns["attacker-metadata.test"] = [(socket.AF_INET, "169.254.169.254")]
    with pytest.raises(safe_fetch.SSRFError, match="metadata"):
        safe_fetch.safe_request("GET", "http://attacker-metadata.test:9/final")


def test_localhost_hostname_is_allowed_to_reach_loopback(server, dns):
    host, port = _server_addr(server)
    dns["localhost"] = [(socket.AF_INET, host)]
    resp = safe_fetch.safe_request("GET", f"http://localhost:{port}/final")
    assert resp.status_code == 200


def test_dual_homed_response_is_rejected_even_with_one_safe_address(server, dns):
    """A DNS response pairing one public address with one private one
    must be rejected outright, not partially trusted by picking the
    safe-looking entry out of it."""
    host, _port = _server_addr(server)
    dns["dual-homed.localhost"] = [(socket.AF_INET, host), (socket.AF_INET, "10.0.0.5")]
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request("GET", "http://dual-homed.localhost:9/final")


def test_host_header_preserves_original_hostname_not_the_pinned_ip(server, dns):
    host, port = _server_addr(server)
    dns["header-check.localhost"] = [(socket.AF_INET, host)]
    resp = safe_fetch.safe_request("GET", f"http://header-check.localhost:{port}/host-echo")
    assert resp.text == f"header-check.localhost:{port}"


def test_no_second_dns_lookup_during_the_actual_connection(server, monkeypatch):
    """The address validated must be exactly the address connected to:
    if the real resolver were consulted a second time during the
    actual HTTP connection (as it would be without pinning), a rebind
    that changed the answer between validation and connect would slip
    through undetected. Proves it's asked exactly once.
    """
    host, port = _server_addr(server)
    calls = []

    def spy_getaddrinfo(hostname, port_, family=0, type=0, proto=0, flags=0):
        calls.append(hostname)
        sockaddr = (host, port_ or 0)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]

    monkeypatch.setattr(safe_fetch, "_real_getaddrinfo", spy_getaddrinfo)

    resp = safe_fetch.safe_request("GET", f"http://pin-once.localhost:{port}/final")
    assert resp.status_code == 200
    assert calls.count("pin-once.localhost") == 1


# ---------------------------------------------------------------------------
# Redirects: always validated, only followed when explicitly requested
# ---------------------------------------------------------------------------


def test_redirect_public_to_public_is_followed_when_enabled(server, dns):
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    resp = safe_fetch.safe_request(
        "GET", f"http://redirector.localhost:{port}/redirect/302/%2Ffinal", allow_redirects=True
    )
    assert resp.status_code == 200
    assert resp.text == "final response"


def test_redirect_target_is_validated_even_when_not_following(server, dns):
    """safe-fetch.ts throws on an unsafe redirect Location even when
    followRedirects is off -- a caller that only wants to inspect the
    3xx response must never have it produced by a target that resolves
    somewhere unsafe."""
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    dns["private-target.test"] = [(socket.AF_INET, "10.1.1.1")]
    location = "http://private-target.test/final"
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request(
            "GET",
            f"http://redirector.localhost:{port}/redirect/302/{location}",
            allow_redirects=False,
        )


@pytest.mark.parametrize(
    "target_host,target_addr_family_addr",
    [
        ("to-loopback.test", (socket.AF_INET, "127.0.0.1")),
        ("to-private-v4.test", (socket.AF_INET, "10.2.2.2")),
        ("to-v6-loopback.test", (socket.AF_INET6, "::1")),
        ("to-metadata.test", (socket.AF_INET, "169.254.169.254")),
    ],
)
def test_redirect_to_blocked_targets_is_rejected(server, dns, target_host, target_addr_family_addr):
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    dns[target_host] = [target_addr_family_addr]
    location = f"http://{target_host}/final"
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request(
            "GET",
            f"http://redirector.localhost:{port}/redirect/302/{location}",
            allow_redirects=True,
        )


def test_redirect_to_another_hostname_resolving_safely_is_followed(server, dns):
    """public hostname -> another hostname that resolves safely: the
    new hostname gets its own independent resolution + validation +
    pin, exactly like the initial request."""
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    dns["second-safe-host.localhost"] = [(socket.AF_INET, host)]
    location = f"http://second-safe-host.localhost:{port}/final"
    resp = safe_fetch.safe_request(
        "GET",
        f"http://redirector.localhost:{port}/redirect/302/{location}",
        allow_redirects=True,
    )
    assert resp.status_code == 200
    assert resp.text == "final response"


def test_multiple_redirects_are_each_independently_validated(server, dns):
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    resp = safe_fetch.safe_request(
        "GET",
        f"http://redirector.localhost:{port}/redirect/302/%2Fredirect%2F302%2F%252Ffinal",
        allow_redirects=True,
    )
    assert resp.status_code == 200
    assert resp.text == "final response"


def test_multiple_redirects_stop_at_a_blocked_hop(server, dns):
    """A chain where an early hop is safe but a later one is not must
    still be blocked -- following one safe hop is not a license to skip
    validating the next one."""
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    dns["late-blocked.test"] = [(socket.AF_INET, "10.9.9.9")]
    first_hop = "/redirect/302/http://late-blocked.test/final"
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request(
            "GET", f"http://redirector.localhost:{port}{first_hop}", allow_redirects=True
        )


def test_redirect_involving_https_scheme_to_a_blocked_target_is_rejected(server, dns):
    """The https: scheme itself doesn't bypass validation: the block
    happens at DNS-resolution time, before any TLS handshake would
    occur, so this doesn't require a real TLS listener to prove."""
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    dns["https-private-target.test"] = [(socket.AF_INET, "172.16.5.5")]
    location = "https://https-private-target.test/final"
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request(
            "GET",
            f"http://redirector.localhost:{port}/redirect/302/{location}",
            allow_redirects=True,
        )


def test_redirect_to_non_http_scheme_is_rejected(server, dns):
    host, port = _server_addr(server)
    dns["redirector.localhost"] = [(socket.AF_INET, host)]
    location = "file:///etc/passwd"
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request(
            "GET", f"http://redirector.localhost:{port}/redirect/302/{location}", allow_redirects=True
        )


def test_non_http_scheme_is_rejected_up_front():
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request("GET", "file:///etc/passwd")


def test_resolve_and_validate_raises_for_unresolvable_hostname(dns):
    with pytest.raises(safe_fetch.SSRFError):
        safe_fetch.safe_request("GET", "http://this-hostname-is-not-in-the-fake-dns-map.test/")


def test_safe_request_ignores_environment_proxies():
    """The SSRF transport must not let HTTP(S)_PROXY change the actual
    connection target after DNS validation."""
    assert safe_fetch._SESSION.trust_env is False


def test_safe_request_rejects_explicit_proxy_configuration():
    with pytest.raises(safe_fetch.SSRFError, match="Proxy configuration"):
        safe_fetch.safe_request(
            "GET",
            "http://example.test/",
            proxies={"http": "http://127.0.0.1:8888"},
        )
