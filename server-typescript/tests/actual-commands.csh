#!/usr/bin/env bash
# Test which actual git commands execute malicious config

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

echo "Test 1: git fetch (no remote)"
git -C "$DIR" fetch 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

echo ""
echo "Test 2: git fetch origin"
git -C "$DIR" fetch origin 2>&1 | head -3
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
echo "Test 5: git push (no remote)"
git -C "$DIR" push 2>&1 | head -3
if [ -f "$MARKER" ]; then
    echo "MARKER CREATED"
    cat "$MARKER"
    rm -f "$MARKER"
else
    echo "Marker not created"
fi

# Test with SSH URL (triggers sshCommand)
echo ""
echo "Test 6: git fetch with SSH URL (triggers sshCommand)"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo CRED_MALICIOUS > $MARKER"
[core]
    sshCommand = echo "SSH_MALICIOUS" > $MARKER
[remote "origin"]
    url = ssh://git@localhost:2222/test/test.git
EOF

MARKER2=$(mktemp)
timeout 5 git -C "$DIR" fetch origin 2>&1 | head -5 || true
if [ -f "$MARKER2" ]; then
    echo "MARKER2 CREATED"
    cat "$MARKER2"
    rm -f "$MARKER2"
else
    echo "Marker2 not created"
fi

# Test with env vars
echo ""
echo "Test 7: git fetch with GIT_CONFIG_SYSTEM=/dev/null + NOSYSTEM + NOGLOBAL"
rm -f "$MARKER"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
[core]
    sshCommand = echo "SSH_MALICIOUS" > $MARKER
[remote "origin"]
    url = ssh://git@localhost:2222/test/test.git
EOF

MARKER3=$(mktemp)
timeout 5 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" fetch origin 2>&1 | head -5 || true
if [ -f "$MARKER3" ]; then
    echo "MARKER3 CREATED"
    cat "$MARKER3"
    rm -f "$MARKER3"
else
    echo "Marker3 not created"
fi

rm -rf "$DIR"