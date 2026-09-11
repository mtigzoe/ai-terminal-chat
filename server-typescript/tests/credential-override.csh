#!/usr/bin/env bash
# Test if credential.helper can be disabled at all

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

echo "Test 1: git -c credential.helper= fetch"
rm -f "$MARKER"
timeout 2 git -C "$DIR" -c credential.helper= fetch 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "❌ FAIL: -c credential.helper= didn't work"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "✅ -c credential.helper= worked"
fi

echo ""
echo "Test 2: git fetch with -c credential.helper=!echo OVERRIDDEN > $MARKER"
rm -f "$MARKER"
timeout 2 git -C "$DIR" -c "credential.helper=!echo OVERRIDDEN > $MARKER" fetch 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "Marker content:"
    cat "$MARKER"
    if grep -q "MALICIOUS" "$MARKER"; then
        echo "❌ Original helper executed"
    elif grep -q "OVERRIDDEN" "$MARKER"; then
        echo "✅ Override worked"
    fi
    rm -f "$MARKER"
else
    echo "No marker created"
fi

echo ""
echo "Test 4: git config --get credential.helper with -c"
git -C "$DIR" -c credential.helper= config --get credential.helper

rm -rf "$(dirname "$MARKER")" 2>/dev/null