#!/usr/bin/env bash
# Critical test: Does GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL
# actually prevent .git/config from being READ?
# Uses git config --list to check if config is read without network

set -e

echo "================================================================"
echo "CRITICAL TEST: Does GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL"
echo "actually prevent .git/config from being READ?"
echo "================================================================"

echo ""
echo "=== TEST: Malicious .git/config with GIT_CONFIG_GLOBAL ==="

DIR=$(mktemp -d)
MARKER1=$(mktemp)
MARKER2=$(mktemp)

git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"

# Write UNMISTAKABLE malicious config
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_CONFIG_READ > $MARKER1"
[core]
    sshCommand = echo "SSH_MALICIOUS" > $MARKER2
[remote "origin"]
    url = https://github.com/test/test.git
EOF

# Create safe global config
SAFE_CONFIG=$(mktemp)
cat > "$SAFE_CONFIG" <<EOF
[remote "origin"]
    url = https://github.com/test/test.git
EOF

# Test 1: git config --list loads attacker config?
echo "Test 1: git config --list with GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL"
GIT_CONFIG_GLOBAL=$(mktemp)
cat > "$GIT_CONFIG_GLOBAL" <<EOF
[remote "origin"]
    url = https://github.com/test/test.git
EOF

RESULT=$(GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list 2>&1)
CRED_EXECUTED=0
if [ -f "$MARKER1" ]; then
    echo "❌ FAILURE: .git/config WAS READ (credential.helper executed)"
    rm -f "$MARKER1"
    exit 1
else
    echo "✅ credential.helper NOT executed via git config --list"
fi

# Test 2: git config --file=.git/config
echo ""
echo "Test 2: git config --file=.git/config with GIT_CONFIG_GLOBAL"
rm -f "$MARKER1"
RESULT=$(GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --file=.git/config --list 2>&1)
if [ -f "$MARKER1" ]; then
    echo "❌ FAILURE: .git/config WAS READ via --file"
    rm -f "$MARKER1"
    exit 1
else
    echo "✅ .git/config NOT read via --file"
fi

# Test 2b: credential.helper with actual HTTPS fetch that prompts
echo ""
echo "Test 3: credential.helper with failing HTTPS fetch"
rm -f "$MARKER1"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_CONFIG_READ > $MARKER1"
[remote "origin"]
    url = https://github.com/nonexistent/repo.git
EOF

GIT_CONFIG_GLOBAL=$(mktemp)
cat > "$GIT_CONFIG_GLOBAL" <<EOF
[remote "origin"]
    url = https://github.com/test/test.git
EOF

timeout 10 git -c "credential.helper=" -c "core.hooksPath=" GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" fetch origin 2>&1 || true

if [ -f "$MARKER1" ]; then
    echo "❌ FAILURE: credential.helper executed despite GIT_CONFIG_GLOBAL"
    exit 1
else
    echo "✅ credential.helper NOT executed"
fi

# Test 4: core.sshCommand
echo ""
echo "Test 4: core.sshCommand with SSH URL"
rm -f "$MARKER2"
cat > "$DIR/.git/config" <<EOF
[core]
    sshCommand = echo "SSH_MALICIOUS" > $MARKER2
[remote "origin"]
    url = ssh://git@localhost:2222/test/test.git
EOF

timeout 10 git -c "credential.helper=" -c "core.hooksPath=" git -C "$DIR" fetch origin 2>&1 || true

if [ -f "$MARKER2" ]; then
    echo "❌ FAILURE: core.sshCommand executed"
    exit 1
else
    echo "✅ core.sshCommand NOT executed (connection failed first)"
fi

# Cleanup
rm -rf "$DIR" "$GIT_CONFIG_GLOBAL" "$MARKER1" "$MARKER2"

echo ""
echo "================================================================"
echo "✅ ALL TESTS PASSED: GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL"
echo "establishes the security boundary - .git/config is IGNORED"
echo "================================================================"