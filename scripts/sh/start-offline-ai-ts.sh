#!/usr/bin/env bash
set -euo pipefail

# Start AI Terminal Chat on Linux/macOS with a local Ollama server, backed by
# the TypeScript API server instead of the Python/Flask one.
# The script installs backend and frontend dependencies when needed.
#
# Override the model when needed:
#   ./scripts/sh/start-offline-ai-ts.sh qwen3.5:9b
# Or set environment variables:
#   OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen3.5:9b ./scripts/sh/start-offline-ai-ts.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# scripts/sh -> scripts -> repository root
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server-typescript"
CLIENT_DIR="$REPO_ROOT/client-react"

if ! command -v npm >/dev/null 2>&1; then
    printf 'Error: npm is required but was not found in PATH.\n' >&2
    exit 1
fi

if [[ ! -f "$SERVER_DIR/package.json" ]]; then
    printf 'Error: server-typescript/package.json was not found. Expected repository root at: %s\n' "$REPO_ROOT" >&2
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

printf 'AI Terminal Chat - Linux/macOS + local Ollama (TypeScript backend)\n'
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

printf '\nPreparing TypeScript backend...\n'
if [[ ! -d "$SERVER_DIR/node_modules" ]]; then
    printf 'Installing backend dependencies with npm...\n'
    (cd "$SERVER_DIR" && npm install)
else
    printf 'Backend dependencies already installed; skipping npm install.\n'
fi

if [[ ! -d "$CLIENT_DIR/node_modules" ]]; then
    printf 'Installing React dependencies with npm...\n'
    (cd "$CLIENT_DIR" && npm install)
else
    printf 'React dependencies already installed; skipping npm install.\n'
fi

printf '\nStarting TypeScript backend...\n'
(cd "$SERVER_DIR" && exec npm run dev) &
SERVER_PID=$!

cleanup() {
    printf '\nStopping TypeScript backend (PID %s)...\n' "$SERVER_PID"
    kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf 'Starting React frontend...\n'
cd "$CLIENT_DIR"
npm run dev
