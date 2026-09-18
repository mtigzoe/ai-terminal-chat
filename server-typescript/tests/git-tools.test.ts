import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { gitCommit, gitRestore } from "../src/git.ts";
import { runWithAllowedReadPaths, setProjectRoot } from "../src/security.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";\nimport { execFileSync } from "node:child_process";

function makeRepoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-tools-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

describe("git_restore read permissions", () => {
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
      error:
        "Access denied: 'secret.txt' is not selected for the agent.",
    });
  });

  it("refuses a commit containing staged paths outside the agent selection", async () => {\n    execFileSync("git", ["init", "-q"], { cwd: root });\n    fs.writeFileSync(path.join(root, "allowed.txt"), "allowed\n");\n    fs.writeFileSync(path.join(root, "secret.txt"), "secret\n");\n    execFileSync("git", ["add", "allowed.txt", "secret.txt"], { cwd: root });\n\n    const result = await runWithAllowedReadPaths(["allowed.txt"], () =>\n      gitCommit("test commit", false),\n    );\n\n    expect(result).toEqual({\n      error: "Refusing to commit staged file outside the agent selected paths: secret.txt",\n    });\n  });\n\n  it("denies an index restore for a path not selected by the agent", async () => {
    const result = await runWithAllowedReadPaths(["allowed.txt"], () =>
      gitRestore("secret.txt", true, false),
    );

    expect(result).toEqual({
      error:
        "Access denied: 'secret.txt' is not selected for the agent.",
    });
  });
});
