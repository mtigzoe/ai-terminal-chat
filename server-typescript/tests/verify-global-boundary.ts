#!/usr/bin/env node
/**
 * Critical test: Does GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL 
 * actually prevent .git/config from being READ when it contains
 * an unmistakable malicious setting?
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const tmp = tmpdir();

function gitInit(dir: string) {
  const { spawnSync } = require("node:child_process");
  spawnSync("git", ["init", "-q", dir], { stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
}

function writeGitConfig(dir: string, config: string) {
  const gitDir = join(dir, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "config"), config);
}

function writeFile(dir: string, path: string, content: string) {
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { resolve, join } = require("node:path");
  mkdirSync(resolve(dir, join(path, "..")), { recursive: true });
  writeFileSync(resolve(dir, path), content);
}

function runGit(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...env },
    timeout: 10000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const tmp = tmpdir();

console.log("=".repeat(80));
console.log("CRITICAL TEST: Does GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL");
console.log("actually prevent .git/config from being READ?");
console.log("=".repeat(80));

// ============================================================
// TEST: Unmistakable malicious setting in .git/config
// ============================================================
console.log("\n=== TEST: Malicious .git/config with GIT_CONFIG_GLOBAL ===");

{
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "test_global_verify_"));
  const { spawnSync, mkdirSync, writeFileSync } = require("node:child_process");
  
  function gitInit(dir: string) {
    spawnSync("git", ["init", "-q", dir], { stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  }

  function writeGitConfig(dir: string, config: string) {
    const gitDir = require("node:path").join(dir, ".git");
    require("node:fs").mkdirSync(require("node:path").join(dir, ".git"), { recursive: true });
    require("node:fs").writeFileSync(require("node:path").join(gitDir, "config"), config);
  }

  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "verify_global_"));
  gitInit(dir);

  const marker = require("node:path").join(require("node:os").tmpdir(), `verify_global_${Date.now()}.txt`);
  if (require("node:fs").existsSync(marker)) require("node:fs").rmSync(marker);

  // Write UNMISTAKABLE malicious config
  writeGitConfig(dir, `
[credential]
    helper = "!echo MALICIOUS_CONFIG_READ > ${require("node:path").join(require("node:os").tmpdir(), "global_verify_marker.txt")}"
[core]
    sshCommand = echo "SSH_MALICIOUS" > ${require("node:path").join(require("node:os").tmpdir(), "ssh_marker.txt")}
[remote "origin"]
    url = https://github.com/test/test.git
`);

  const safeConfig = require("node:path").join(require("node:os").tmpdir(), "safe_verify_global");
  require("node:fs").writeFileSync(safeConfig, `
[remote "origin"]
    url = https://github.com/test/test.git
`);

  const { spawnSync } = require("node:child_process");
  
  const result = spawnSync("git", [
    "fetch", "origin"
  ], {
    cwd: dir,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: require("node:path").join(require("node:os").tmpdir(), "safe_global"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_NOGLOBAL: "1",
    },
  });

  const marker1 = require("node:path").join(require("node:os").tmpdir(), "global_verify_marker.txt");
  const marker2 = require("node:path").join(require("node:os").tmpdir(), "ssh_marker.txt");
  
  const credExecuted = require("node:fs").existsSync(require("node:path").join(require("node:os").tmpdir(), "global_verify_marker.txt"));
  const sshExecuted = require("node:fs").existsSync(require("node:path").join(require("node:os").tmpdir(), "ssh_marker.txt"));
  
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
  
  if (require("node:fs").existsSync(require("node:path").join(require("node:os").tmpdir(), "global_verify_marker.txt"))) 
    require("node:fs").rmSync(require("node:path").join(require("node:os").tmpdir(), "global_verify_marker.txt"));
  if (require("node:fs").existsSync(require("node:path").join(require("node:os").tmpdir(), "ssh_marker.txt")))
    require("node:fs").rmSync(require("node:path").join(require("node:os").tmpdir(), "ssh_marker.txt"));
  require("node:fs").rmSync(dir, { recursive: true, force: true });
  require("node:fs").rmSync(require("node:path").join(require("node:os").tmpdir(), "safe_global"), { force: true });
}

console.log("\n=== VERIFICATION COMPLETE ===");