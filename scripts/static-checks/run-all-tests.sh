#!/usr/bin/env bash
# Run tests for Python, TypeScript, and React
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0

echo "========================================"
echo "  Running all tests"
echo "========================================"

# Python
echo ""
echo "==> Python tests (server-python)"
cd "$ROOT/server-python"
if command -v pytest >/dev/null 2>&1 || python -m pytest --version >/dev/null 2>&1; then
  python -m pytest -q || FAILED=1
else
  echo "pytest not found. Install with: pip install pytest"
  FAILED=1
fi

# TypeScript
echo ""
echo "==> TypeScript tests (server-typescript)"
cd "$ROOT/server-typescript"
if [ ! -d node_modules ]; then
  npm ci
fi
if grep -q '"test"' package.json 2>/dev/null; then
  npm test || FAILED=1
else
  echo "No test script in package.json; skipping."
fi

# React
echo ""
echo "==> React tests (client-react)"
cd "$ROOT/client-react"
if [ ! -d node_modules ]; then
  npm ci
fi
if grep -q '"test"' package.json 2>/dev/null; then
  npm test -- --run 2>/dev/null || npm test || FAILED=1
else
  echo "No test script in package.json; skipping."
fi

echo ""
echo "========================================"
if [ "$FAILED" -eq 0 ]; then
  echo "  All tests passed"
  exit 0
else
  echo "  Some tests failed"
  exit 1
fi
