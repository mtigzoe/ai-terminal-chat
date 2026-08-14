import os
import sys
from pathlib import Path

import pytest

# app.py is in the parent directory of this test package.
SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

os.environ.setdefault("GOOGLE_API_KEY", "test-key")

import app  # noqa: E402


@pytest.fixture
def client():
    app.app.testing = True
    with app.app.test_client() as client:
        yield client


def test_providers_endpoint_reports_current_and_supported(client):
    response = client.get("/providers")
    assert response.status_code == 200

    data = response.get_json()
    assert data["current"] == "gemini"  # PROVIDER unset -> providers.py default
    assert data["providers"] == ["gemini", "ollama", "kilo"]
    assert data["current"] in data["providers"]
