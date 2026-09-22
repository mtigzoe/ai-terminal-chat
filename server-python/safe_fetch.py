"""DNS-pinning HTTP transport for SSRF / DNS-rebinding protection.

Mirrors server-typescript/src/safe-fetch.ts. Flow, per request (and per
redirect hop, if following is enabled):

1. Resolve the hostname to *every* address it returns (both A and AAAA).
2. Reject the whole response if ANY resolved address is private,
   loopback, link-local, multicast, reserved, unspecified, or a known
   cloud-metadata address (except loopback when the configured hostname
   is itself "localhost"/"*.localhost" -- otherwise local Ollama can't
   be used at all). Rejecting the whole set, not just picking a safe
   address out of it, matters: it stops a dual-homed DNS response from
   pairing one public record with one private one to sneak past a
   naive "pick any address" check.
3. Pin the connection to one validated address.
4. Every redirect Location header is independently re-resolved and
   re-validated the same way -- a URL being safe at hop 1 says nothing
   about hop 2.

Why DNS pinning is done by patching socket.getaddrinfo rather than a
requests.adapters.HTTPAdapter: requests/urllib3 don't expose a
per-request "connect to exactly this address" hook. urllib3's own
create_connection() (urllib3/util/connection.py) calls the *module-level*
socket.getaddrinfo(host, port, family, socket.SOCK_STREAM) directly --
not something reachable through HTTPAdapter.get_connection() or a
custom connection-pool/class override, both of which are also
sensitive to urllib3 internals changing across versions and to
anything (proxies, retry logic rebuilding a connection) that
constructs its own connection outside the adapter's control. Patching
socket.getaddrinfo intercepts the one choke point everything --
urllib3, http.client, and the TLS handshake's underlying TCP connect
-- actually funnels through, so there is no second, uncontrolled DNS
lookup that could defeat the validation. The patch is scoped through
thread-local pins keyed by hostname, applied only for the duration of
one request (or one redirect hop), so it is a no-op for every other
hostname and every other thread.

The original hostname is never touched, so:
- The HTTP Host header is unaffected (requests builds it from the URL,
  not from whatever the socket connected to).
- TLS SNI and certificate hostname verification are unaffected too:
  urllib3's HTTPSConnection.connect() passes server_hostname=self.host
  (the original hostname, fixed at connection-object construction) to
  the SSL context, never the resolved IP.
"""

from __future__ import annotations

import ipaddress
import socket
import threading
from typing import Optional
from urllib.parse import urljoin, urlsplit

import requests

# SSRF validation pins the target hostname to a validated IP. Environment
# proxies (HTTP_PROXY/HTTPS_PROXY) would otherwise make the actual TCP peer
# the proxy, not the validated target, allowing a proxy to reach a blocked
# private/metadata address on the caller's behalf. Keep this session direct
# and reject caller-supplied proxies as well.
_SESSION = requests.Session()
_SESSION.trust_env = False

# ---------------------------------------------------------------------------
# Address classification (mirrors safe-fetch.ts's blockedAddressReason)
# ---------------------------------------------------------------------------

# Same set server-python/security.py's _is_blocked_ip uses for the
# config-time check; kept as our own copy so this module has no import
# dependency on security.py's request-unrelated validation helpers.
_BLOCKED_METADATA_IPV4 = frozenset(
    {
        "169.254.169.254",  # AWS/GCP/Azure metadata
        "169.254.169.253",  # some cloud metadata
        "100.100.100.200",  # Alibaba Cloud metadata
    }
)

# CGNAT (RFC 6598). Not private/loopback/link-local/multicast/reserved/
# unspecified by ipaddress's own definitions, so it needs an explicit
# check -- everything else safe-fetch.ts blocks is already covered by
# ipaddress.ip_address(...).is_private/.is_loopback/.is_link_local/
# .is_multicast/.is_reserved/.is_unspecified (verified against every
# case, including IPv4-mapped IPv6 forms, which ipaddress decodes via
# its own ipv4_mapped property).
_CGNAT_START = ipaddress.IPv4Address("100.64.0.0")
_CGNAT_END = ipaddress.IPv4Address("100.127.255.255")


def hostname_allows_loopback(hostname: str) -> bool:
    """Hostnames intentionally allowed to resolve to loopback (local Ollama)."""
    h = (hostname or "").strip().lower().rstrip(".")
    return h == "localhost" or h.endswith(".localhost")


