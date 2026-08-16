#!/usr/bin/env bash
set -euo pipefail

# Start the Electron desktop development environment on Linux.
# Starts Flask and Vite when needed, then launches Electron.
#
# Usage (from repository root):
#   ./scripts/start-electron.sh
#
# If this file is invoked with `bash scripts/start-electron.sh`, ensure the
# executable bit is restored for future direct invocations.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server-python"
CLIENT_DIR="$REPO_ROOT/client-react"
VENV_DIR="$SERVER_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

# Restore executable permission when the script is run through bash.
chmod +x "$SCRIPT_DIR/start-electron.sh" 2>/dev/null || true

if ! command -v uv >/dev/null 2>&1; then
    printf 'Error: uv is required but was not found in PATH. Install uv and run this script again.\n' >&2
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    printf 'Error: npm is required but was not found in PATH.\n' >&2
    exit 1
fi
if [[ ! -f "$SERVER_DIR/app.py" ]]; then
    printf 'Error: server-python/app.py was not found.\n' >&2
    exit 1
fi
if [[ ! -f "$CLIENT_DIR/package.json" ]]; then
    printf 'Error: client-react/package.json was not found.\n' >&2
    exit 1
fi

port_in_use() {
    local port="$1"
    if command -v curl >/dev/null 2>&1; then
        curl --silent --show-error --max-time 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1
    else
        (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1
    fi
}

wait_for_url() {
    local url="$1"
    local name="$2"
    for _ in {1..30}; do
        if curl --silent --show-error --max-time 1 "$url" >/dev/null 2>&1; then
            printf '%s is ready.\n' "$name"
            return 0
        fi
        sleep 1
    done
    printf 'Error: %s did not become ready within 30 seconds.\n' "$name" >&2
    return 1
}

printf 'AI Terminal Chat - Electron\n\n'

if [[ ! -x "$VENV_PYTHON" ]]; then
    printf 'Creating Python virtual environment...\n'
    (cd "$SERVER_DIR" && uv venv .venv)
fi

printf 'Installing/updating Python dependencies with uv...\n'
(cd "$SERVER_DIR" && uv pip install --python "$VENV_PYTHON" -r requirements.txt)

if [[ ! -x "$CLIENT_DIR/node_modules/.bin/electron" ]]; then
    printf 'Installing frontend dependencies...\n'
    (cd "$CLIENT_DIR" && npm ci)
fi

BACKEND_PID=""
FRONTEND_PID=""
BACKEND_STARTED=0
FRONTEND_STARTED=0

cleanup() {
    if [[ "$FRONTEND_STARTED" -eq 1 && -n "$FRONTEND_PID" ]]; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi
    if [[ "$BACKEND_STARTED" -eq 1 && -n "$BACKEND_PID" ]]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

if ! port_in_use 9000; then
    printf 'Starting Flask backend with the project virtual environment...\n'
    BACKEND_PID=$(
        bash -c 'cd "$1" && source .venv/bin/activate && exec uv run app.py' _ "$SERVER_DIR" &
        echo $!
    )
    BACKEND_STARTED=1
    wait_for_url "http://127.0.0.1:9000/providers?probe=0" "Flask backend"
else
    printf 'Flask backend is already running on port 9000.\n'
fi

if ! port_in_use 3000; then
    printf 'Starting Vite development server...\n'
    (cd "$CLIENT_DIR" && exec npm run dev) &
    FRONTEND_PID=$!
    FRONTEND_STARTED=1
    wait_for_url "http://127.0.0.1:3000/" "Vite"
else
    printf 'Vite is already running on port 3000.\n'
fi

printf '\nLaunching Electron...\n'
(cd "$CLIENT_DIR" && npm run electron)
