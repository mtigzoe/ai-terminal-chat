"""Shared runtime configuration for Python server entry points."""

import os

DEFAULT_SERVER_PORT = 9000
MAX_SERVER_PORT = 65535


def parse_server_port(raw_value: str | None) -> int:
    """Return a valid TCP port, falling back safely on malformed input."""

    if raw_value is None:
        return DEFAULT_SERVER_PORT

    try:
        port = int(raw_value.strip())
    except (AttributeError, TypeError, ValueError):
        return DEFAULT_SERVER_PORT

    if 0 <= port <= MAX_SERVER_PORT:
        return port
    return DEFAULT_SERVER_PORT


def get_server_port() -> int:
    """Read and validate the configured server port."""

    return parse_server_port(os.getenv("PORT"))
