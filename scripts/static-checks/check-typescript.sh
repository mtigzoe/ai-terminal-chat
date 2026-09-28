#!/usr/bin/env bash
# Static checks for server-typescript
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server-typescript"

echo "==> TypeScript static checks (server-typescript)"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm ci
fi

echo "--- tsc --noEmit ---"
npx tsc --noEmit

if [ -f package.json ] && grep -q '"lint"' package.json; then
  echo "--- npm run lint ---"
  npm run lint
else
  echo "No lint script found; skipping ESLint."
fi

echo "TypeScript static checks finished."
