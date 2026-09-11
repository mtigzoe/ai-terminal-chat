#!/usr/bin/env bash
# Test if -c overrides work for credential.helper in fetch

set -e

DIR=$(mktemp -d)
MARKER=$(mktemp)

git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"

cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
[remote "origin"]
    url = https://github.com/test/test.git
EOF

echo "Test 1: git fetch with -c credential.helper= (empty)"
timeout 2 git -C "$DIR" -c credential.helper= fetch 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "❌ FAIL: MARKER CREATED - credential.helper NOT overridden"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "✅ PASS: Marker not created - override worked"
fi

echo ""
echo "Test 2: git fetch with -c credential.helper=none"
rm -f "$MARKER"
timeout 2 git -C "$DIR" -c credential.helper=none fetch 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "❌ FAIL: MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "✅ PASS: Marker not created"
fi

echo ""
echo "Test 3: git fetch with -c credential.helper=/bin/true"
rm -f "$MARKER"
timeout 2 git -C "$DIR" -c credential.helper=/bin/true fetch 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "❌ FAIL: MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "✅ PASS: Marker not created"
fi

rm -rf "$(dirname "$MARKER")" 2>/dev/null