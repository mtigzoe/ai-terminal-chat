import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { gitAdd, gitCommit, gitDiff, gitStatus } from "../src/git.ts";
import { getProjectRoot, setProjectRoot } from "../src/security.ts";

function runGit(dir: string, args: string[]) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", stdio: "ignore" });
}

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "git-config-isolation-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  return dir;
}

function writeRepoConfig(dir: string, config: string) {
  writeFileSync(join(dir, ".git", "config"), config, "utf8");
}

describe("Git repository configuration isolation", () => {
  let originalRoot: string;
  let repoDir: string;

  beforeEach(() => {
    originalRoot = getProjectRoot();
    repoDir = createRepo();
    setProjectRoot(repoDir);
  });

  afterEach(() => {
    setProjectRoot(originalRoot);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("ignores repository core.bare configuration", async () => {
    writeRepoConfig(repoDir, `[core]\n\tbare = true\n`);

    const result = await gitStatus();

    expect(result.error).toBeUndefined();
    expect(String(result.status)).toContain("No commits yet");
  });

  it("does not execute a repository-controlled hook", async () => {
    const marker = join(repoDir, "hook-executed");
    const hooksDir = join(repoDir, "malicious-hooks");
    mkdirSync(hooksDir, { recursive: true });

    const hook = join(repoDir, process.platform === "win32" ? "malicious-hooks\\pre-commit.cmd" : "malicious-hooks/pre-commit");
    if (process.platform === "win32") {
      writeFileSync(hook, `@echo hook > "${marker}"\r\n`, "utf8");
    } else {
      writeFileSync(hook, `#!/bin/sh\necho hook > "${marker}"\n`, "utf8");
      chmodSync(hook, 0o755);
    }

    writeRepoConfig(
      repoDir,
      `[user]\n\tname = Test User\n\temail = test@example.com\n[core]\n\thooksPath = ${hooksDir}\n`,
    );
    writeFileSync(join(repoDir, "test.txt"), "test\n", "utf8");

    expect((await gitAdd("test.txt", true)).error).toBeUndefined();
    const result = await gitCommit("test commit", true);

    expect(result.error).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute a repository-controlled filter during git add", async () => {
    const marker = join(repoDir, "filter-executed");
    writeRepoConfig(repoDir, `[filter "evil"]\n\tclean = node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "\\\\")}', 'filter')"\n`);
    writeFileSync(join(repoDir, ".gitattributes"), "*.txt filter=evil\n", "utf8");
    writeFileSync(join(repoDir, "test.txt"), "test\n", "utf8");

    const result = await gitAdd("test.txt", true);

    expect(result.error).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute a repository-controlled diff driver", async () => {
    const marker = join(repoDir, "diff-executed");
    writeRepoConfig(repoDir, `[diff "evil"]\n\ttextconv = node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "\\\\")}', 'diff')"\n`);
    writeFileSync(join(repoDir, ".gitattributes"), "*.txt diff=evil\n", "utf8");
    writeFileSync(join(repoDir, "test.txt"), "test\n", "utf8");
    expect((await gitAdd("test.txt", true)).error).toBeUndefined();
    writeFileSync(join(repoDir, "test.txt"), "changed\n", "utf8");

    const result = await gitDiff("test.txt");

    expect(result.error).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });
});
