#!/usr/bin/env bash
set -euo pipefail

# Start AI Terminal Chat on Linux/macOS with a local Ollama server.
# The script installs frontend dependencies when needed and creates/updates the
# Python uv virtual environment automatically.
#
# Override the model when needed:
#   ./scripts/sh/start-offline-ai.sh qwen3.5:9b
# Or set environment variables:
#   OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen3.5:9b ./scripts/sh/start-offline-ai.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# scripts/sh -> scripts -> repository root
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server-python"
CLIENT_DIR="$REPO_ROOT/client-react"
VENV_DIR="$SERVER_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

if ! command -v uv >/dev/null 2>&1; then
    printf 'Error: uv is required but was not found in PATH.\n' >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    printf 'Error: npm is required but was not found in PATH.\n' >&2
    exit 1
fi

if [[ ! -f "$SERVER_DIR/app.py" ]]; then
    printf 'Error: server-python/app.py was not found. Expected repository root at: %s\n' "$REPO_ROOT" >&2
    exit 1
fi
if [[ ! -f "$CLIENT_DIR/package.json" ]]; then
    printf 'Error: client-react/package.json was not found. Expected repository root at: %s\n' "$REPO_ROOT" >&2
    exit 1
fi

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
OLLAMA_HOST="${OLLAMA_HOST%/}"
OLLAMA_MODEL="${1:-${OLLAMA_MODEL:-qwen3.5:9b}}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-$OLLAMA_HOST/v1}"

export PROVIDER="ollama"
export OLLAMA_HOST
export OLLAMA_BASE_URL
export OLLAMA_MODEL

printf 'AI Terminal Chat - Linux/macOS + local Ollama\n'
printf 'Ollama server: %s\n' "$OLLAMA_HOST"
printf 'Ollama model:  %s\n\n' "$OLLAMA_MODEL"

# Verify Ollama is running and reachable.
if ! curl --fail --silent --show-error --max-time 5 "$OLLAMA_HOST/api/tags" >/dev/null; then
    printf 'Error: Could not reach Ollama at %s\n' "$OLLAMA_HOST" >&2
    printf 'Start Ollama with: ollama serve\n' >&2
    exit 1
fi

printf 'Ollama server is reachable.\n'

# Check that the requested model is installed when ollama CLI is available.
if command -v ollama >/dev/null 2>&1; then
    if ! ollama list | awk 'NR > 1 {print $1}' | grep -Fxq "$OLLAMA_MODEL"; then
        printf 'Warning: model "%s" was not found in ollama list.\n' "$OLLAMA_MODEL" >&2
        printf 'Install it with: ollama pull %s\n' "$OLLAMA_MODEL" >&2
    fi
else
    printf 'Warning: ollama CLI was not found; continuing because the HTTP server is reachable.\n' >&2
fi

printf '\nPreparing Python environment...\n'
if [[ ! -x "$VENV_PYTHON" ]]; then
    printf 'Creating uv virtual environment...\n'
    (cd "$SERVER_DIR" && uv venv .venv)
fi

printf 'Installing/updating Python dependencies...\n'
(cd "$SERVER_DIR" && uv pip install --python "$VENV_PYTHON" -r requirements.txt)

if [[ ! -d "$CLIENT_DIR/node_modules" ]]; then
    printf 'Installing React dependencies with npm...\n'
    (cd "$CLIENT_DIR" && npm install)
else
    printf 'React dependencies already installed; skipping npm install.\n'
fi

printf '\nStarting Flask backend...\n'
(
    cd "$SERVER_DIR"
    exec "$VENV_PYTHON" app.py
) &
SERVER_PID=$!

cleanup() {
    printf '\nStopping Flask backend (PID %s)...\n' "$SERVER_PID"
    kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf 'Starting React frontend...\n'
cd "$CLIENT_DIR"
npm run dev
