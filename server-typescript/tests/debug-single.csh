#!/usr/bin/env bash
# Debug single test

set -e

DIR=$(mktemp -d)
MARKER=$(mktemp)

git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"

cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF

echo "Running: GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git config --list"
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list 2>&1

if [ -f "$MARKER" ]; then
    echo "MARKER EXISTS - config read"
    cat "$MARKER"
else
    echo "Marker NOT created - config NOT read"
fi

rm -rf "$DIR"
rm -f "$MARKER"