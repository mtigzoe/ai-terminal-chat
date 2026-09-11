/**
 * Prove that allowlisted terminal `git …` commands use the same isolation
 * boundary as git.ts and never execute repository-controlled helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:os";

import { runCommand, reloadAllowedCommands, persistAllowedCommands, DEFAULT_ALLOWED_COMMAND_PREFIXES } from "./terminal.ts";
import {
  __setProjectRootForTests,
  __resetProjectRootForTests,
} from "./security.ts";
import { getGitSshCommand } from "./git.ts";

function markerScript(markerPath: string): { scriptPath: string; configValue: string } {
  const dir = mkdtempSync(join(tmpdir(), "git-marker-script-"));
  if (platform() === "win32") {
    const scriptPath = join(dir, "marker.cmd");
    // cmd script: write marker then exit 0
    writeFileSync(
      scriptPath,
      `@echo off\r\necho pwned > "${markerPath}"\r\nexit /b 0\r\n`,
      "utf8",
    );
    return { scriptPath, configValue: scriptPath };
  }
  const scriptPath = join(dir, "marker.sh");
  writeFileSync(scriptPath, `#!/bin/sh\necho pwned > "${markerPath}"\n`, {
    encoding: "utf8",
    mode: 0o755,
  });
  return { scriptPath, configValue: scriptPath };
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "terminal-git-isolation-"));
  execSync("git init", { cwd: repo, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: repo, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  execSync("git add README.md", { cwd: repo, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });
  return repo;
}

function setLocalConfig(repo: string, key: string, value: string): void {
  execFileSync("git", ["config", "--local", key, value], {
    cwd: repo,
    stdio: "ignore",
  });
}

test.afterEach(() => {
  persistAllowedCommands([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  reloadAllowedCommands();
  __resetProjectRootForTests();
});

test("terminal git status ignores malicious core.fsmonitor", async () => {
  const repo = initRepo();
  const marker = join(repo, "FS MONITOR_PWNED");
  const { configValue } = markerScript(marker);
  setLocalConfig(repo, "core.fsmonitor", configValue);
  __setProjectRootForTests(repo);

  const result = await runCommand("git status");
  assert.ok(result);
  if ("error" in result && result.error) {
    assert.equal(result.error.includes("not allowed"), false);
  }
  assert.equal(existsSync(marker), false, "core.fsmonitor must not run via terminal git status");

  rmSync(repo, { recursive: true, force: true });
});

test("terminal git diff ignores malicious diff.external", async () => {
  const repo = initRepo();
  const marker = join(repo, "DIFF_EXTERNAL_PWNED");
  const { configValue } = markerScript(marker);
  setLocalConfig(repo, "diff.external", configValue);
  // Ensure there is something to diff
  writeFileSync(join(repo, "README.md"), "changed\n", "utf8");
  __setProjectRootForTests(repo);

  const result = await runCommand("git diff");
  assert.equal(existsSync(marker), false, "diff.external must not run via terminal git diff");
  // Command should still complete (may show diff text)
  assert.ok(result);
  if ("error" in result && result.error) {
    // Isolation may cause empty external to just show built-in diff
    assert.doesNotMatch(result.error, /not allowed/i);
  }

  rmSync(repo, { recursive: true, force: true });
});

test("terminal git log ignores malicious pager configuration", async () => {
  const repo = initRepo();
  const marker = join(repo, "PAGER_PWNED");
  const { configValue } = markerScript(marker);
  setLocalConfig(repo, "core.pager", configValue);
  setLocalConfig(repo, "pager.log", configValue);
  __setProjectRootForTests(repo);

  const result = await runCommand("git log");
  assert.equal(existsSync(marker), false, "pager must not run via terminal git log");
  assert.ok(result);

  rmSync(repo, { recursive: true, force: true });
});

test("terminal git show ignores malicious configuration", async () => {
  const repo = initRepo();
  const marker = join(repo, "SHOW_PWNED");
  const { configValue } = markerScript(marker);
  setLocalConfig(repo, "core.pager", configValue);
  setLocalConfig(repo, "pager.show", configValue);
  setLocalConfig(repo, "diff.external", configValue);
  __setProjectRootForTests(repo);

  const result = await runCommand("git show --no-patch --format=oneline HEAD");
  assert.equal(existsSync(marker), false, "malicious config must not run via terminal git show");
  assert.ok(result);

  rmSync(repo, { recursive: true, force: true });
});

test("terminal git remote -v ignores malicious configuration", async () => {
  const repo = initRepo();
  const marker = join(repo, "REMOTE_PWNED");
  const { configValue } = markerScript(marker);
  setLocalConfig(repo, "core.fsmonitor", configValue);
  setLocalConfig(repo, "credential.helper", configValue);
  setLocalConfig(repo, "core.pager", configValue);
  __setProjectRootForTests(repo);

  const result = await runCommand("git remote -v");
  assert.equal(existsSync(marker), false, "malicious config must not run via terminal git remote -v");
  assert.ok(result);

  rmSync(repo, { recursive: true, force: true });
});

test("shared SSH isolation is platform-correct", () => {
  const command = getGitSshCommand();
  const expectedConfig = platform() === "win32" ? "NUL" : "/dev/null";
  assert.equal(
    command,
    `ssh -F ${expectedConfig} -o ProxyCommand=none -o ProxyJump=none`,
  );
});

test("git diff works when GIT_EXTERNAL_DIFF is set in the parent environment", async () => {
  // Regression: setting GIT_EXTERNAL_DIFF="" in the child env made Git try to
  // execute an empty external-diff command. Isolation must *delete* the var
  // and rely on --no-ext-diff / -c diff.external=.
  const project = mkdtempSync(join(tmpdir(), "git-ext-diff-env-"));
  const marker = join(project, "EXT_DIFF_RAN");
  const { scriptPath } = markerScript(marker);

  execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], {
    cwd: project,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "T"], {
    cwd: project,
    stdio: "ignore",
  });
  writeFileSync(join(project, "a.txt"), "one\n", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: project, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: project, stdio: "ignore" });
  writeFileSync(join(project, "a.txt"), "two\n", "utf8");

  const previous = process.env.GIT_EXTERNAL_DIFF;
  const previousTrust = process.env.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE;
  try {
    process.env.GIT_EXTERNAL_DIFF = scriptPath;
    process.env.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE = "1";
    __setProjectRootForTests(project);

    const result = await runCommand("git diff");
    assert.equal(existsSync(marker), false, "external diff script must not run");
    if ("error" in result && result.error) {
      assert.equal(
        String(result.error).includes("cannot run"),
        false,
        `must not fail with empty external-diff command: ${result.error}`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF;
    else process.env.GIT_EXTERNAL_DIFF = previous;
    if (previousTrust === undefined) {
      delete process.env.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE;
    } else {
      process.env.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE = previousTrust;
    }
    __resetProjectRootForTests();
    rmSync(project, { recursive: true, force: true });
  }
});
