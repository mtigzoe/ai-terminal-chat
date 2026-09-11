#!/usr/bin/env bash
# What git commands read .git/config?

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

echo "Test 1: git config --list"
git -C "$DIR" config --list 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 2: git config --get credential.helper"
git -C "$DIR" config --get credential.helper 2>&1
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 3: git config --get-all credential.helper"
git -C "$DIR" config --get-all credential.helper 2>&1
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

# Test with environment variables
echo ""
echo "Test 4: git config --list with GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1"
MARKER2=$(mktemp)
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git config --list 2>&1 | head -5
if [ -f "$MARKER2" ]; then
    echo "MARKER2 CREATED"
    cat "$MARKER2"
    rm -f "$MARKER2"
else
    echo "Marker2 not created"
fi

rm -rf "$(dirname "$MARKER")" 2>/dev/null