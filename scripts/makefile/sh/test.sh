#!/usr/bin/env bash
set -euo pipefail

case "${1:-all}" in
  typescript)
    (cd server-typescript && npm run typecheck && npm test -- --run)
    ;;
  react)
    (cd client-react && npm test -- --run && npm run build)
    ;;
  all)
    "$0" typescript
    "$0" react
    ;;
  *)
    echo "Usage: $0 [all|typescript|react]" >&2
    exit 2
    ;;
esac