def blocked_address_reason(address: str, *, allow_loopback: bool = False) -> Optional[str]:
    """Classify a resolved address. Returns None if allowed, else a reason string."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return "Resolved address is not a valid IP"

    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped
        if mapped is not None:
            return blocked_address_reason(str(mapped), allow_loopback=allow_loopback)

    if isinstance(ip, ipaddress.IPv4Address) and str(ip) in _BLOCKED_METADATA_IPV4:
        return "Resolved IP is a cloud metadata endpoint"

    if allow_loopback and ip.is_loopback:
        return None

    if isinstance(ip, ipaddress.IPv4Address) and _CGNAT_START <= ip <= _CGNAT_END:
        return "Resolved IP is a private/reserved address (CGNAT)"

    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        kind = "IPv4" if isinstance(ip, ipaddress.IPv4Address) else "IPv6"
        return f"Resolved IP is a private/reserved {kind} address"

    return None


class SSRFError(requests.exceptions.RequestException):
    """Raised when a request or redirect target fails SSRF validation.

    Subclasses requests.RequestException so existing
    ``except requests.RequestException`` handling in provider code
    still catches it rather than crashing with an unhandled exception;
    callers that want the precise reason (rather than a generic
    "could not reach" message) should catch SSRFError first.
    """


# ---------------------------------------------------------------------------
# DNS resolution + validation
# ---------------------------------------------------------------------------

# Saved before any patching, and always used to perform the *real*
# resolution below -- the module-level socket.getaddrinfo is patched
# further down, and calling it (instead of this saved reference) here
# would just recurse into our own pin lookup.
_real_getaddrinfo = socket.getaddrinfo


def resolve_all(hostname: str) -> list[tuple[int, str]]:
    """Resolve hostname to every unique (family, address) it returns."""
    try:
        infos = _real_getaddrinfo(hostname, None, 0, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SSRFError(f"Could not resolve hostname: {hostname} ({exc})") from exc

    addresses: list[tuple[int, str]] = []
    seen: set[str] = set()
    for family, _socktype, _proto, _canonname, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        addr = sockaddr[0]
        if addr in seen:
            continue
        seen.add(addr)
        addresses.append((family, addr))

    if not addresses:
        raise SSRFError(f"Could not resolve hostname: {hostname}")
    return addresses


def resolve_and_validate(hostname: str, *, allow_loopback: bool) -> list[tuple[int, str]]:
    """Resolve + validate every address. Raises SSRFError if any is blocked.

    Rejecting the whole set (rather than filtering to just the safe
    addresses) is deliberate: an attacker who controls DNS for a
    dual-stack or multi-A-record name could otherwise pair one public
    address with one private one, and a "pick any safe one" check would
    happily connect to whichever came first while still nominally
    having "validated" the name.
    """
    addresses = resolve_all(hostname)
    for _family, addr in addresses:
        reason = blocked_address_reason(addr, allow_loopback=allow_loopback)
        if reason:
            raise SSRFError(f"{reason}: {addr} (resolved from {hostname!r})")
    return addresses


def _pick_pin(addresses: list[tuple[int, str]]) -> tuple[int, str]:
    """Prefer IPv4 (mirrors safe-fetch.ts: allowed.find(a => a.family===4) ?? allowed[0])."""
    for family, addr in addresses:
        if family == socket.AF_INET:
            return family, addr
    return addresses[0]


# ---------------------------------------------------------------------------
# Connection pinning via a scoped socket.getaddrinfo patch
# ---------------------------------------------------------------------------

_pin_state = threading.local()


def _current_pins() -> dict[str, tuple[int, str]]:
    pins = getattr(_pin_state, "pins", None)
    if pins is None:
        pins = {}
        _pin_state.pins = pins
    return pins


def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):  # noqa: A002
    pins = getattr(_pin_state, "pins", None)
    pin = pins.get(host) if pins else None
    if pin is None:
        return _real_getaddrinfo(host, port, family, type, proto, flags)

    pinned_family, pinned_addr = pin
    if family not in (0, pinned_family):
        # The caller (or urllib3's allowed_gai_family()) wants a
        # specific family that doesn't match what we validated and
        # pinned for this hostname. Fail closed rather than silently
        # falling back to a fresh, unvalidated real lookup.
        raise socket.gaierror(
            f"No validated address of the requested family for {host!r}"
        )
    sockaddr = (pinned_addr, port or 0) if pinned_family == socket.AF_INET else (pinned_addr, port or 0, 0, 0)
    return [(pinned_family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]


def _install_patch_once() -> None:
    if getattr(socket.getaddrinfo, "_is_safe_fetch_patch", False):
        return
    _patched_getaddrinfo._is_safe_fetch_patch = True  # type: ignore[attr-defined]
    socket.getaddrinfo = _patched_getaddrinfo


_install_patch_once()


class _pinned(object):
    """Context manager: pin one hostname to one validated address for this thread."""

    def __init__(self, hostname: str, family: int, address: str):
        self._hostname = hostname
        self._family = family
        self._address = address

    def __enter__(self):
        _current_pins()[self._hostname] = (self._family, self._address)
        return self

    def __exit__(self, *exc_info):
        _current_pins().pop(self._hostname, None)
        return False


# ---------------------------------------------------------------------------
# Public request API
# ---------------------------------------------------------------------------

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


def safe_request(
    method: str,
    url: str,
    *,
    allow_redirects: bool = False,
    max_redirects: int = 5,
    **kwargs,
) -> requests.Response:
    """Drop-in, SSRF-safe replacement for requests.request(method, url, ...).

    Resolves and validates the hostname immediately before every
    connection this call makes -- the initial one and, if
    allow_redirects is True, every redirect hop -- and pins each
    connection to the specific address that was validated. Redirect
    Location headers are always validated even when allow_redirects is
    False (mirrors safe-fetch.ts, which throws on an unsafe redirect
    target regardless of whether it's actually being followed), so a
    caller that just wants to *see* a 3xx response never has it produced
    by a target that resolves somewhere unsafe.

    kwargs are forwarded to requests.request as-is (headers, json, data,
    timeout, stream, ...); allow_redirects is never forwarded to
    requests itself -- redirects are always handled here, never by
    requests' own follower, so a redirect can never bypass validation
    via requests' internal, unpinned reconnect.
    """
    kwargs.pop("allow_redirects", None)
    proxies = kwargs.get("proxies")
    if proxies:
        raise SSRFError("Proxy configuration is not allowed by the SSRF-safe transport")
    kwargs.pop("proxies", None)
    current_method = method
    current_url = url
    hops = 0

    while True:
        parsed = urlsplit(current_url)
        if parsed.scheme not in ("http", "https"):
            raise SSRFError(f"Only http and https schemes are allowed (got {parsed.scheme!r})")
        hostname = parsed.hostname
        if not hostname:
            raise SSRFError("URL is missing a hostname")

        allow_loopback = hostname_allows_loopback(hostname)
        addresses = resolve_and_validate(hostname, allow_loopback=allow_loopback)
        family, pinned_addr = _pick_pin(addresses)

        with _pinned(hostname, family, pinned_addr):
            response = _SESSION.request(current_method, current_url, allow_redirects=False, **kwargs)

        if response.status_code not in _REDIRECT_STATUSES:
            return response

        location = response.headers.get("Location") or response.headers.get("location")
        if not location:
            return response

        next_url = urljoin(current_url, location)
        next_parsed = urlsplit(next_url)
        if next_parsed.scheme not in ("http", "https"):
            response.close()
            raise SSRFError(f"Redirect blocked: unsupported scheme {next_parsed.scheme!r}")
        next_hostname = next_parsed.hostname
        if not next_hostname:
            response.close()
            raise SSRFError("Redirect blocked: URL is missing a hostname")

        # Always validate the redirect target -- even if we're not about
        # to follow it -- so an unsafe Location header never results in
        # a caller treating this response as a clean, safe result.
        resolve_and_validate(next_hostname, allow_loopback=hostname_allows_loopback(next_hostname))

        if not allow_redirects:
            return response

        hops += 1
        if hops > max_redirects:
            response.close()
            raise SSRFError(f"Too many redirects (> {max_redirects})")

        response.close()
        if response.status_code == 303 or (response.status_code in (301, 302) and current_method.upper() == "POST"):
            current_method = "GET"
            kwargs.pop("json", None)
            kwargs.pop("data", None)
        current_url = next_url


def safe_get(url: str, **kwargs) -> requests.Response:
    return safe_request("GET", url, **kwargs)


def safe_post(url: str, **kwargs) -> requests.Response:
    return safe_request("POST", url, **kwargs)
