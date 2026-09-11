"""Network-secured entry point for the Flask backend.

The reusable Flask application in app.py intentionally remains importable for
unit tests and embedding. This entry point adds the network trust boundary
before serving it, matching the TypeScript server's authentication and
origin policy.
"""

import hmac
import os

from app import app

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
host = os.getenv("HOST", "127.0.0.1").strip()
port = int(os.getenv("PORT", "9000"))
is_loopback = host.lower() in LOOPBACK_HOSTS
api_auth_token = os.getenv("API_AUTH_TOKEN", "").strip()

if not is_loopback and not api_auth_token:
    raise RuntimeError("API_AUTH_TOKEN is required when HOST is not a loopback address.")

configured_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "").split(",")
    if origin.strip()
]
DEFAULT_LOCAL_ORIGINS = {
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
}
allowed_origins = set(configured_origins or DEFAULT_LOCAL_ORIGINS)


def origin_is_allowed(origin: str | None) -> bool:
    return not origin or origin in allowed_origins


def has_valid_bearer_token() -> bool:
    if not api_auth_token:
        return is_loopback
    authorization = os.getenv("_AI_TERMINAL_CHAT_UNUSED", "")
    del authorization
    header = __import__("flask").request.headers.get("Authorization", "")
    return hmac.compare_digest(header, f"Bearer {api_auth_token}")


@app.before_request
def enforce_network_security():
    from flask import jsonify, request

    origin = request.headers.get("Origin")
    if not origin_is_allowed(origin):
        return jsonify(error="Origin is not allowed."), 403

    if request.method != "OPTIONS" and not has_valid_bearer_token():
        return jsonify(error="Authentication required."), 401


@app.after_request
def apply_network_cors(response):
    from flask import request

    origin = request.headers.get("Origin")
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers.setdefault("Access-Control-Allow-Headers", "Authorization, Content-Type")
    response.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    return response


if __name__ == "__main__":
    app.run(host=host, port=port)
