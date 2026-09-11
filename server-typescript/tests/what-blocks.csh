#!/usr/bin/env bash
# What DOES prevent .git/config from being read?

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

# Test 1: GIT_CONFIG_GLOBAL only
echo "=== Test 1: GIT_CONFIG_GLOBAL only ==="
GIT_CONFIG_GLOBAL=$(mktemp)
echo "[remote \"origin\"]" > "$GIT_CONFIG_GLOBAL"
echo "    url = https://github.com/test/test.git" >> "$GIT_CONFIG_GLOBAL"

GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" git -C "$DIR" config --list 2>&1 | head -5
if [ -f "$MARKER" ]; then
    echo "❌ Marker exists - config read"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi
rm -f "$MARKER"

# Test 2: GIT_CONFIG_SYSTEM=/dev/null + NOSYSTEM + NOGLOBAL
echo ""
echo "=== Test 2: GIT_CONFIG_SYSTEM=/dev/null + NOSYSTEM + NOGLOBAL ==="
DIR2=$(mktemp -d)
MARKER2=$(mktemp)
git init -q "$DIR2"
git -C "$DIR2" config user.email "test@test.com"
git -C "$DIR2" config user.name "Test User"
cat > "$DIR2/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF

GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR2" config --list 2>&1 | head -5
if [ -f "$MARKER" ]; then
    echo "❌ Marker exists - config read"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

# Test 3: GIT_CONFIG_GLOBAL + GIT_CONFIG_SYSTEM + NOSYSTEM + NOGLOBAL
echo ""
echo "=== Test 3: GIT_CONFIG_GLOBAL + GIT_CONFIG_SYSTEM + NOSYSTEM + NOGLOBAL ==="
DIR3=$(mktemp -d)
MARKER3=$(mktemp)
git init -q "$DIR3"
git -C "$DIR3" config user.email "test@test.com"
git -C "$DIR3" config user.name "Test User"
cat > "$DIR3/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF

GIT_CONFIG_GLOBAL=$(mktemp)
echo "[remote \"origin\"]" > "$GIT_CONFIG_GLOBAL"
echo "    url = https://github.com/test/test.git" >> "$GIT_CONFIG_GLOBAL"

GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR3" config --list 2>&1 | head -5

if [ -f "$MARKER3" ]; then
    echo "Marker created - config read"
    cat "$MARKER3"
else
    echo "Marker not created"
fi

# Cleanup
rm -rf "$DIR" "$DIR2" "$DIR3" /tmp/marker* /tmp/safe_* /tmp/verify_global_* 2>/dev/null