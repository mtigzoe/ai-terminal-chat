#!/usr/bin/env bash
# More detailed investigation

set -e

DIR=$(mktemp -d)
MARKER=$(mktemp)

git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"

# Write malicious config
cat > "$DIR/.git/config" <<EOF
[credential]
    helper = "!echo MALICIOUS_READ > $MARKER"
EOF

# Test with GIT_CONFIG_GLOBAL
GIT_CONFIG_GLOBAL=$(mktemp)
cat > "$GIT_CONFIG_GLOBAL" <<EOF
[remote "origin"]
    url = https://github.com/test/test.git
EOF

echo "Testing git config --list with GIT_CONFIG_GLOBAL..."
GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_NOGLOBAL=1 git -C "$DIR" config --list 2>&1

if [ -f "$MARKER" ]; then
    echo "MARKER FILE EXISTS - .git/config WAS READ"
    cat "$MARKER"
else
    echo "Marker not found"
fi

# Cleanup
rm -rf "$DIR" "$GIT_CONFIG_GLOBAL" "$MARKER"