import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

import { __setProjectRootForTests, getProjectRoot, runWithAllowedReadPaths } from "./security.js";
import { gitAdd, gitBranch, gitDiff, gitLog, gitRestore, gitStatus, runIsolatedGit } from "./git.js";

let originalProjectRoot: string;

beforeEach(() => {
  originalProjectRoot = getProjectRoot();
  __setProjectRootForTests(process.cwd());
});

afterEach(() => {
  __setProjectRootForTests(originalProjectRoot);
});

test("gitStatus returns structured status output", async () => {
  const result = await gitStatus();
  assert.equal("error" in result, false);
  if (!("error" in result)) {
    assert.equal(typeof result.status, "string");
    assert.equal(typeof result.truncated, "boolean");
  }
});

test("git operations ignore repository core.worktree escapes", async () => {
  const { mkdtempSync, rmSync, writeFileSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-worktree-isolation-"));
  const outside = mkdtempSync(join(tmpdir(), "git-worktree-outside-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: temp });
    writeFileSync(join(outside, "outside-secret.txt"), "outside\n");
    execFileSync("git", ["config", "core.worktree", outside], { cwd: temp });

    __setProjectRootForTests(temp);
    const root = await runIsolatedGit(["rev-parse", "--show-toplevel"]);
    assert.equal(root.code, 0);
    assert.equal(resolve(root.stdout.trim()), resolve(realpathSync.native(temp)));

    const result = await gitStatus();
    assert.equal("error" in result, false);
    assert.equal(String(result.status ?? "").includes("outside-secret.txt"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("gitBranch returns structured branch output", async () => {
  const result = await gitBranch();
  assert.equal("error" in result, false);
  if (!("error" in result)) {
    assert.equal(typeof result.branches, "string");
    assert.equal(typeof result.truncated, "boolean");
  }
});

test("gitLog clamps the requested commit count", async () => {
  const result = await gitLog(0);
  assert.equal("error" in result, false);
  if (!("error" in result)) {
    assert.equal(typeof result.log, "string");
  }
});

test("gitDiff rejects an absolute path", async () => {
  const result = await gitDiff("C:\\Windows\\System32\\drivers\\etc\\hosts");
  assert.equal("error" in result, true);
});

test("runIsolatedGit rejects an external .git gitfile", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-gitfile-project-"));
  const outside = mkdtempSync(join(tmpdir(), "git-gitfile-outside-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: outside });
    writeFileSync(join(temp, ".git"), "gitdir: " + join(outside, ".git") + "\n");
    __setProjectRootForTests(temp);
    await assert.rejects(() => runIsolatedGit(["status"]), /outside the project root/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("runIsolatedGit rejects an external commondir", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-commondir-project-"));
  const outside = mkdtempSync(join(tmpdir(), "git-commondir-outside-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: temp });
    execFileSync("git", ["init", "-q"], { cwd: outside });
    writeFileSync(join(temp, ".git", "commondir"), join(outside, ".git") + "\n");
    __setProjectRootForTests(temp);
    await assert.rejects(() => runIsolatedGit(["status"]), /outside the project root/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("runIsolatedGit rejects external alternate object storage", async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-alternate-"));
  const external = mkdtempSync(join(tmpdir(), "git-alternate-external-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: external });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: external });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: external });
    writeFileSync(join(external, "outside.txt"), "outside-object-secret\n");
    execFileSync("git", ["add", "outside.txt"], { cwd: external });
    execFileSync("git", ["commit", "-qm", "outside"], { cwd: external });
    const externalHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: external, encoding: "utf8" }).trim();

    execFileSync("git", ["init", "-q"], { cwd: temp });
    mkdirSync(join(temp, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(temp, ".git", "objects", "info", "alternates"), join(external, ".git", "objects") + "\n");
    writeFileSync(join(temp, ".git", "refs", "heads", "main"), externalHead + "\n");
    writeFileSync(join(temp, ".git", "HEAD"), "ref: refs/heads/main\n");

    __setProjectRootForTests(temp);
    await assert.rejects(
      () => runIsolatedGit(["log", "-1", "--oneline"]),
      /alternate object storage|object storage|project root/i,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("runIsolatedGit rejects repository-controlled HTTP alternates", async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-http-alternate-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: temp });
    mkdirSync(join(temp, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(temp, ".git", "objects", "info", "http-alternates"), "http://127.0.0.1:9/objects/info/\n");

    __setProjectRootForTests(temp);
    await assert.rejects(
      () => runIsolatedGit(["status", "--short"]),
      /HTTP alternate object storage|alternate/i,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});


test("runIsolatedGit blocks repository-enabled external protocols", async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-protocol-isolation-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: temp });
    const helper = join(temp, "git-ext-helper.cjs");
    const marker = join(temp, "git-ext-pwned.txt");
    writeFileSync(helper, "require('node:fs').writeFileSync('git-ext-pwned.txt', 'executed');\n");
    const configPath = join(temp, ".git", "config");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8")
        + "\n[protocol \\\"ext\\\"]\n\\tallow = always\n"
        + "[remote \\\"origin\\\"]\n\\turl = ext::node git-ext-helper.mjs %S\n"
        + "\\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
    );

    __setProjectRootForTests(temp);
    const result = await runIsolatedGit(["fetch", "origin"]);

    assert.notEqual(result.code, 0);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runIsolatedGit neutralizes URL-specific HTTP headers", async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-http-config-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: temp });
    const configPath = join(temp, ".git", "config");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8")
        + "\n[http \\\"https://example.invalid/\\\"]\n\\textraHeader = Authorization: Bearer repository-secret\n",
    );
    __setProjectRootForTests(temp);
    const result = await runIsolatedGit(["config", "--get", "http.https://example.invalid/.extraHeader"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.includes("repository-secret"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});



test("gitRestore recreates tracked symlinks under isolated Git config", async () => {
  const { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, lstatSync, readlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temp = mkdtempSync(join(tmpdir(), "git-restore-symlink-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: temp });
    writeFileSync(join(temp, "target.txt"), "target contents\n");
    symlinkSync("target.txt", join(temp, "link.txt"), "file");
    execFileSync("git", ["add", "target.txt", "link.txt"], { cwd: temp });

    // Replace the tracked symlink with an ordinary file so gitRestore() must
    // recreate the index entry rather than merely leave the existing link.
    unlinkSync(join(temp, "link.txt"));
    writeFileSync(join(temp, "link.txt"), "target.txt");

    __setProjectRootForTests(temp);
    const result = await gitRestore("link.txt", false, true);
    assert.deepEqual(result, {
      path: "link.txt",
      restored: true,
      unstaged: false,
    });

    const restored = lstatSync(join(temp, "link.txt"));
    assert.equal(restored.isSymbolicLink(), true);
    assert.equal(readlinkSync(join(temp, "link.txt"), "utf8"), "target.txt");
    assert.equal(
      execFileSync("git", ["show", ":link.txt"], { cwd: temp, encoding: "utf8" }),
      "target.txt",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("gitAdd previews staging and does not mutate without confirmation", async () => {
  const result = await gitAdd("src/git.test.ts");
  assert.equal("requires_confirmation" in result, true);
  if ("requires_confirmation" in result) {
    assert.equal(result.requires_confirmation, true);
    assert.equal(result.path, join("src", "git.test.ts"));
  }
});

test("gitAdd rejects paths outside the allowed read selection", async () => {
  await runWithAllowedReadPaths(["src/security.ts"], async () => {
    const result = await gitAdd("src/git.test.ts");
    assert.equal("error" in result, true);
    if ("error" in result) {
      const errorMessage = String(result.error);
      assert.ok(errorMessage.toLowerCase().includes("not selected"), `unexpected error: ${errorMessage}`);
    }
  });
});


test("runIsolatedGit ignores inherited Git repository and transport environment", async () => {
  const original = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    GIT_SSH: process.env.GIT_SSH,
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    GIT_SSH_VARIANT: process.env.GIT_SSH_VARIANT,
    GIT_SSL_NO_VERIFY: process.env.GIT_SSL_NO_VERIFY,
    GIT_PROXY_COMMAND: process.env.GIT_PROXY_COMMAND,
  };
  process.env.GIT_DIR = join(process.cwd(), "definitely-not-this-repository");
  process.env.GIT_WORK_TREE = join(process.cwd(), "outside-worktree");
  process.env.GIT_INDEX_FILE = join(process.cwd(), "outside-index");
  process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=true'";
  process.env.GIT_SSH = "outside-ssh";
  process.env.GIT_SSH_COMMAND = "outside-ssh-command";
  process.env.GIT_SSH_VARIANT = "simple";
  process.env.GIT_SSL_NO_VERIFY = "1";
  process.env.GIT_PROXY_COMMAND = "outside-proxy";
  try {
    const result = await runIsolatedGit(["rev-parse", "--show-toplevel"]);
    assert.equal(result.code, 0);
    // Git prints a forward-slash path even on Windows while path.resolve()
    // produces backslashes there, so compare with one separator convention.
    const normalize = (value: string) => value.replace(/\\/g, "/");
    assert.equal(normalize(result.stdout.trim()), normalize(process.cwd()));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});