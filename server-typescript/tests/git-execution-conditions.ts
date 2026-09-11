#!/usr/bin/env node
/**
 * Additional experiments to verify execution conditions.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const tmp = tmpdir();

function gitInit(dir: string) {
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
  mkdirSync(resolve(dir, join(path, "..")), { recursive: true });
  writeFileSync(resolve(dir, path), content);
}

function runGit(cwd: string, args: string[], env: Record<string, string> = {}) {
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

function createMarker() {
  const marker = join(tmp, `marker_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  if (existsSync(marker)) rmSync(marker);
  return marker;
}

function checkMarker(marker: string): boolean {
  return existsSync(marker);
}

const testResults: Array<{ test: string; passed: boolean; details: string }> = [];

function recordResult(test: string, passed: boolean, details: string) {
  testResults.push({ test, passed, details });
  console.log(`${passed ? "✅" : "❌"} ${test}: ${details}`);
}

async function runTests() {
  console.log("=".repeat(80));
  console.log("ADDITIONAL EXECUTION CONDITION TESTS");
  console.log("=".repeat(80));

  // ============================================================
  // TEST: credential.helper with actual HTTPS remote that prompts
  // ============================================================
  console.log("\n--- TEST: credential.helper with failing HTTPS fetch ---");

  {
    const dir = mkdtempSync(join(tmp, "test_cred_real_"));
    gitInit(dir);
    const marker = join(tmp, "cred_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[credential]
    helper = "!echo CREDENTIAL_EXECUTED > ${join(tmp, "cred_real_marker.txt")}"
[remote "origin"]
    url = https://github.com/nonexistent/repo.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });

    const executed = existsSync(join(tmp, "cred_real_marker.txt"));
    recordResult(
      "credential.helper executes when fetch fails with auth prompt",
      executed,
      executed ? "VULNERABILITY: credential.helper executes on auth failure" : "NOT EXECUTED: fetch failed before credential prompt"
    );
    if (executed) rmSync(join(tmp, "cred_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: core.sshCommand with SSH URL that actually tries to connect
  // ============================================================
  console.log("\n--- TEST: core.sshCommand with failing SSH ---");

  {
    const dir = mkdtempSync(join(tmp, "test_ssh_real_"));
    gitInit(dir);
    const marker = join(tmp, "ssh_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[core]
    sshCommand = echo "SSH_COMMAND_EXECUTED" > ${join(tmp, "ssh_real_marker.txt")}
[remote "origin"]
    url = ssh://git@localhost:2222/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });

    const executed = existsSync(join(tmp, "ssh_real_marker.txt"));
    recordResult(
      "core.sshCommand executes when SSH connection attempted",
      executed,
      executed ? "VULNERABILITY: core.sshCommand executes on SSH attempt" : "NOT EXECUTED: SSH failed before command"
    );
    if (executed) rmSync(join(tmp, "ssh_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: core.askPass
  // ============================================================
  console.log("\n--- TEST: core.askPass ---");

  {
    const dir = mkdtempSync(join(tmp, "test_askpass_real_"));
    gitInit(dir);
    const marker = join(tmp, "askpass_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[core]
    askPass = echo "ASKPASS_EXECUTED" > ${join(tmp, "askpass_real_marker.txt")}
[remote "origin"]
    url = ssh://git@localhost:2222/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });

    const executed = existsSync(join(tmp, "askpass_real_marker.txt"));
    recordResult(
      "core.askPass executes when SSH asks for password",
      executed,
      executed ? "VULNERABILITY: core.askPass executes" : "NOT EXECUTED"
    );
    if (executed) rmSync(join(tmp, "askpass_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: .gitattributes filter clean on actual add
  // ============================================================
  console.log("\n--- TEST: .gitattributes filter clean on real add ---");

  {
    const dir = mkdtempSync(join(tmp, "test_attrs_real_"));
    gitInit(dir);
    const marker = join(tmp, "attrs_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[filter "evil"]
    clean = echo "FILTER_CLEAN_REAL" > ${join(tmp, "attrs_real_marker.txt")}
    smudge = cat
`);

    writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
    writeFile(dir, "test.txt", "test content");

    const result = spawnSync("git", ["add", "test.txt"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "attrs_real_marker.txt"));
    recordResult(
      ".gitattributes filter.evil.clean executes on REAL git add",
      executed,
      executed ? "VULNERABILITY: .gitattributes filter executes" : "BLOCKED"
    );
    if (executed) rmSync(join(tmp, "attrs_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: .gitattributes filter smudge on checkout
  // ============================================================
  console.log("\n--- TEST: .gitattributes filter smudge on checkout ---");

  {
    const dir = mkdtempSync(join(tmp, "test_smudge_real_"));
    gitInit(dir);
    const marker = join(tmp, "smudge_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[filter "evil"]
    smudge = echo "FILTER_SMUDGE_REAL" > ${join(tmp, "smudge_real_marker.txt")}
    clean = cat
`);

    writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
    writeFile(dir, "test.txt", "test content");
    spawnSync("git", ["add", "test.txt"], { cwd: dir, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
    rmSync(join(dir, "test.txt"), { force: true });

    const result = spawnSync("git", ["checkout", "HEAD", "--", "test.txt"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "smudge_real_marker.txt"));
    recordResult(
      ".gitattributes filter smudge executes on git checkout",
      existsSync(join(tmp, "smudge_real_marker.txt")),
      existsSync(join(tmp, "smudge_real_marker.txt")) ? "VULNERABILITY" : "BLOCKED"
    );
    if (existsSync(join(tmp, "smudge_real_marker.txt"))) rmSync(join(tmp, "smudge_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: Does git config --list load attacker config?
  // ============================================================
  console.log("\n--- TEST: git config --list loads attacker config ---");

  {
    const dir = mkdtempSync(join(tmp, "test_config_list_"));
    gitInit(dir);
    const marker = join(tmp, "config_list_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[credential]
    helper = "!echo CONFIG_LIST_EXECUTED > ${join(tmp, "config_list_marker.txt")}"
`);

    const result = spawnSync("git", ["config", "--null", "--list"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "config_list_marker.txt"));
    recordResult(
      "git config --list executes credential.helper",
      executed,
      executed ? "VULNERABILITY: git config --list executes credential.helper" : "NOT EXECUTED"
    );
    if (executed) rmSync(join(tmp, "config_list_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: git config --file=malicious loads attacker config
  // ============================================================
  console.log("\n--- TEST: git config --file=malicious loads attacker config ---");

  {
    const dir = mkdtempSync(join(tmp, "test_config_file_"));
    gitInit(dir);
    const marker = join(tmp, "config_file_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeFileSync(join(dir, "malicious.config"), `
[credential]
    helper = "!echo CONFIG_FILE_EXECUTED > ${join(tmp, "config_file_marker.txt")}"
`);

    const result = spawnSync("git", ["config", "--file", join(dir, "malicious.config"), "--null", "--list"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "config_file_marker.txt"));
    recordResult(
      "git config --file=malicious executes credential.helper",
      executed,
      executed ? "VULNERABILITY: git config --file executes credential.helper" : "NOT EXECUTED"
    );
    if (executed) rmSync(join(tmp, "config_file_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: GIT_CONFIG_NOSYSTEM/NOGLOBAL with actual execution
  // ============================================================
  console.log("\n--- TEST: GIT_CONFIG_NOSYSTEM/NOGLOBAL with credential.helper ---");

  {
    const dir = mkdtempSync(join(tmp, "test_nosystem_real_"));
    gitInit(dir);
    const marker = join(tmp, "nosystem_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[credential]
    helper = "!echo NOSYSTEM_BYPASS > ${join(tmp, "nosystem_real_marker.txt")}"
[remote "origin"]
    url = https://github.com/nonexistent/repo.git
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
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_NOGLOBAL: "1",
      },
    });

    const executed = existsSync(join(tmp, "nosystem_real_marker.txt"));
    recordResult(
      "GIT_CONFIG_NOSYSTEM/NOGLOBAL do NOT block .git/config credential.helper",
      executed,
      executed ? "CONFIRMED: NOSYSTEM/NOGLOBAL do NOT block .git/config" : "NOT EXECUTED"
    );
    if (executed) rmSync(join(tmp, "nosystem_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: GIT_CONFIG_GLOBAL + NOSYSTEM/NOGLOBAL with real execution
  // ============================================================
  console.log("\n--- TEST: GIT_CONFIG_GLOBAL=sanitized + NOSYSTEM/NOGLOBAL ---");

  {
    const dir = mkdtempSync(join(tmp, "test_global_real_"));
    gitInit(dir);
    const marker = join(tmp, "global_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[credential]
    helper = "!echo GLOBAL_BYPASS > ${join(tmp, "global_real_marker.txt")}"
[remote "origin"]
    url = https://github.com/nonexistent/repo.git
`);

    const safeConfig = join(tmp, "safe_global_real");
    writeFileSync(safeConfig, `
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
        GIT_CONFIG_GLOBAL: safeConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_NOGLOBAL: "1",
      },
    });

    const executed = existsSync(join(tmp, "global_real_marker.txt"));
    recordResult(
      "GIT_CONFIG_GLOBAL=sanitized + NOSYSTEM/NOGLOBAL blocks .git/config credential.helper",
      !executed,
      executed ? "VULNERABLE: GLOBAL bypassed" : "BLOCKED: GLOBAL works"
    );
    if (executed) rmSync(join(tmp, "global_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
    rmSync(safeConfig, { force: true });
  }

  // ============================================================
  // TEST: GIT_CONFIG_SYSTEM=NUL + NOSYSTEM/NOGLOBAL with real execution
  // ============================================================
  console.log("\n--- TEST: GIT_CONFIG_SYSTEM=NUL + NOSYSTEM/NOGLOBAL ---");

  {
    const dir = mkdtempSync(join(tmp, "test_system_real_"));
    gitInit(dir);
    const marker = join(tmp, "system_real_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[credential]
    helper = "!echo SYSTEM_BYPASS > ${join(tmp, "system_real_marker.txt")}"
[remote "origin"]
    url = https://github.com/nonexistent/repo.git
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
        GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_NOGLOBAL: "1",
      },
    });

    const executed = existsSync(join(tmp, "system_real_marker.txt"));
    recordResult(
      "GIT_CONFIG_SYSTEM=NUL + NOSYSTEM/NOGLOBAL blocks .git/config",
      !executed,
      executed ? "VULNERABLE: SYSTEM=null bypassed" : "BLOCKED: SYSTEM=null works"
    );
    if (executed) rmSync(join(tmp, "system_real_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: Hooks with -c core.hooksPath= on all hook types
  // ============================================================
  console.log("\n--- TEST: All hook types with -c core.hooksPath= ---");

  {
    const dir = mkdtempSync(join(tmp, "test_all_hooks_"));
    gitInit(dir);

    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });

    // pre-commit
    const preCommitMarker = join(tmp, "pre_commit_marker.txt");
    if (existsSync(preCommitMarker)) rmSync(preCommitMarker);
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho "PRE_COMMIT" > ${join(tmp, "pre_commit_marker.txt")}\nexit 0\n`);
    chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);

    // pre-push
    const prePushMarker = join(tmp, "pre_push_marker.txt");
    if (existsSync(prePushMarker)) rmSync(prePushMarker);
    writeFileSync(join(dir, ".git", "hooks", "pre-push"), `#!/bin/sh\necho "PRE_PUSH" > ${join(tmp, "pre_push_marker.txt")}\nexit 0\n`);
    chmodSync(join(dir, ".git", "hooks", "pre-push"), 0o755);

    // pre-merge-commit
    const preMergeMarker = join(tmp, "pre_merge_marker.txt");
    if (existsSync(preMergeMarker)) rmSync(preMergeMarker);
    writeFileSync(join(dir, ".git", "hooks", "pre-merge-commit"), `#!/bin/sh\necho "PRE_MERGE" > ${join(tmp, "pre_merge_marker.txt")}\nexit 0\n`);
    chmodSync(join(dir, ".git", "hooks", "pre-merge-commit"), 0o755);

    // post-merge
    const postMergeMarker = join(tmp, "post_merge_marker.txt");
    if (existsSync(postMergeMarker)) rmSync(postMergeMarker);
    writeFileSync(join(dir, ".git", "hooks", "post-merge"), `#!/bin/sh\necho "POST_MERGE" > ${join(tmp, "post_merge_marker.txt")}\nexit 0\n`);
    chmodSync(join(dir, ".git", "hooks", "post-merge"), 0o755);

    writeFile(dir, "test.txt", "test");
    spawnSync("git", ["add", "test.txt"], { cwd: dir, stdio: "ignore" });

    // Test pre-commit
    const commitResult = spawnSync("git", [
      "-c", "core.hooksPath=",
      "commit", "-m", "test"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const preCommitExecuted = existsSync(preCommitMarker);
    recordResult(
      "pre-commit blocked by -c core.hooksPath=",
      !preCommitExecuted,
      preCommitExecuted ? "VULNERABLE: pre-commit executes" : "BLOCKED"
    );
    if (preCommitExecuted) rmSync(preCommitMarker);

    // Test pre-push
    spawnSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
    const pushResult = spawnSync("git", [
      "-c", "core.hooksPath=",
      "push", "origin", "main"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const prePushExecuted = existsSync(prePushMarker);
    recordResult(
      "pre-push blocked by -c core.hooksPath=",
      !prePushExecuted,
      prePushExecuted ? "VULNERABLE: pre-push executes" : "BLOCKED"
    );
    if (prePushExecuted) rmSync(prePushMarker);

    // Test pre-merge-commit
    const mergeResult = spawnSync("git", [
      "-c", "core.hooksPath=",
      "pull", "origin", "main"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const preMergeExecuted = existsSync(preMergeMarker);
    recordResult(
      "pre-merge-commit blocked by -c core.hooksPath=",
      !preMergeExecuted,
      preMergeExecuted ? "VULNERABLE: pre-merge executes" : "BLOCKED"
    );
    if (preMergeExecuted) rmSync(preMergeMarker);

    // post-merge
    const postMergeExecuted = existsSync(postMergeMarker);
    recordResult(
      "post-merge blocked by -c core.hooksPath=",
      !postMergeExecuted,
      postMergeExecuted ? "VULNERABLE: post-merge executes" : "BLOCKED"
    );
    if (postMergeExecuted) rmSync(postMergeMarker);

    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST: .git/config.worktree
  // ============================================================
  console.log("\n--- TEST: .git/config.worktree ---");

  {
    const dir = mkdtempSync(join(tmp, "test_worktree_config_"));
    gitInit(dir);
    const marker = join(tmp, "worktree_config_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[credential]
    helper = "!echo WORKTREE_CONFIG_EXECUTED > ${join(tmp, "worktree_marker.txt")}"
`);

    const result = spawnSync("git", ["config", "--list"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "worktree_config_test.txt"));
    recordResult(
      "git config --list reads .git/config (not worktree-specific yet)",
      existsSync(marker),
      existsSync(marker) ? "Read .git/config" : "Not executed"
    );
    if (existsSync(marker)) rmSync(marker);
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;

  testResults.forEach(r => {
    console.log(`${r.passed ? "✅" : "❌"} ${r.test}`);
    console.log(`    ${r.details}`);
  });

  console.log(`\nTotal: ${testResults.length}, Passed: ${passed}, Failed: ${failed}`);

  console.log("\n" + "=".repeat(80));
  console.log("KEY FINDINGS - EXECUTION CONDITIONS");
  console.log("=".repeat(80));
}

runTests().catch(console.error);