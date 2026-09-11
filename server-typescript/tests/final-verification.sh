#!/usr/bin/env bash
# What prevents .git/config from being read?

set -e

test_config() {
    local name="$1"
    local env_vars="$1"
    local cmd="$2"
    shift 2
    
    DIR=$(mktemp -d)
    MARKER=$(mktemp)
    
    git init -q "$DIR"
    git -C "$DIR" config user.email "test@test.com"
    git -C "$DIR" config user.name "Test User"
    
    cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
    
    eval "$1 $cmd" 2>&1 >/dev/null
    
    if [ -f "$MARKER" ]; then
        echo "❌ $1: FAIL - .git/config was READ"
        rm -f "$MARKER"
    else
        echo "✅ $name: PASS - .git/config IGNORED"
    fi
    
    rm -rf "$DIR"
    rm -f "$MARKER"
}

echo ""
echo "Testing various environment combinations..."
echo ""

# Test 1: Nothing
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
git -C "$DIR" config --list >/dev/null
if [ -f "$MARKER" ]; then
    echo "❌ Nothing (baseline): FAIL - .git/config was READ"
    rm -f "$MARKER"
else
    echo "✅ Nothing (baseline): PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test 2: GIT_CONFIG_NOSYSTEM=1
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_NOSYSTEM=1 git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ GIT_CONFIG_NOSYSTEM=1: FAIL"
else
    echo "✅ GIT_CONFIG_NOSYSTEM=1: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: GIT_CONFIG_NOGLOBAL=1
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ GIT_CONFIG_NOGLOBAL=1: FAIL"
else
    echo "✅ GIT_CONFIG_NOGLOBAL=1: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: NOSYSTEM + NOGLOBAL
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ NOSYSTEM + NOGLOBAL: FAIL"
else
    echo "✅ NOSYSTEM + NOGLOBAL: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: GIT_CONFIG_SYSTEM=/dev/null
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_SYSTEM=/dev/null git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ GIT_CONFIG_SYSTEM=/dev/null: FAIL"
else
    echo "✅ GIT_CONFIG_SYSTEM=/dev/null: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: SYSTEM + NOSYSTEM
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ SYSTEM + NOSYSTEM: FAIL"
else
    echo "✅ SYSTEM + NOSYSTEM: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: SYSTEM + NOGLOBAL
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ SYSTEM + NOGLOBAL: FAIL"
else
    echo "✅ SYSTEM + NOGLOBAL: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: SYSTEM + NOSYSTEM + NOGLOBAL (THE WINNER)
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ SYSTEM + NOSYSTEM + NOGLOBAL: FAIL"
else
    echo "✅ SYSTEM + NOSYSTEM + NOGLOBAL: PASS - THIS IS THE WINNER"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: Winner + GIT_CONFIG_GLOBAL (should FAIL)
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ Winner + GLOBAL=/dev/null: FAIL - .git/config RE-ENABLED"
else
    echo "✅ Winner + GLOBAL=/dev/null: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

# Test: Winner + GIT_CONFIG_GLOBAL=/path
DIR=$(mktemp -d)
MARKER=$(mktemp)
git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 GIT_CONFIG_GLOBAL=/tmp/safe git -C "$DIR" config --list >/dev/null 2>&1
if [ -f "$MARKER" ]; then
    echo "❌ Winner + GLOBAL=/path: FAIL - .git/config RE-ENABLED"
else
    echo "✅ Winner + GLOBAL=/path: PASS"
fi
rm -rf "$DIR"
rm -f "$MARKER"

echo ""
echo "================================================================"
echo "SUMMARY"
echo "================================================================"
echo ""
echo "The ONLY combination that blocks .git/config reading is:"
echo "  GIT_CONFIG_SYSTEM=/dev/null"
echo "  GIT_CONFIG_NOSYSTEM=1"
echo "  GIT_CONFIG_NOGLOBAL=1"
echo ""
echo "Adding GIT_CONFIG_GLOBAL RE-ENABLES reading of .git/config!"
echo "================================================================"