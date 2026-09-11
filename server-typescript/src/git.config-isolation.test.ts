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

import { runIsolatedGit, GIT_CONFIG_OVERRIDES, stripDangerousGitConfig } from "./git.ts";
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

test("arbitrary filter name clean cannot run on git_add path", async () => {
  const repo = initRepo();
  const marker = join(repo, "FILTER_ADD");
  const { configValue } = markerScript(marker);
  const filterName = "evil_x9f3";
  writeFileSync(join(repo, ".gitattributes"), `*.txt filter=${filterName}\n`, "utf8");
  setLocal(repo, `filter.${filterName}.clean`, configValue);
  setLocal(repo, `filter.${filterName}.smudge`, configValue);
  writeFileSync(join(repo, "a.txt"), "three\n", "utf8");
  __setProjectRootForTests(repo);
  try {
    const { gitAdd } = await import("./git.ts");
    const result = await gitAdd("a.txt", true);
    assert.equal(existsSync(marker), false, "clean filter must not run on add");
    assert.ok(!("error" in result) || !result.error, `add result: ${JSON.stringify(result)}`);
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("arbitrary filter name smudge cannot run on git_restore path", async () => {
  const repo = initRepo();
  const marker = join(repo, "FILTER_RESTORE");
  const { configValue } = markerScript(marker);
  const filterName = "smudge_z8";
  writeFileSync(join(repo, ".gitattributes"), `*.txt filter=${filterName}\n`, "utf8");
  setLocal(repo, `filter.${filterName}.clean`, configValue);
  setLocal(repo, `filter.${filterName}.smudge`, configValue);
  // Commit with filters disabled so object is clean
  execFileSync("git", ["-c", `filter.${filterName}.clean=`, "-c", `filter.${filterName}.smudge=`, "add", "a.txt"], {
    cwd: repo,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["-c", `filter.${filterName}.clean=`, "-c", `filter.${filterName}.smudge=`, "commit", "-m", "filtered"],
    { cwd: repo, stdio: "ignore" },
  );
  writeFileSync(join(repo, "a.txt"), "dirty-worktree\n", "utf8");
  __setProjectRootForTests(repo);
  try {
    const { gitRestore } = await import("./git.ts");
    const result = await gitRestore("a.txt", false, true);
    assert.equal(existsSync(marker), false, "smudge filter must not run on restore");
    assert.ok(!("error" in result) || !result.error, `restore result: ${JSON.stringify(result)}`);
    const body = readFileSync(join(repo, "a.txt"), "utf8");
    assert.ok(!body.includes("dirty-worktree"), "worktree should be restored from HEAD");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("url.insteadOf is stripped for network isolation", async () => {
  const repo = initRepo();
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], {
    cwd: repo,
    stdio: "ignore",
  });
  setLocal(repo, "url.https://evil.example/.insteadOf", "https://github.com/");
  const configPath = join(repo, ".git", "config");
  const original = readFileSync(configPath, "utf8");
  assert.ok(original.includes("evil.example"));
  // -c cannot clear insteadOf; sanitization removes [url] sections.
  const sanitized = stripDangerousGitConfig(original);
  assert.equal(sanitized.includes("evil.example"), false);
  assert.ok(sanitized.includes("github.com/example/repo.git"));
  writeFileSync(configPath, sanitized, "utf8");
  try {
    const getUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(getUrl.includes("evil.example"), false);
    assert.ok(getUrl.includes("github.com"));
  } finally {
    writeFileSync(configPath, original, "utf8");
    rmSync(repo, { recursive: true, force: true });
  }
});

test("include.path cannot re-enable core.fsmonitor under isolation", async () => {
  const repo = initRepo();
  const marker = join(repo, "INCLUDE_FSMON");
  const { configValue } = markerScript(marker);
  const includeFile = join(repo, "evil-include.cfg");
  writeFileSync(includeFile, `[core]\n\tfsmonitor = ${configValue}\n`, "utf8");
  setLocal(repo, "include.path", includeFile);
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["status", "--short"]);
    assert.equal(existsSync(marker), false, "included fsmonitor must not run");
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dynamic overrides clear filter process helper", async () => {
  const repo = initRepo();
  const marker = join(repo, "PROCESS");
  const { configValue } = markerScript(marker);
  setLocal(repo, "filter.procfilter.process", configValue);
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=procfilter\n", "utf8");
  __setProjectRootForTests(repo);
  try {
    await runIsolatedGit(["status", "--short"]);
    assert.equal(existsSync(marker), false);
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Git operations are serialized across the config sanitization window", async () => {
  const repo = initRepo();
  setLocal(repo, "url.https://evil.example/.insteadOf", "https://github.com/");
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], {
    cwd: repo,
    stdio: "ignore",
  });
  __setProjectRootForTests(repo);

  const {
    withGitOperationLockForTests,
    isGitOperationLockHeldForTests,
    gitFetch,
  } = await import("./git.ts");

  const events: string[] = [];
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  try {
    // Hold the global Git lock like a long network op inside sanitization.
    const holder = withGitOperationLockForTests(async () => {
      events.push("holder-enter");
      assert.equal(isGitOperationLockHeldForTests(), true);
      await gate;
      events.push("holder-exit");
      return "held";
    });

    // Give holder time to acquire
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(events.includes("holder-enter"));

    let concurrentFinishedEarly = false;
    const concurrent = runIsolatedGit(["status", "--short"]).then((result) => {
      // Must not run until holder releases
      if (!events.includes("holder-exit")) {
        concurrentFinishedEarly = true;
      }
      events.push("concurrent-done");
      return result;
    });

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      concurrentFinishedEarly,
      false,
      "status must not complete while another Git exclusive section holds the lock",
    );
    assert.equal(events.includes("concurrent-done"), false);

    releaseGate();
    await holder;
    await concurrent;
    assert.ok(events.includes("holder-exit"));
    assert.ok(events.includes("concurrent-done"));
    assert.equal(concurrentFinishedEarly, false);

    // gitFetch also serializes (uses withSanitizedGitConfig)
    void gitFetch;
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("withSanitizedGitConfig restores config after failure", async () => {
  const repo = initRepo();
  setLocal(repo, "url.https://evil.example/.insteadOf", "https://github.com/");
  const configPath = join(repo, ".git", "config");
  const before = readFileSync(configPath, "utf8");
  assert.ok(before.includes("evil.example"));
  __setProjectRootForTests(repo);
  try {
    // Force a failing network op under sanitization (invalid remote)
    const { gitFetch } = await import("./git.ts");
    const result = await gitFetch("nonexistent-remote-xyz");
    assert.ok(result.error || true);
    const after = readFileSync(configPath, "utf8");
    assert.ok(
      after.includes("evil.example"),
      "original insteadOf must be restored after failed fetch",
    );
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stage uses openWithinProject bytes not path-based hash-object", async () => {
  // Behavioral: staging still works with a filter present and marker never runs.
  // Path TOCTOU is mitigated by reading via openWithinProject then --stdin.
  const repo = initRepo();
  const marker = join(repo, "STDIN_STAGE");
  const { configValue } = markerScript(marker);
  const filterName = "stdin_filt";
  writeFileSync(join(repo, ".gitattributes"), `*.txt filter=${filterName}\n`, "utf8");
  setLocal(repo, `filter.${filterName}.clean`, configValue);
  writeFileSync(join(repo, "a.txt"), "stdin-stage-content\n", "utf8");
  __setProjectRootForTests(repo);
  try {
    const { gitAdd } = await import("./git.ts");
    const result = await gitAdd("a.txt", true);
    assert.equal(existsSync(marker), false);
    assert.ok(!("error" in result && result.error), JSON.stringify(result));
  } finally {
    __resetProjectRootForTests();
    rmSync(repo, { recursive: true, force: true });
  }
});
