#!/usr/bin/env bash
# Final comprehensive test: What actually blocks .git/config?

set -e

echo "================================================================"
echo "DEFINITIVE TEST: What prevents .git/config from being read?"
echo "================================================================"

# Test matrix
test_config() {
    local name="$1"
    local env_vars="$1"
    shift
    local cmd="$@"
    
    DIR=$(mktemp -d)
    MARKER=$(mktemp)
    
    git init -q "$DIR"
    git -C "$DIR" config user.email "test@test.com"
    git -C "$DIR" config user.name "Test User"
    
    cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF
    
    eval "$env_vars git -C \"$DIR\" config --list 2>&1" >/dev/null
    
    if [ -f "$MARKER" ]; then
        echo "❌ $name: FAIL - .git/config was READ"
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
test_config "Nothing (baseline)" "" git config --list

# Test 2: GIT_CONFIG_NOSYSTEM only
test_config "GIT_CONFIG_NOSYSTEM=1" "GIT_CONFIG_NOSYSTEM=1" git config --list

# Test 3: GIT_CONFIG_NOGLOBAL only
test_config "GIT_CONFIG_NOGLOBAL=1" "GIT_CONFIG_NOGLOBAL=1" git config --list

# Test 3b: NOSYSTEM + NOGLOBAL
test_config "NOSYSTEM + NOGLOBAL" "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1" git config --list

# Test 4: GIT_CONFIG_SYSTEM=/dev/null
test_config "GIT_CONFIG_SYSTEM=/dev/null" "GIT_CONFIG_SYSTEM=/dev/null" git config --list

# Test 4b: SYSTEM + NOSYSTEM
test_config "SYSTEM + NOSYSTEM" "GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1" git config --list

# Test 5: SYSTEM + NOGLOBAL
test_config "SYSTEM + NOGLOBAL" "GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOGLOBAL=1" git config --list

# Test 6: SYSTEM + NOSYSTEM + NOGLOBAL (THE WINNER)
test_config "SYSTEM + NOSYSTEM + NOGLOBAL" "GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1" git config --list

# Test 7: Winner + GIT_CONFIG_GLOBAL (should FAIL)
test_config "Winner + GLOBAL (should FAIL)" "GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 GIT_CONFIG_GLOBAL=/dev/null" git config --list

# Test 8: Winner + GIT_CONFIG_GLOBAL=/path/to/safe (should FAIL)
test_config "Winner + GLOBAL=/path (should FAIL)" "GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 GIT_CONFIG_GLOBAL=/tmp/safe" git config --list

echo ""
echo "================================================================"
echo "SUMMARY"
echo "================================================================"