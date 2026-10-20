#!/usr/bin/env bash
set -euo pipefail
# Compatibility entry point; TypeScript is the primary backend.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/start-electron-ts.sh" "$@"
