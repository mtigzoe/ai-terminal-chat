#!/usr/bin/env bash
set -euo pipefail

# Simple launcher for the Electron development app (Linux/macOS).
#
# Use this when you want one command to start the backend, Vite, and Electron
# in development mode. The development launcher keeps Electron pointed at
# http://localhost:3000 rather than the production dist/ build.
#
# Usage (from repository root):
#   ./scripts/sh/run-electron.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEV_LAUNCHER="$SCRIPT_DIR/start-electron.sh"

if [[ ! -f "$DEV_LAUNCHER" ]]; then
    printf 'Error: Electron development launcher not found: %s\n' "$DEV_LAUNCHER" >&2
    exit 1
fi

chmod +x "$DEV_LAUNCHER" 2>/dev/null || true

printf 'Starting AI Terminal Chat Electron development app...\n\n'
printf 'This will start the Flask backend on port 9000 and Vite on port 3000\n'
printf 'when they are not already running, then launch Electron in development mode.\n\n'

exec "$DEV_LAUNCHER"
