import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from nvidia import NVIDIAProvider  # noqa: E402


def test_nvidia_provider_rejects_whitespace_only_api_key():
    with pytest.raises(RuntimeError, match="NVIDIA_API_KEY"):
        NVIDIAProvider(api_key="   \t\n")
