#!/usr/bin/env node
/**
 * Critical test: Does GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL 
 * actually prevent .git/config from being READ?
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function main() {
    function gitInit(dir) {
        const { spawnSync } = require("node:child_process");
        spawnSync("git", ["init", "-q", dir], { stdio: "ignore" });
        spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
        spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
    }

    function writeGitConfig(dir, config) {
        const gitDir = path.join(dir, ".git");
        fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
        fs.writeFileSync(path.join(gitDir, "config"), config);
    }

    console.log("=".repeat(80));
    console.log("CRITICAL TEST: Does GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL");
    console.log("actually prevent .git/config from being READ?");
    console.log("=".repeat(80));

    console.log("\n=== TEST: Malicious .git/config with GIT_CONFIG_GLOBAL ===");

    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "verify_global_"));

    function writeGitConfig(dir, config) {
        const gitDir = path.join(dir, ".git");
        fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
        fs.writeFileSync(path.join(gitDir, "config"), config);
    }

    function gitInit(dir) {
        const { spawnSync } = require("node:child_process");
        spawnSync("git", ["init", "-q", dir], { stdio: "ignore" });
        spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
        spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify_global_"));

    gitInit(dir);

    const marker1 = path.join(os.tmpdir(), "global_verify_marker_" + Date.now() + ".txt");
    const marker2 = path.join(os.tmpdir(), "ssh_marker.txt");

    if (fs.existsSync(marker1)) fs.rmSync(marker1);
    if (fs.existsSync(marker2)) fs.rmSync(marker2);

    // Write UNMISTAKABLE malicious config
    const maliciousConfig = 
`[credential]
    helper = "!echo MALICIOUS_CONFIG_READ > ` + path.join(os.tmpdir(), "global_verify_marker.txt") + `"
[core]
    sshCommand = echo "SSH_MALICIOUS" > ` + path.join(os.tmpdir(), "ssh_marker.txt") + `
[remote "origin"]
    url = https://github.com/test/test.git
`;

    const gitDir = path.join(dir, ".git");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "config"), maliciousConfig);

    const safeConfig = path.join(os.tmpdir(), "safe_verify_global");
    fs.writeFileSync(safeConfig, `
[remote "origin"]
    url = https://github.com/test/test.git
`);

    const result = spawnSync("git", [
        "fetch", "origin"
    ], {
        cwd: dir,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10000,
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "safe_global"),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_NOGLOBAL: "1",
        },
    });

    const credExecuted = fs.existsSync(path.join(os.tmpdir(), "global_verify_marker.txt"));
    const sshExecuted = fs.existsSync(path.join(os.tmpdir(), "ssh_marker.txt"));

    console.log("credential.helper executed:", credExecuted);
    console.log("core.sshCommand executed:", sshExecuted);
    console.log("Fetch exit code:", result.status);
    console.log("Fetch stderr:", result.stderr?.substring(0, 200));

    if (credExecuted || sshExecuted) {
        console.log("\n❌ FAILURE: .git/config WAS READ despite GIT_CONFIG_GLOBAL");
        console.log("  This means the security boundary is NOT established.");
    } else {
        console.log("\n✅ SUCCESS: .git/config was IGNORED");
        console.log("  GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL establishes the boundary.");
    }

    if (fs.existsSync(path.join(os.tmpdir(), "global_verify_marker.txt"))) 
        fs.rmSync(path.join(os.tmpdir(), "global_verify_marker.txt"));
    if (fs.existsSync(path.join(os.tmpdir(), "ssh_marker.txt")))
        fs.rmSync(path.join(os.tmpdir(), "ssh_marker.txt"));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), "safe_global"), { force: true });

    console.log("\n=== VERIFICATION COMPLETE ===");
}

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

runTest();