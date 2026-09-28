#!/usr/bin/env bash
# Static checks for server-python
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/server-python"

echo "==> Python static checks (server-python)"

if ! command -v ruff >/dev/null 2>&1; then
  echo "Installing ruff..."
  pip install ruff --quiet
fi

if ! command -v mypy >/dev/null 2>&1; then
  echo "Installing mypy..."
  pip install mypy --quiet
fi

echo "--- ruff check ---"
ruff check .

echo "--- ruff format --check ---"
ruff format --check .

echo "--- mypy ---"
mypy . --ignore-missing-imports || true

echo "Python static checks finished."
