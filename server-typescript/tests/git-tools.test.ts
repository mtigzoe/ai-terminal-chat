import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { gitAdd, gitCommit, gitDiff, gitPull, gitRestore, runIsolatedGit } from "../src/git.ts";
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
    fs.writeFileSync(path.join(root, "allowed.txt"), "allowed\\n");
    fs.writeFileSync(path.join(root, "secret.txt"), "secret\\n");
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

  it("applies dynamic Git config overrides from a linked worktree common config", async () => {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    fs.writeFileSync(path.join(root, "seed.txt"), "seed\\n");
    execFileSync("git", ["add", "seed.txt"], { cwd: root });
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

    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-"));
    fs.rmSync(worktree, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "linked"], { cwd: root });

    try {
      execFileSync("git", ["config", "url.file:///outside/.insteadOf", "https://example.com/"], { cwd: root });
      execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd: root });

      setProjectRoot(worktree);
      const result = await runIsolatedGit(["remote", "get-url", "origin"]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("https://example.com/repo.git");
    } finally {
      setProjectRoot(root);
      try { execFileSync("git", ["worktree", "remove", "-f", worktree], { cwd: root }); } catch {}
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("preserves scalar Git config overrides when sanitizing multivalue overrides", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "url.file:///outside/.insteadOf", "https://example.com/"], { cwd: root });
    execFileSync("git", ["config", "merge.test.driver", "unsafe-command"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd: root });

    const remote = await runIsolatedGit(["remote", "get-url", "origin"]);
    expect(remote.code).toBe(0);
    expect(remote.stdout.trim()).toBe("https://example.com/repo.git");

    const driver = await runIsolatedGit(["config", "--get", "merge.test.driver"]);
    expect(driver.code).not.toBe(0);
    expect(driver.stdout.trim()).toBe("");
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
    expect(fs.readFileSync(path.join(root, "allowed.txt"), "utf8")).toBe("allowed\\n");
  });

  it("rejects a pull branch when no remote is supplied", async () => {
    const result = await gitPull("", "main", true);

    expect(result).toEqual({
      error: "A remote is required when specifying a branch.",
    });
  });

  it("stages a symlink as a symlink instead of its target contents", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "target.txt"), "target\\n");
    fs.symlinkSync("target.txt", path.join(root, "link.txt"));

    const result = await runWithAllowedReadPaths(["link.txt"], () =>
      gitAdd("link.txt", true),
    );

    expect(result).toEqual({ path: "link.txt", staged: true });
    const mode = execFileSync("git", ["ls-files", "--stage", "--", "link.txt"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(mode).toMatch(/^120000 /);
    expect(execFileSync("git", ["show", ":link.txt"], {
      cwd: root,
      encoding: "utf8",
    })).toBe("target.txt");
  });

  it("stages a dangling symlink as a symlink", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.symlinkSync("missing-target.txt", path.join(root, "dangling.txt"));

    const result = await runWithAllowedReadPaths(["dangling.txt"], () =>
      gitAdd("dangling.txt", true),
    );

    expect(result).toEqual({ path: "dangling.txt", staged: true });
    expect(execFileSync("git", ["ls-files", "--stage", "--", "dangling.txt"], {
      cwd: root,
      encoding: "utf8",
    })).toMatch(/^120000 /);
    expect(execFileSync("git", ["show", ":dangling.txt"], {
      cwd: root,
      encoding: "utf8",
    })).toBe("missing-target.txt");
  });

  it("diffs the requested symlink instead of its target", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "target.txt"), "target\\n");
    fs.symlinkSync("target.txt", path.join(root, "link.txt"));
    execFileSync("git", ["add", "target.txt", "link.txt"], { cwd: root });
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
    fs.writeFileSync(path.join(root, "target.txt"), "changed\\n");

    const result = await runWithAllowedReadPaths(["link.txt"], () =>
      gitDiff("link.txt", false),
    );

    expect(result).toMatchObject({ diff: "", truncated: false });
  });

  it("restores the requested symlink instead of its target", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "target.txt"), "target\\n");
    fs.symlinkSync("target.txt", path.join(root, "link.txt"));
    execFileSync("git", ["add", "target.txt", "link.txt"], { cwd: root });
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
    fs.rmSync(path.join(root, "link.txt"));
    fs.writeFileSync(path.join(root, "link.txt"), "changed\\n");

    const result = await runWithAllowedReadPaths(["link.txt"], () =>
      gitRestore("link.txt", false, true),
    );

    expect(result).toEqual({ path: "link.txt", restored: true, unstaged: false });
    expect(fs.lstatSync(path.join(root, "link.txt")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(root, "link.txt"), "utf8")).toBe("target.txt");
  });

  it("refuses a commit containing staged paths outside the agent selection", async () => {
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

  it("refuses a commit that renames a sensitive file into an innocuous, in-scope name", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=super-secret\\n");
    execFileSync("git", ["add", ".env"], { cwd: root });
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

    // Staged by a plain `git mv` - an exact-content rename, which Git
    // detects by default. Both the old (sensitive) and new (innocuous)
    // names are within the agent's selected scope, isolating the check to
    // sensitivity rather than scope.
    execFileSync("git", ["mv", ".env", "notes.txt"], { cwd: root });

    const result = await runWithAllowedReadPaths([".env", "notes.txt"], () =>
      gitCommit("test commit", false),
    );

    expect(result).toEqual({
      error: "Refusing to commit sensitive file: .env",
    });

    // The rename must still be sitting in the index, unmerged into history.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
    expect(log.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("refuses a commit that renames a file from outside the agent selection into an in-scope name", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "unselected.txt"), "not authorized for the agent to read\\n");
    execFileSync("git", ["add", "unselected.txt"], { cwd: root });
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

    // Rename a file the agent was never granted read access to into a name
    // that *is* in scope. Neither name looks sensitive, isolating the check
    // to scope enforcement rather than sensitivity.
    execFileSync("git", ["mv", "unselected.txt", "renamed-in-scope.txt"], { cwd: root });

    const result = await runWithAllowedReadPaths(["renamed-in-scope.txt"], () =>
      gitCommit("test commit", false),
    );

    expect(result).toEqual({
      error:
        "Refusing to commit staged file outside the agent selected paths: unselected.txt",
    });
  });
});
