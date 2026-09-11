#!/usr/bin/env node
/**
 * Experimental verification of Git configuration security boundaries.
 * Tests whether various mitigation strategies actually prevent attacker-controlled execution.
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
    timeout: 5000,
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
  console.log("GIT CONFIG SECURITY BOUNDARY EXPERIMENTS");
  console.log("=".repeat(80));

  // ============================================================
  // TEST 1: Does -c with wildcard actually work?
  // ============================================================
  console.log("\n--- TEST 1: Wildcard -c override behavior ---");

  {
    const dir = mkdtempSync(join(tmp, "test_wildcard_"));
    gitInit(dir);
    const marker = join(tmp, `wildcard_test_${Date.now()}.txt`);
    if (existsSync(marker)) rmSync(marker);

    // Write malicious config with arbitrary subsection
    writeGitConfig(dir, `
[diff "evil"]
    command = echo "DIFF_EVIL_EXECUTED" > ${join(tmp, "diff_wildcard_marker.txt")}
`);

    writeFile(dir, "test.txt", "original");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "test.txt"], { cwd: dir, stdio: "ignore" });
    writeFile(dir, "test.txt", "modified");

    // Test: -c diff.*.command=  (does Git support wildcards?)
    const result = spawnSync("git", [
      "-c", "diff.*.command=",
      "diff", "test.txt"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "diff_wildcard_marker.txt"));
    recordResult(
      "Wildcard -c diff.*.command= overrides diff.evil.command",
      !executed,
      executed ? "VULNERABLE: Wildcard override FAILED, diff.evil.command executed" : "BLOCKED: Wildcard override worked"
    );
    if (executed) rmSync(join(tmp, "diff_wildcard_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 2: Does -c with specific subsection override work?
  // ============================================================
  console.log("\n--- TEST 2: Specific subsection -c override ---");

  {
    const dir = mkdtempSync(join(tmp, "test_specific_"));
    gitInit(dir);
    const marker = join(tmp, "specific_override_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[diff "evil"]
    command = echo "SPECIFIC_EXECUTED" > ${join(tmp, "specific_marker.txt")}
`);

    writeFile(dir, "test.txt", "original");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "test.txt"], { cwd: dir, stdio: "ignore" });
    writeFile(dir, "test.txt", "modified");

    // Test: -c diff.evil.command= (exact match)
    const result = spawnSync("git", [
      "-c", "diff.evil.command=",
      "diff", "test.txt"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "specific_marker.txt"));
    recordResult(
      "Specific -c diff.evil.command= overrides diff.evil.command",
      !executed,
      executed ? "VULNERABLE: Specific override FAILED" : "BLOCKED: Specific override worked"
    );
    if (executed) rmSync(join(tmp, "specific_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 3: remote.*.uploadpack wildcard vs arbitrary remote
  // ============================================================
  console.log("\n--- TEST 3: remote.*.uploadpack wildcard ---");

  {
    const dir = mkdtempSync(join(tmp, "test_remote_"));
    gitInit(dir);
    const marker = join(tmp, "remote_uploadpack_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[remote "evil"]
    url = https://github.com/test/test.git
    uploadpack = echo "UPLOADPACK_EXECUTED" > ${join(tmp, "remote_uploadpack_marker.txt")}
`);

    const result = spawnSync("git", [
      "-c", "remote.*.uploadpack=",
      "fetch", "--no-recurse-submodules", "evil"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "remote_uploadpack_marker.txt"));
    recordResult(
      "Wildcard -c remote.*.uploadpack= overrides remote.evil.uploadpack",
      !executed,
      executed ? "VULNERABLE: Wildcard remote.* override FAILED" : "BLOCKED: Wildcard remote.* override worked"
    );
    if (executed) rmSync(join(tmp, "remote_uploadpack_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 4: Specific remote override
  // ============================================================
  console.log("\n--- TEST 4: Specific remote override ---");

  {
    const dir = mkdtempSync(join(tmp, "test_remote_specific_"));
    gitInit(dir);
    const marker = join(tmp, "remote_specific_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[remote "evil"]
    url = https://github.com/test/test.git
    uploadpack = echo "SPECIFIC_UPLOADPACK_EXECUTED" > ${join(tmp, "remote_specific_marker.txt")}
`);

    const result = spawnSync("git", [
      "-c", "remote.evil.uploadpack=",
      "fetch", "--no-recurse-submodules", "evil"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "remote_specific_marker.txt"));
    recordResult(
      "Specific -c remote.evil.uploadpack= overrides remote.evil.uploadpack",
      !executed,
      executed ? "VULNERABLE: Specific remote override FAILED" : "BLOCKED: Specific remote override worked"
    );
    if (executed) rmSync(join(tmp, "remote_specific_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 5: core.sshCommand NOT in denylist
  // ============================================================
  console.log("\n--- TEST 5: core.sshCommand (missing from denylist) ---");

  {
    const dir = mkdtempSync(join(tmp, "test_ssh_"));
    gitInit(dir);
    const marker = join(tmp, "ssh_command_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[core]
    sshCommand = echo "SSH_COMMAND_EXECUTED" > ${join(tmp, "ssh_marker.txt")}
[remote "origin"]
    url = ssh://git@github.com/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "ssh_marker.txt"));
    recordResult(
      "core.sshCommand (NOT in denylist) executes",
      executed, // This SHOULD execute to prove vulnerability
      executed ? "VULNERABILITY CONFIRMED: core.sshCommand executes" : "UNEXPECTED: sshCommand didn't execute"
    );
    if (executed) rmSync(join(tmp, "ssh_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 6: credential.helper executes
  // ============================================================
  console.log("\n--- TEST 6: credential.helper (missing from denylist) ---");

  {
    const dir = mkdtempSync(join(tmp, "test_cred_"));
    gitInit(dir);
    const marker = join(tmp, "credential_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[credential]
    helper = "!echo CREDENTIAL_EXECUTED > ${join(tmp, "cred_marker.txt")}"
[remote "origin"]
    url = https://github.com/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "cred_marker.txt"));
    recordResult(
      "credential.helper (NOT in denylist) executes",
      executed,
      executed ? "VULNERABILITY CONFIRMED: credential.helper executes" : "UNEXPECTED"
    );
    if (executed) rmSync(join(tmp, "cred_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 7: GIT_CONFIG_NOSYSTEM/NOGLOBAL do NOT block .git/config
  // ============================================================
  console.log("\n--- TEST 7: GIT_CONFIG_NOSYSTEM/NOGLOBAL do NOT block .git/config ---");

  {
    const dir = mkdtempSync(join(tmp, "test_nosystem_"));
    gitInit(dir);
    const marker = join(tmp, "nosystem_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[core]
    sshCommand = echo "NOSYSTEM_BYPASS" > ${join(tmp, "nosystem_marker.txt")}
[remote "origin"]
    url = ssh://git@github.com/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_NOGLOBAL: "1",
      },
    });

    const executed = existsSync(join(tmp, "nosystem_marker.txt"));
    recordResult(
      "GIT_CONFIG_NOSYSTEM/NOGLOBAL do NOT block .git/config sshCommand",
      executed, // Should execute to prove the boundary is NOT established
      executed ? "CONFIRMED: GIT_CONFIG_NOSYSTEM/NOGLOBAL do NOT block .git/config" : "UNEXPECTED"
    );
    if (executed) rmSync(join(tmp, "nosystem_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 8: -c core.hooksPath= on Windows
  // ============================================================
  console.log("\n--- TEST 8: -c core.hooksPath= on Windows ---");

  {
    const dir = mkdtempSync(join(tmp, "test_hooks_"));
    gitInit(dir);
    const marker = join(tmp, "hooks_test.txt");
    if (existsSync(marker)) rmSync(marker);

    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), `#!/bin/sh\necho "HOOK_EXECUTED" > ${join(tmp, "hook_marker.txt")}\nexit 0\n`);
    const { chmodSync } = await import("node:fs");
    chmodSync(join(hooksDir, "pre-commit"), 0o755);

    writeFile(dir, "test.txt", "test");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "test.txt"], { cwd: dir, stdio: "ignore" });

    // Test: -c core.hooksPath= (empty) - does it disable .git/hooks/ ?
    const result = spawnSync("git", [
      "-c", "core.hooksPath=",
      "commit", "-m", "test"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "hook_marker.txt"));
    recordResult(
      "-c core.hooksPath= disables .git/hooks/pre-commit on Windows",
      !executed,
      executed ? "VULNERABLE: -c core.hooksPath= does NOT disable .git/hooks/" : "BLOCKED: -c core.hooksPath= disables hooks"
    );
    if (executed) rmSync(join(tmp, "hook_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 8b: -c core.hooksPath=empty_dir
  // ============================================================
  console.log("\n--- TEST 8b: -c core.hooksPath=empty_dir ---");

  {
    const dir = mkdtempSync(join(tmp, "test_hooks_dir_"));
    gitInit(dir);
    const marker = join(tmp, "hooks_dir_test.txt");
    if (existsSync(marker)) rmSync(marker);

    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), `#!/bin/sh\necho "HOOK_EXECUTED" > ${join(tmp, "hook_dir_marker.txt")}\nexit 0\n`);
    const { chmodSync } = await import("node:fs");
    chmodSync(join(hooksDir, "pre-commit"), 0o755);

    writeFile(dir, "test.txt", "test");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "test.txt"], { cwd: dir, stdio: "ignore" });

    const emptyDir = mkdtempSync(join(tmp, "empty_hooks_"));

    const result = spawnSync("git", [
      "-c", `core.hooksPath=${emptyDir}`,
      "commit", "-m", "test"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "hook_dir_marker.txt"));
    recordResult(
      "-c core.hooksPath=empty_dir disables .git/hooks/pre-commit on Windows",
      !executed,
      executed ? "VULNERABLE: empty dir doesn't disable hooks" : "BLOCKED: empty dir disables hooks"
    );
    if (executed) rmSync(join(tmp, "hook_dir_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
    rmSync(marker, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 9: .gitattributes filter execution
  // ============================================================
  console.log("\n--- TEST 9: .gitattributes filter execution ---");

  {
    const dir = mkdtempSync(join(tmp, "test_attrs_"));
    gitInit(dir);
    const marker = join(tmp, "attrs_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[filter "evil"]
    clean = echo "FILTER_CLEAN_EXECUTED" > ${join(tmp, "attrs_marker.txt")}
    smudge = cat
`);

    writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
    writeFile(dir, "test.txt", "test content");

    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("git", ["add", "test.txt"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "attrs_marker.txt"));
    recordResult(
      ".gitattributes filter.<name>.clean executes on git add",
      executed,
      executed ? "VULNERABILITY: .gitattributes filter executes" : "BLOCKED"
    );
    if (executed) rmSync(join(tmp, "attrs_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 10: include.path bypass
  // ============================================================
  console.log("\n--- TEST 10: include.path bypass ---");

  {
    const dir = mkdtempSync(join(tmp, "test_include_"));
    gitInit(dir);
    const marker = join(tmp, "include_test.txt");
    if (existsSync(marker)) rmSync(marker);

    // Create malicious included config
    const evilConfig = join(dir, "evil_config");
    writeFileSync(evilConfig, `
[core]
    sshCommand = echo "INCLUDE_EXECUTED" > ${join(tmp, "include_marker.txt")}
`);

    writeGitConfig(dir, `
[include]
    path = ${evilConfig}
[remote "origin"]
    url = ssh://git@github.com/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "include_marker.txt"));
    recordResult(
      "include.path bypasses -c overrides",
      executed,
      executed ? "VULNERABILITY: include.path bypasses -c overrides" : "BLOCKED"
    );
    if (executed) rmSync(join(tmp, "include_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 11: Does -c include.path=sanitized override include.path in repo?
  // ============================================================
  console.log("\n--- TEST 11: -c include.path= overrides repo include.path ---");

  {
    const dir = mkdtempSync(join(tmp, "test_include_override_"));
    gitInit(dir);
    const marker = join(tmp, "include_override_test.txt");
    if (existsSync(marker)) rmSync(marker);

    const evilConfig = join(dir, "evil_config");
    writeFileSync(evilConfig, `
[core]
    sshCommand = echo "INCLUDE_OVERRIDE_EXECUTED" > ${join(tmp, "include_override_marker.txt")}
`);

    writeGitConfig(dir, `
[include]
    path = ${evilConfig}
[remote "origin"]
    url = ssh://git@github.com/test/test.git
`);

    // Create a sanitized config that's safe
    const safeConfig = join(tmp, "safe_config");
    writeFileSync(safeConfig, `
[remote "origin"]
    url = https://github.com/test/test.git
`);

    const result = spawnSync("git", [
      "-c", `include.path=${safeConfig}`,
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "include_override_marker.txt"));
    recordResult(
      "-c include.path=safe overrides repo include.path",
      !executed,
      executed ? "VULNERABLE: -c include.path doesn't override" : "BLOCKED: -c include.path works"
    );
    if (executed) rmSync(join(tmp, "include_override_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
    rmSync(safeConfig, { force: true });
  }

  // ============================================================
  // TEST 12: Does GIT_CONFIG_GLOBAL point to sanitized config?
  // ============================================================
  console.log("\n--- TEST 12: GIT_CONFIG_GLOBAL=sanitized ---");

  {
    const dir = mkdtempSync(join(tmp, "test_global_"));
    gitInit(dir);
    const marker = join(tmp, "global_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[core]
    sshCommand = echo "GLOBAL_BYPASS" > ${join(tmp, "global_marker.txt")}
[remote "origin"]
    url = ssh://git@github.com/test/test.git
`);

    const safeConfig = join(tmp, "safe_global");
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
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: safeConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_NOGLOBAL: "1",
      },
    });

    const executed = existsSync(join(tmp, "global_marker.txt"));
    recordResult(
      "GIT_CONFIG_GLOBAL=sanitized + NOSYSTEM/NOGLOBAL blocks .git/config",
      !executed,
      executed ? "VULNERABLE: GIT_CONFIG_GLOBAL doesn't block" : "BLOCKED: GIT_CONFIG_GLOBAL works"
    );
    if (executed) rmSync(join(tmp, "global_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
    rmSync(safeConfig, { force: true });
  }

  // ============================================================
  // TEST 13: .gitattributes with filter execution when config overridden
  // ============================================================
  console.log("\n--- TEST 13: .gitattributes filter with -c filter.*.clean= ---");

  {
    const dir = mkdtempSync(join(tmp, "test_attrs_override_"));
    gitInit(dir);
    const marker = join(tmp, "attrs_override_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[filter "evil"]
    clean = echo "FILTER_BYPASS" > ${join(tmp, "attrs_override_marker.txt")}
    smudge = cat
`);

    writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
    writeFile(dir, "test.txt", "test content");

    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("git", [
      "-c", "filter.*.clean=",
      "add", "test.txt"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "attrs_override_marker.txt"));
    recordResult(
      "-c filter.*.clean= blocks .gitattributes filter.evil.clean",
      !executed,
      executed ? "VULNERABLE: Wildcard filter.*.clean= FAILED" : "BLOCKED: Wildcard filter.*.clean= works"
    );
    if (executed) rmSync(join(tmp, "attrs_override_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 14: GIT_CONFIG_SYSTEM=/dev/null or NUL
  // ============================================================
  console.log("\n--- TEST 14: GIT_CONFIG_SYSTEM=/dev/null ---");

  {
    const dir = mkdtempSync(join(tmp, "test_system_"));
    gitInit(dir);
    const marker = join(tmp, "system_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[core]
    sshCommand = echo "SYSTEM_BYPASS" > ${join(tmp, "system_marker.txt")}
[remote "origin"]
    url = ssh://git@github.com/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_NOGLOBAL: "1",
      },
    });

    const executed = existsSync(join(tmp, "system_marker.txt"));
    recordResult(
      "GIT_CONFIG_SYSTEM=NUL + NOSYSTEM/NOGLOBAL blocks .git/config",
      !executed,
      executed ? "VULNERABLE: SYSTEM=null doesn't block" : "BLOCKED: SYSTEM=null works"
    );
    if (executed) rmSync(join(tmp, "system_marker.txt"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // TEST 15: core.askPass
  // ============================================================
  console.log("\n--- TEST 15: core.askPass (missing from denylist) ---");

  {
    const dir = mkdtempSync(join(tmp, "test_askpass_"));
    gitInit(dir);
    const marker = join(tmp, "askpass_test.txt");
    if (existsSync(marker)) rmSync(marker);

    writeGitConfig(dir, `
[core]
    askPass = echo "ASKPASS_EXECUTED" > ${join(tmp, "askpass_marker.txt")}
[remote "origin"]
    url = ssh://git@github.com/test/test.git
`);

    const result = spawnSync("git", [
      "fetch", "origin"
    ], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });

    const executed = existsSync(join(tmp, "askpass_marker.txt"));
    recordResult(
      "core.askPass (NOT in denylist) executes",
      executed,
      executed ? "VULNERABILITY: core.askPass executes" : "UNEXPECTED"
    );
    if (executed) rmSync(join(tmp, "askpass_marker.txt"));
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
  console.log("KEY FINDINGS");
  console.log("=".repeat(80));
}

runTests().catch(console.error);