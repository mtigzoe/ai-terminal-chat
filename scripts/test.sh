#!/usr/bin/env bash
set -euo pipefail

case "${1:-all}" in
  python)
    python -m pytest server-python/tests -q
    ;;
  typescript)
    (cd server-typescript && npm run typecheck && npm test -- --run)
    ;;
  react)
    (cd client-react && npm test -- --run && npm run build)
    ;;
  all)
    "$0" python
    "$0" typescript
    "$0" react
    ;;
  *)
    echo "Usage: $0 [all|python|typescript|react]" >&2
    exit 2
    ;;
esac
