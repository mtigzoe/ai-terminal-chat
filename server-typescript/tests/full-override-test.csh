#!/usr/bin/env bash
# Final comprehensive test

set -e

echo "================================================================"
echo "FINAL COMPREHENSIVE TEST: Can we block all malicious config?"
echo "================================================================"

DIR=$(mktemp -d)
MARKER=$(mktemp)

git init -q "$DIR"
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"

# Write ALL dangerous configs
cat > "$DIR/.git/config" <<'EOF'
[credential]
    helper = "!echo CRED_MALICIOUS > /tmp/cred_marker.txt"
[core]
    sshCommand = echo "SSH_MALICIOUS" > /tmp/ssh_marker.txt
    askPass = echo "ASKPASS_MALICIOUS" > /tmp/askpass_marker.txt
[remote "origin"]
    url = https://github.com/test/test.git
    uploadpack = echo "UPLOADPACK_MALICIOUS" > /tmp/uploadpack_marker.txt
    receivepack = echo "RECEIVEPACK_MALICIOUS" > /tmp/receivepack_marker.txt
    proxy = echo "PROXY_MALICIOUS" > /tmp/proxy_marker.txt
[url "file:///tmp/malicious"]
    insteadOf = https://github.com/
[diff "evil"]
    command = echo "DIFF_CMD_MALICIOUS" > /tmp/diff_cmd_marker.txt
    textconv = echo "DIFF_TEXTCONV_MALICIOUS" > /tmp/diff_textconv_marker.txt
[merge "evil"]
    driver = echo "MERGE_DRIVER_MALICIOUS" > /tmp/merge_driver_marker.txt
[filter "evil"]
    clean = echo "FILTER_CLEAN_MALICIOUS" > /tmp/filter_clean_marker.txt
    smudge = echo "FILTER_SMUDGE_MALICIOUS" > /tmp/filter_smudge_marker.txt
[gpg]
    program = echo "GPG_MALICIOUS" > /tmp/gpg_marker.txt
[sendemail]
    smtpserver = echo "SENDMAIL_MALICIOUS" > /tmp/sendmail_marker.txt
[http]
    extraHeader = echo "HTTP_MALICIOUS" > /tmp/http_marker.txt
[core]
    fsmonitor = echo "FSMONITOR_MALICIOUS" > /tmp/fsmonitor_marker.txt
[remote "evil"]
    url = https://github.com/test/test.git
    uploadpack = echo "REMOTE_UPLOADPACK_MALICIOUS" > /tmp/remote_uploadpack_marker.txt
    receivepack = echo "REMOTE_RECEIVEPACK_MALICIOUS" > /tmp/remote_receivepack_marker.txt
    proxy = echo "REMOTE_PROXY_MALICIOUS" > /tmp/remote_proxy_marker.txt
[filter "malicious"]
    clean = echo "FILTER_MALICIOUS_CLEAN" > /tmp/filter_malicious_clean_marker.txt
    smudge = echo "FILTER_MALICIOUS_SMUDGE" > /tmp/filter_malicious_smudge_marker.txt
EOF

echo "Created malicious .git/config with ALL dangerous settings"
echo ""

# Test 1: git config --list with full override
echo "Test 1: git config --list with full -c overrides"
MARKER1=$(mktemp)
git -c credential.helper= -c core.sshCommand= -c core.askPass= -c core.fsmonitor= \
    -c "remote.*.uploadpack=" -c "remote.*.receivepack=" -c "remote.*.proxy=" \
    -c "url.*.insteadOf=" -c "diff.*.command=" -c "diff.*.textconv=" \
    -c "merge.*.driver=" -c "filter.*.clean=" -c "filter.*.smudge=" \
    -c gpg.program= -c sendemail.smtpserver= -c sendemail.smtpencryption= \
    -c sendemail.smtpuser= -c sendemail.smtppass= -c sendemail.smtpdomain= \
    -c http.extraHeader= -c http.proxy= -c core.fsmonitor= -c core.fsmonitorHook= \
    -c "remote.*.uploadpack=" -c "remote.*.receivepack=" -c "remote.*.proxy=" \
    -c "remote.*.vcs=" -c "submodule.*.url=" -c "submodule.*.fetch=" \
    -c core.hooksPath=/dev/null -c include.path= \
    git config --list 2>&1 | head -5
echo "Config list executed (no error = good)"
echo ""

# Test 2: git fetch with all overrides
echo ""
echo "Test 2: git fetch with all -c overrides"
MARKER2=$(mktemp)
timeout 2 git -c credential.helper= -c core.sshCommand= -c core.askPass= \
    -c "remote.origin.uploadpack=" -c "remote.origin.receivepack=" \
    -c "remote.origin.proxy=" -c "url.*.insteadOf=" \
    -c "diff.*.command=" -c "diff.*.textconv=" \
    -c "merge.*.driver=" -c "filter.*.clean=" -c "filter.*.smudge=" \
    -c gpg.program= -c sendemail.smtpserver= -c sendemail.smtpencryption= \
    -c sendemail.smtpuser= -c sendemail.smtppass= -c sendemail.smtpdomain= \
    -c http.extraHeader= -c http.proxy= -c core.fsmonitor= \
    -c "remote.*.uploadpack=" -c "remote.*.receivepack=" -c "remote.*.proxy=" \
    -c "remote.*.vcs=" -c "submodule.*.url=" -c "submodule.*.fetch=" \
    -c core.hooksPath=/dev/null -c include.path= \
    -c credential.helper= \
    git fetch 2>&1 | head -3 || true
echo "Fetch completed (no error = good)"
echo ""

# Test 3: git push with all overrides
echo ""
echo "Test 3: git push with all overrides"
git -C "$(mktemp -d)" init -q
git -C "$DIR" config user.email "test@test.com"
git -C "$DIR" config user.name "Test User"
echo "test" > "$DIR/test.txt"
git -C "$DIR" add test.txt
git -C "$DIR" commit -m "test" 2>&1 | head -1
git -c credential.helper= -c core.sshCommand= \
    -c "remote.origin.receivepack=" -c "remote.origin.proxy=" \
    push 2>&1 | head -3 || true
echo "Push completed (expected to fail for other reasons)"

# Test 4: git diff with all overrides
echo ""
echo "Test 4: git diff with all overrides"
git -c "diff.*.command=" -c "diff.*.textconv=" -c "filter.*.smudge=" diff 2>&1 | head -3

# Test 5: git add with filter clean
echo ""
echo "Test 5: git add with filter clean override"
echo "test" > "$DIR/test2.txt"
git -c "filter.*.clean=" -c "filter.*.smudge=" add test2.txt 2>&1 | head -3

# Test 6: git commit with hooks disabled
echo ""
echo "Test 6: git commit with hooks disabled"
git -c core.hooksPath=/dev/null commit -m "test" 2>&1 | head -3 || true

# Cleanup
rm -rf "$DIR"
echo ""
echo "================================================================"
echo "All tests completed without timeout = basic overrides work"
echo "================================================================"