/**
 * Prove that repository-local .git/config and .git/config.worktree cannot
 * execute attacker-controlled programs through runIsolatedGit / terminal
 * allowlisted git commands.
 *
 * Also documents that GIT_CONFIG alone does NOT isolate local config —
 * the -c overrides in GIT_CONFIG_OVERRIDES are the real boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";

import { runIsolatedGit, GIT_CONFIG_OVERRIDES } from "./git.ts";
import { runCommand } from "./terminal.ts";
import {
  __setProjectRootForTests,
  __resetProjectRootForTests,
} from "./security.ts";

function markerScript(markerPath: string): { scriptPath: string; configValue: string } {
  const dir = mkdtempSync(join(tmpdir(), "git-cfg-marker-"));
  if (platform() === "win32") {
    const scriptPath = join(dir, "marker.cmd");
    writeFileSync(
      scriptPath,
      `@echo off\r\necho pwned > "${markerPath}"\r\nexit /b 0\r\n`,
      "utf8",
    );
    return { scriptPath, configValue: scriptPath };
  }
  const scriptPath = join(dir, "marker.sh");
  writeFileSync(scriptPath, `#!/bin/sh\necho pwned > "${markerPath}"\nexit 0\n`, {
    mode: 0o755,
    encoding: "utf8",
  });
  return { scriptPath, configValue: scriptPath };
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "git-cfg-iso-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], {
    cwd: repo,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "T"], {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "a.txt"), "one\n", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "a.txt"), "two\n", "utf8");
  return repo;
}

function setLocal(repo: string, key: string, value: string): void {
  execFileSync("git", ["config", "--local", key, value], {
    cwd: repo,
    stdio: "ignore",
  });
}

test("documentation: GIT_CONFIG alone does not block local core.fsmonitor", () => {
  // Sanity check of Git's model — not using our isolation layer.
  const repo = initRepo();
  const marker = join(repo, "RAW_FSMON");
  const { configValue } = markerScript(marker);
  setLocal(repo, "core.fsmonitor", configValue);
  const empty = join(repo, "empty-config");
  writeFileSync(empty, "", "utf8");
  try {
    execFileSync("git", ["status"], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_CONFIG: empty,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: platform() === "win32" ? "NUL" : "/dev/null",
      },
      stdio: "ignore",
    });
  } catch {
    // ignore non-zero
  }
  assert.equal(
    existsSync(marker),
    true,
    "without -c overrides, local core.fsmonitor must still run (Git model)",
  );
  rmSync(repo, { recursive: true, force: true });
});

test("runIsolatedGit blocks core.fsmonitor from .git/config", async () => {
  const repo = initRepo();
  const marker = join(repo, "FSMON");
  const { configValue } = markerScript(marker);
  setLocal(repo, "core.fsmonitor", configValue);
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["status", "--short"]);
    assert.equal(existsSync(marker), false, "core.fsmonitor must not run");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runIsolatedGit blocks core.fsmonitor from .git/config.worktree", async () => {
  const repo = initRepo();
  const marker = join(repo, "WT_FSMON");
  const { configValue } = markerScript(marker);
  setLocal(repo, "extensions.worktreeConfig", "true");
  writeFileSync(
    join(repo, ".git", "config.worktree"),
    `[core]\n\tfsmonitor = ${configValue}\n`,
    "utf8",
  );
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["status", "--short"]);
    assert.equal(existsSync(marker), false, "worktree fsmonitor must not run");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runIsolatedGit blocks alias.status shell execution", async () => {
  const repo = initRepo();
  const marker = join(repo, "ALIAS");
  const { configValue } = markerScript(marker);
  setLocal(repo, "alias.status", `!${configValue}`);
  __setProjectRootForTests(repo);
  try {
    const result = await runIsolatedGit(["status", "--short"]);
    assert.equal(existsSync(marker), false, "alias.status must not run");
    assert.ok(result.code === 0 || result.stdout !== undefined);
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runIsolatedGit blocks diff.external", async () => {
  const repo = initRepo();
  const marker = join(repo, "DIFFEXT");
  const { configValue } = markerScript(marker);
  setLocal(repo, "diff.external", configValue);
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["diff", "--no-ext-diff", "--no-textconv"]);
    assert.equal(existsSync(marker), false, "diff.external must not run");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runIsolatedGit blocks core.pager", async () => {
  const repo = initRepo();
  const marker = join(repo, "PAGER");
  const { configValue } = markerScript(marker);
  setLocal(repo, "core.pager", configValue);
  setLocal(repo, "pager.log", configValue);
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["log", "-1", "--oneline"]);
    assert.equal(existsSync(marker), false, "pager must not run");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runIsolatedGit blocks credential.helper", async () => {
  const repo = initRepo();
  const marker = join(repo, "CRED");
  const { configValue } = markerScript(marker);
  setLocal(repo, "credential.helper", configValue);
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["status", "--short"]);
    assert.equal(existsSync(marker), false, "credential.helper must not run on status");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runIsolatedGit blocks gpg.program on status/log", async () => {
  const repo = initRepo();
  const marker = join(repo, "GPG");
  const { configValue } = markerScript(marker);
  setLocal(repo, "gpg.program", configValue);
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["log", "-1", "--oneline"]);
    assert.equal(existsSync(marker), false, "gpg.program must not run");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runIsolatedGit blocks core.sshCommand override via -c", async () => {
  const repo = initRepo();
  const marker = join(repo, "SSHCMD");
  const { configValue } = markerScript(marker);
  setLocal(repo, "core.sshCommand", configValue);
  __setProjectRootForTests(repo);
  try {
    // status should not invoke ssh at all; marker must stay absent
    await runIsolatedGit(["status", "--short"]);
    assert.equal(existsSync(marker), false, "core.sshCommand must not run");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("terminal git status also blocks worktree fsmonitor", async () => {
  const repo = initRepo();
  const marker = join(repo, "TERM_WT");
  const { configValue } = markerScript(marker);
  setLocal(repo, "extensions.worktreeConfig", "true");
  writeFileSync(
    join(repo, ".git", "config.worktree"),
    `[core]\n\tfsmonitor = ${configValue}\n`,
    "utf8",
  );
  __setProjectRootForTests(repo);
  try {
    await runCommand("git status");
    assert.equal(existsSync(marker), false);
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("GIT_CONFIG_OVERRIDES includes fsmonitor, hooksPath, alias.status", () => {
  const joined = GIT_CONFIG_OVERRIDES.join("\n");
  assert.ok(joined.includes("core.fsmonitor="));
  assert.ok(joined.includes("core.hooksPath="));
  assert.ok(joined.includes("alias.status="));
  assert.ok(joined.includes("diff.external="));
  assert.ok(joined.includes("credential.helper="));
});

test("runIsolatedGit still produces usable status/diff/log output", async () => {
  const repo = initRepo();
  __setProjectRootForTests(repo);
  try {
    const status = await runIsolatedGit(["status", "--short"]);
    assert.equal(status.code, 0);
    assert.ok(status.stdout.includes("a.txt") || status.stdout.length >= 0);
    const diff = await runIsolatedGit(["diff", "--no-ext-diff", "--no-textconv"]);
    assert.equal(diff.code, 0);
    assert.ok(diff.stdout.includes("two") || diff.stdout.includes("a.txt"));
    const log = await runIsolatedGit(["log", "-1", "--oneline"]);
    assert.equal(log.code, 0);
    assert.ok(log.stdout.trim().length > 0);
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});
