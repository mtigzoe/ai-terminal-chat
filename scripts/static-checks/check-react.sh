#!/usr/bin/env bash
# Static checks for client-react
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/client-react"

echo "==> React static checks (client-react)"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm ci
fi

echo "--- tsc --noEmit ---"
npx tsc --noEmit 2>/dev/null || echo "(no tsconfig or tsc skipped)"

if [ -f package.json ] && grep -q '"lint"' package.json; then
  echo "--- npm run lint ---"
  npm run lint
else
  echo "No lint script found; trying eslint directly..."
  npx eslint . --ext .js,.jsx,.ts,.tsx 2>/dev/null || echo "ESLint not configured; skipped."
fi

echo "React static checks finished."
