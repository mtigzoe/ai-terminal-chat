#!/usr/bin/env bash
# Quick test of actual commands with short timeouts

set -e

DIR=$(mktemp -d)
MARKER=$(mktemp)

git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"

cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
[core]
    sshCommand = echo "SSH_MALICIOUS" > $MARKER
[remote "origin"]
    url = https://github.com/test/test.git
EOF

echo "Test 1: git fetch (no remote, short timeout)"
timeout 2 git -C "$DIR" fetch 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 2: git status"
git -C "$DIR" status 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 3: git diff"
git -C "$DIR" diff 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 3b: git add"
echo "test" > "$DIR/test.txt"
git -C "$DIR" add test.txt 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 4: git commit"
git -C "$DIR" commit -m "test" 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

# Test with SSH URL
echo ""
echo "Test 5: SSH URL with sshCommand"
cat > "$DIR/.git/config" <<EOF
[core]
    sshCommand = echo "SSH_MALICIOUS" > $MARKER
[remote "origin"]
    url = ssh://git@localhost:2222/test/test.git
EOF

timeout 2 git -C "$DIR" fetch origin 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 6: git push with SSH URL"
git -C "$DIR" push 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

# Test with env vars
echo ""
echo "Test 7: with GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1"
rm -f "$MARKER"
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

rm -rf "$(dirname "$MARKER")" 2>/dev/null