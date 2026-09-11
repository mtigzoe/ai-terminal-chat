"""Regression tests for the network security boundary around Flask."""

import os
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import secure_server  # noqa: E402


@pytest.fixture
def client():
    secure_server.app.testing = True
    original_loopback = secure_server.is_loopback
    original_token = secure_server.api_auth_token
    original_origins = secure_server.allowed_origins
    try:
        yield secure_server.app.test_client()
    finally:
        secure_server.is_loopback = original_loopback
        secure_server.api_auth_token = original_token
        secure_server.allowed_origins = original_origins


def test_loopback_allows_requests_without_token(client):
    secure_server.is_loopback = True
    secure_server.api_auth_token = ""
    response = client.get("/providers?probe=0")
    assert response.status_code == 200


def test_non_loopback_requires_bearer_token(client):
    secure_server.is_loopback = False
    secure_server.api_auth_token = "test-token"
    response = client.get("/providers?probe=0")
    assert response.status_code == 401
    assert response.get_json()["error"] == "Authentication required."


def test_non_loopback_accepts_exact_bearer_token(client):
    secure_server.is_loopback = False
    secure_server.api_auth_token = "test-token"
    response = client.get(
        "/providers?probe=0",
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 200


def test_non_loopback_rejects_wrong_origin_before_dispatch(client):
    secure_server.is_loopback = False
    secure_server.api_auth_token = "test-token"
    secure_server.allowed_origins = {"http://localhost:3000"}
    response = client.get(
        "/providers?probe=0",
        headers={
            "Authorization": "Bearer test-token",
            "Origin": "https://attacker.example",
        },
    )
    assert response.status_code == 403
    assert response.get_json()["error"] == "Origin is not allowed."


def test_options_preflight_is_allowed_without_auth(client):
    secure_server.is_loopback = False
    secure_server.api_auth_token = "test-token"
    secure_server.allowed_origins = {"http://localhost:3000"}
    response = client.options(
        "/providers",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "http://localhost:3000"


def test_non_loopback_without_token_is_rejected_at_startup():
    with pytest.raises(RuntimeError, match="API_AUTH_TOKEN is required"):
        secure_server.validate_network_config("0.0.0.0", "")


def test_loopback_without_token_is_valid_configuration():
    secure_server.validate_network_config("127.0.0.1", "")


def test_non_loopback_with_token_is_valid_configuration():
    secure_server.validate_network_config("0.0.0.0", "test-token")
