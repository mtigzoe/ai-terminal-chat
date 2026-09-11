#!/usr/bin/env bash
# Test if -c overrides work for fetch

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

echo "Test 1: git fetch with -c credential.helper="
timeout 2 git -C "$DIR" -c credential.helper= fetch 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED - credential.helper NOT overridden"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created - -c override WORKED"
fi

echo ""
echo "Test 2: git fetch with -c core.sshCommand="
rm -f "$MARKER"
cat > "$DIR/.git/config" <<EOF
[core]
    sshCommand = echo "SSH_MALICIOUS" > $MARKER
[remote "origin"]
    url = ssh://git@localhost:2222/test/test.git
EOF

timeout 2 git -C "$DIR" -c core.sshCommand= fetch origin 2>&1 | head -3 || true
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED - sshCommand NOT overridden"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created - -c override WORKED"
fi

echo ""
echo "Test 3: git config --list with -c credential.helper="
rm -f "$MARKER"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
git -C "$DIR" -c credential.helper= config --list 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED - -c didn't override for config --list"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created - -c override WORKED for config --list"
fi

rm -rf "$(dirname "$MARKER")" 2>/dev/null