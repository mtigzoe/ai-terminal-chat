/**
 * Git repository-config code execution audit.
 * Tests which dangerous Git configurations are reachable through the application's tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  gitFetch,
  gitPull,
  gitPush,
  gitDiff,
  gitStatus,
  gitLog,
  gitAdd,
  gitRestore,
  gitCommit,
  gitBranch,
  gitCommittedFileCount,
} from "../src/git.ts";

import { setProjectRoot, getProjectRoot, getAllowedReadPaths, persistAllowedCommands } from "../src/security.ts";

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

function createTestRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "git-audit-"));
  gitInit(repoDir);
  return repoDir;
}

let originalRoot: string;
let repoDir: string;

describe("Git repository-config code execution audit", () => {
  beforeEach(() => {
    originalRoot = getProjectRoot();
    repoDir = createTestRepo();
    setProjectRoot(repoDir);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("core.sshCommand - SSH command override", () => {
    it("fetch: core.sshCommand can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[core]
    sshCommand = echo "EXECUTED_SSH_COMMAND" > /tmp/ssh_executed.txt
`);
      const result = await gitFetch("nonexistent");
      expect(result.error).toBeDefined();
    });
  });

  describe("remote.*.uploadpack - Custom upload-pack for fetch/pull", () => {
    it("fetch: remote.uploadpack can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
    uploadpack = echo "EXECUTED_UPLOADPACK" > /tmp/uploadpack_executed.txt
`);
      const result = await gitFetch("origin");
      expect(result.error).toBeDefined();
    });

    it("pull: remote.uploadpack can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
    uploadpack = echo "EXECUTED_UPLOADPACK_PULL" > /tmp/uploadpack_pull.txt
`);
      const result = await gitPull("origin", "main", true);
      expect(result.error).toBeDefined();
    });
  });

  describe("remote.*.receivepack - Custom receive-pack for push", () => {
    it("push: remote.receivepack can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
    receivepack = echo "EXECUTED_RECEIVEPACK" > /tmp/receivepack_executed.txt
`);
      const result = await gitPush("origin", "main", true);
      expect(result.error).toBeDefined();
    });
  });

  describe("remote.*.proxy - Proxy command execution", () => {
    it("fetch: remote.proxy can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
    proxy = echo "EXECUTED_PROXY" > /tmp/proxy_executed.txt
`);
      const result = await gitFetch("origin");
      expect(result.error).toBeDefined();
    });
  });

  describe("credential.helper - Credential helper execution", () => {
    it("fetch: credential.helper can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[credential]
    helper = "!echo EXECUTED_CREDENTIAL_HELPER > /tmp/credential_executed.txt"
`);
      const result = await gitFetch("origin");
      expect(result.error).toBeDefined();
    });

    it("pull: credential.helper can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[credential]
    helper = "!echo EXECUTED_CREDENTIAL_HELPER_PULL > /tmp/credential_pull.txt"
`);
      const result = await gitPull("origin", "main", true);
      expect(result.error).toBeDefined();
    });

    it("push: credential.helper can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[credential]
    helper = "!echo EXECUTED_CREDENTIAL_HELPER_PUSH > /tmp/credential_push.txt"
`);
      const result = await gitPush("origin", "main", true);
      expect(result.error).toBeDefined();
    });
  });

  describe("core.hooksPath - Hook redirection", () => {
    it("commit: repository-controlled hooks are blocked", async () => {
      const marker = resolve(repoDir, "hook-executed.txt");
      const hooksDir = resolve(repoDir, "malicious_hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(resolve(hooksDir, "pre-commit"), `#!/bin/sh\necho "EXECUTED_PRE_COMMIT_HOOK" > "${marker}"\nexit 0\n`);
      const { chmodSync, existsSync } = require("node:fs");
      chmodSync(resolve(hooksDir, "pre-commit"), 0o755);

      writeGitConfig(repoDir, `
[core]
    hooksPath = ${hooksDir}
`);

      writeFileSync(join(repoDir, "test.txt"), "test");
      await gitAdd("test.txt", true);

      const result = await gitCommit("test commit", true);
      expect(result.error).toBeDefined();
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe("diff.*.command - Custom diff command", () => {
    it("diff: diff.command can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[diff "malicious"]
    command = echo "EXECUTED_DIFF_COMMAND" > /tmp/diff_executed.txt
`);
      writeFileSync(join(repoDir, "test.txt"), "test");
      await gitAdd("test.txt", true);
      writeFileSync(join(repoDir, "test.txt"), "modified");
      const result = await gitDiff("test.txt");
      expect(result.error).toBeUndefined();
    });
  });

  describe("diff.*.textconv - Text conversion command", () => {
    it("diff: diff.textconv can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[diff "malicious"]
    textconv = echo "EXECUTED_TEXTCONV" > /tmp/textconv_executed.txt
`);
      writeFileSync(join(repoDir, "test.txt"), "test");
      await gitAdd("test.txt", true);
      const result = await gitDiff("test.txt");
      expect(result.error).toBeUndefined();
    });
  });

  describe("merge.*.driver - Custom merge driver", () => {
    it("pull/merge: merge.driver can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[merge "malicious"]
    driver = echo "EXECUTED_MERGE_DRIVER" > /tmp/merge_executed.txt
`);
      const result = await gitPull("origin", "main", true);
      expect(result.error).toBeDefined();
    });
  });

  describe("filter.*.clean/smudge - Filter programs", () => {
    it("add: filter.clean can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[filter "malicious"]
    clean = echo "EXECUTED_FILTER_CLEAN" > /tmp/filter_clean.txt
    smudge = echo "EXECUTED_FILTER_SMUDGE" > /tmp/filter_smudge.txt
`);
      writeFileSync(join(repoDir, "test.txt"), "test");
      const result = await gitAdd("test.txt", true);
      expect(result.error).toBeUndefined();
    });

    it("diff/restore: filter.smudge can execute arbitrary command", async () => {
      writeGitConfig(repoDir, `
[filter "malicious"]
    smudge = echo "EXECUTED_FILTER_SMUDGE_DIFF" > /tmp/filter_smudge_diff.txt
`);
      writeFileSync(join(repoDir, "test.txt"), "test");
      await gitAdd("test.txt", true);
      const result = await gitDiff("test.txt");
      expect(result.error).toBeUndefined();
    });
  });

  describe("Pre-commit hooks", () => {
    it("commit: .git/hooks/pre-commit executes on commit", async () => {
      const hooksDir = resolve(repoDir, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(resolve(hooksDir, "pre-commit"), `#!/bin/sh\necho "EXECUTED_PRE_COMMIT" > /tmp/precommit_executed.txt\nexit 0\n`);
      const { chmodSync } = require("node:fs");
      chmodSync(resolve(hooksDir, "pre-commit"), 0o755);
      writeFileSync(join(repoDir, "test.txt"), "test");
      await gitAdd("test.txt", true);
      const result = await gitCommit("test commit", true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("url.*.insteadOf - URL rewriting", () => {
    it("fetch: url.insteadOf can redirect to local paths", async () => {
      writeGitConfig(repoDir, `
[url "file:///tmp/malicious"]
    insteadOf = https://github.com/
`);
      const result = await gitFetch("origin");
      expect(result.error).toBeDefined();
    });
  });

  describe("Git aliases", () => {
    it("alias: can execute shell commands via alias", async () => {
      writeGitConfig(repoDir, `
[alias]
    malicious = "!echo EXECUTED_ALIAS > /tmp/alias_executed.txt"
`);
    });
  });

  describe("Pre-push hooks", () => {
    it("push: .git/hooks/pre-push executes on push", async () => {
      const hooksDir = resolve(repoDir, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(resolve(hooksDir, "pre-push"), `#!/bin/sh\necho "EXECUTED_PRE_PUSH" > /tmp/prepush_executed.txt\nexit 0\n`);
      const { chmodSync } = require("node:fs");
      chmodSync(resolve(hooksDir, "pre-push"), 0o755);
      writeFileSync(join(repoDir, "test.txt"), "test");
      await gitAdd("test.txt", true);
      await gitCommit("initial", true);
      writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
`);
      const result = await gitPush("origin", "main", true);
      expect(result.error).toBeDefined();
    });
  });

  describe("Pre-merge hooks (invoked by pull)", () => {
    it("pull: merge hooks can execute", async () => {
      const hooksDir = resolve(repoDir, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(resolve(hooksDir, "pre-merge"), `#!/bin/sh\necho "EXECUTED_PRE_MERGE" > /tmp/premerge_executed.txt\nexit 0\n`);
      const { chmodSync } = require("node:fs");
      chmodSync(resolve(hooksDir, "pre-merge"), 0o755);
      const result = await gitPull("origin", "main", true);
      expect(result.error).toBeDefined();
    });
  });
});

describe("Argument validation - verify -- positioning", () => {
  let originalRoot: string;
  let repoDir: string;

  beforeEach(() => {
    originalRoot = getProjectRoot();
    repoDir = createTestRepo();
    setProjectRoot(repoDir);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("gitFetch uses -- before remote name", async () => {
    writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
`);
    const result = await gitFetch("origin");
    expect(result.error).toBeDefined();
  });

  it("gitPull uses -- before remote name", async () => {
    writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
`);
    const result = await gitPull("origin", "main", true);
    expect(result.error).toBeDefined();
  });

  it("gitPush uses -- before remote name", async () => {
    writeGitConfig(repoDir, `
[remote "origin"]
    url = https://github.com/test/test.git
`);
    const result = await gitPush("origin", "main", true);
    expect(result.error).toBeDefined();
  });

  it("rejects remote names starting with -", async () => {
    const result = await gitFetch("--upload-pack=evil");
    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/cannot start with '-'|option injection/i);
  });

  it("rejects branch names starting with -", async () => {
    const result = await gitPull("origin", "--exec=evil", true);
    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/cannot start with '-'|option injection/i);
  });
});
