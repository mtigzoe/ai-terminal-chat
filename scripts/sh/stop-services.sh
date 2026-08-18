#!/usr/bin/env bash
set -euo pipefail

# Stop AI Terminal Chat development services that are listening on the
# default ports (Flask backend on 9000, Vite on 3000).
#
# This script only targets listeners on those ports. It does not kill
# arbitrary Node or Python processes.
#
# Usage (from repository root):
#   ./scripts/sh/stop-services.sh

kill_port() {
    local port="$1"
    local name="$2"
    local pids

    if command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    elif command -v fuser >/dev/null 2>&1; then
        # fuser prints "port/tcp: pid ..."
        pids=$(fuser "${port}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)
    else
        printf 'Warning: neither lsof nor fuser is available; cannot stop %s on port %s.\n' "$name" "$port" >&2
        return 0
    fi

    if [[ -z "${pids}" ]]; then
        printf '%s (port %s): no listener found.\n' "$name" "$port"
        return 0
    fi

    for pid in $pids; do
        printf 'Stopping %s (port %s) — PID %s...\n' "$name" "$port" "$pid"
        kill "$pid" 2>/dev/null || true
        # Give the process a moment to exit cleanly, then force if needed
        sleep 0.5
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
}

printf 'Stopping AI Terminal Chat development services...\n\n'

kill_port 9000 "Flask backend"
kill_port 3000 "Vite"

printf '\nDone. Ports 9000 and 3000 should now be free (if they were in use).\n'
