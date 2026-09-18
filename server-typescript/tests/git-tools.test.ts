import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { gitCommit, gitPull, gitRestore } from "../src/git.ts";
import { runWithAllowedReadPaths, setProjectRoot } from "../src/security.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

function makeRepoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-tools-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

describe("git tool security", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepoDir();
    setProjectRoot(root);
    fs.writeFileSync(path.join(root, "allowed.txt"), "allowed\n");
    fs.writeFileSync(path.join(root, "secret.txt"), "secret\n");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("denies a worktree restore for a path not selected by the agent", async () => {
    const result = await runWithAllowedReadPaths(["allowed.txt"], () =>
      gitRestore("secret.txt", false, false),
    );
    expect(result).toEqual({
      error: "Access denied: 'secret.txt' is not selected for the agent.",
    });
  });

  it("denies an index restore for a path not selected by the agent", async () => {
    const result = await runWithAllowedReadPaths(["allowed.txt"], () =>
      gitRestore("secret.txt", true, false),
    );
    expect(result).toEqual({
      error: "Access denied: 'secret.txt' is not selected for the agent.",
    });
  });

  it("restores a deleted tracked file from HEAD", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "allowed.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    fs.rmSync(path.join(root, "allowed.txt"));

    const result = await runWithAllowedReadPaths(["allowed.txt"], () =>
      gitRestore("allowed.txt", false, true),
    );

    expect(result).toEqual({ path: "allowed.txt", restored: true, unstaged: false });
    expect(fs.readFileSync(path.join(root, "allowed.txt"), "utf8")).toBe("allowed\n");
  });

  it("rejects a pull branch when no remote is supplied", async () => {\n    const result = await gitPull("", "main", true);\n\n    expect(result).toEqual({\n      error: "A remote is required when specifying a branch.",\n    });\n  });\n\n  it("refuses a commit containing staged paths outside the agent selection", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "allowed.txt", "secret.txt"], { cwd: root });

    const result = await runWithAllowedReadPaths(["allowed.txt"], () =>
      gitCommit("test commit", false),
    );

    expect(result).toEqual({
      error:
        "Refusing to commit staged file outside the agent selected paths: secret.txt",
    });
  });
});
