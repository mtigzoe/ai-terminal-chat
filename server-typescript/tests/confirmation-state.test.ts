import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { captureConfirmationFileStates, confirmationFileStatesMatch, confirmationPathsForPending } from "../src/confirmation-state.ts";
import { setProjectRoot } from "../src/security.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

describe("Git index confirmation state", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-index-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    setProjectRoot(root);
    fs.writeFileSync(path.join(root, "file.txt"), "one\n");
    execFileSync("git", ["add", "file.txt"], { cwd: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("binds git_add and staged restore confirmations to the index", () => {
    expect(confirmationPathsForPending("git_add", { path: "file.txt" })).toEqual([
      "file.txt",
      "__git_index__",
    ]);
    expect(confirmationPathsForPending("git_restore", { path: "file.txt", staged: true })).toEqual([
      "__git_head__",
      "__git_index__",
    ]);
    expect(confirmationPathsForPending("git_restore", { path: "file.txt", staged: false })).toEqual([
      "file.txt",
      "__git_index__",
    ]);
  });

  it("binds git_push confirmations to the current local HEAD", () => {
    expect(confirmationPathsForPending("git_push", {})).toEqual(["__git_head__", "__git_remote__:<default>"]);
    expect(confirmationPathsForPending("git_push", { branch: "other", remote: "origin" })).toEqual(["__git_push_head__:other", "__git_remote__:origin"]);
    const states = captureConfirmationFileStates(["__git_head__"]);
    expect(states[0]?.kind).toBe("git_head");
    expect(states[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    execFileSync("git", ["checkout", "-b", "other"], { cwd: root });
    expect(confirmationFileStatesMatch(states)).toBe(false);

    const branchStates = captureConfirmationFileStates(["__git_push_head__:other"]);
    expect(branchStates[0]?.kind).toBe("git_head");
    expect(confirmationFileStatesMatch(branchStates)).toBe(true);
    execFileSync("git", ["commit", "--allow-empty", "-m", "advance"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
    expect(confirmationFileStatesMatch(branchStates)).toBe(false);
  });

  it("binds fully qualified push refs to the actual ref state", () => {
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
    const currentBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    const actual = captureConfirmationFileStates([`__git_push_head__:refs/heads/${currentBranch}`]);
    expect(actual[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(actual)).toBe(true);

    execFileSync("git", ["commit", "--allow-empty", "-m", "advance"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    expect(confirmationFileStatesMatch(actual)).toBe(false);
  });

  it("tracks multiple remote URLs and push URLs", () => {
    execFileSync("git", ["remote", "add", "origin", "https://example.com/fetch.git"], { cwd: root });
    execFileSync("git", ["config", "--add", "remote.origin.pushurl", "https://example.com/push.git"], { cwd: root });
    const states = captureConfirmationFileStates(["__git_remote__:origin"]);
    expect(states[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    execFileSync("git", ["config", "--add", "remote.origin.url", "https://example.com/second.git"], { cwd: root });
    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("invalidates push confirmations when push refspec configuration changes", () => {
    execFileSync("git", ["remote", "add", "origin", "https://example.com/one.git"], { cwd: root });
    const states = captureConfirmationFileStates(["__git_remote__:origin"]);
    expect(states[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    execFileSync("git", ["config", "--add", "remote.origin.push", "HEAD:refs/heads/release"], { cwd: root });
    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("invalidates push confirmations when remote configuration changes", () => {
    execFileSync("git", ["remote", "add", "origin", "https://example.com/one.git"], { cwd: root });
    const states = captureConfirmationFileStates(["__git_remote__:origin"]);
    expect(states[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    execFileSync("git", ["remote", "set-url", "origin", "https://example.com/two.git"], { cwd: root });
    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("keeps dangling symlink deletion confirmations valid until the link changes", () => {
    const link = path.join(root, "dangling.txt");
    fs.symlinkSync("missing-target.txt", link);

    const states = captureConfirmationFileStates(["dangling.txt"]);
    expect(states[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    fs.unlinkSync(link);
    fs.symlinkSync("another-target.txt", link);

    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("invalidates missing-file confirmations when a parent symlink is retargeted", () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.symlinkSync("first", path.join(root, "dir"));

    const states = captureConfirmationFileStates(["dir/new.txt"]);
    expect(states[0]?.status).toBe("missing");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    fs.unlinkSync(path.join(root, "dir"));
    fs.symlinkSync("second", path.join(root, "dir"));

    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("decodes quoted git patch paths for confirmation binding", () => {
    const patch = "--- \"a/line\\011name.txt\"\n+++ \"b/line\\011name.txt\"\n@@ -1 +1 @@\n-one\n+two\n";
    expect(confirmationPathsForPending("apply_patch", { patch })).toEqual(["line\tname.txt"]);
  });

  it("binds apply_patch confirmations for unprefixed unified-diff paths", () => {
    const patch = "--- file.txt\n+++ file.txt\n@@ -1 +1 @@\n-one\n+two\n";
    expect(confirmationPathsForPending("apply_patch", { patch })).toEqual(["file.txt"]);

    const states = captureConfirmationFileStates(
      confirmationPathsForPending("apply_patch", { patch }),
    );
    expect(confirmationFileStatesMatch(states)).toBe(true);

    fs.writeFileSync(path.join(root, "file.txt"), "changed after preview\n");
    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("invalidates write confirmations when an in-project symlink target changes", () => {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    fs.writeFileSync(target, "before\\n");
    fs.symlinkSync("target.txt", link);

    const states = captureConfirmationFileStates(["link.txt"]);
    expect(states[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    fs.writeFileSync(target, "changed after preview\\n");
    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("binds normal git_restore confirmations to the worktree target and index source", () => {
    expect(confirmationPathsForPending("git_restore", { path: "file.txt", staged: false })).toEqual([
      "file.txt",
      "__git_index__",
    ]);
  });

  it("binds git_pull confirmations to HEAD and the index", () => {
    expect(confirmationPathsForPending("git_pull", {})).toEqual([
      "__git_head__",
      "__git_index__",
      "__git_remote__:<default>",
    ]);
    expect(confirmationPathsForPending("git_pull", { remote: "origin" })).toEqual([
      "__git_head__",
      "__git_index__",
      "__git_remote__:origin",
    ]);
  });

  it("binds git_commit pending actions to the index", () => {
    expect(confirmationPathsForPending("git_commit", { message: "commit" })).toEqual(["__git_index__"]);
    const states = captureConfirmationFileStates(["__git_index__"]);
    expect(states[0]?.kind).toBe("git_index");
    expect(states[0]?.status).toBe("present");

    fs.writeFileSync(path.join(root, "file.txt"), "two\n");
    execFileSync("git", ["add", "file.txt"], { cwd: root });

    expect(confirmationFileStatesMatch(states)).toBe(false);
  });
});

describe("git dir discovery walks up from a project root subdirectory", () => {
  // Regression coverage: PROJECT_ROOT can legitimately be a subdirectory of
  // the actual repository — real git commands already discover the repo by
  // walking up from cwd (see write-tools.ts's own comment about this exact
  // scenario) — but the confirmation fingerprints used to check only
  // PROJECT_ROOT/.git directly. That made every git_add/git_commit/
  // git_push/etc. confirmation silently and permanently fail as
  // "unavailable" for a project scoped to a subfolder of a larger repo.
  let repoRoot: string;
  let projectRoot: string;
  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-walkup-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    projectRoot = path.join(repoRoot, "subproject");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(path.join(projectRoot, "file.txt"), "one\n");
    execFileSync("git", ["add", "subproject/file.txt"], { cwd: repoRoot });
    setProjectRoot(projectRoot);
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  it("finds the git index by walking up from a subdirectory project root", () => {
    expect(confirmationPathsForPending("git_commit", { message: "commit" })).toEqual(["__git_index__"]);
    const states = captureConfirmationFileStates(["__git_index__"]);
    expect(states[0]?.kind).toBe("git_index");
    expect(states[0]?.status).toBe("present");
    expect(confirmationFileStatesMatch(states)).toBe(true);

    fs.writeFileSync(path.join(projectRoot, "file.txt"), "two\n");
    execFileSync("git", ["add", "subproject/file.txt"], { cwd: repoRoot });
    expect(confirmationFileStatesMatch(states)).toBe(false);
  });

  it("still reports unavailable when no repo exists anywhere up the tree", () => {
    const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-no-repo-"));
    try {
      setProjectRoot(orphanRoot);
      const states = captureConfirmationFileStates(["__git_index__"]);
      expect(states[0]?.status).toBe("unavailable");
      expect(confirmationFileStatesMatch(states)).toBe(false);
    } finally {
      fs.rmSync(orphanRoot, { recursive: true, force: true });
    }
  });

  it("stops at a malformed .git entry instead of walking further up to a real repo", () => {
    const outerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-malformed-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: outerRoot });
      const subRoot = path.join(outerRoot, "sub");
      fs.mkdirSync(subRoot);
      // Exists, but is neither a directory nor a valid "gitdir: ..."
      // worktree pointer file — git itself would refuse to treat this as
      // a repo rather than keep searching ancestors, and so should we.
      fs.writeFileSync(path.join(subRoot, ".git"), "not a valid worktree pointer\n");
      setProjectRoot(subRoot);
      const states = captureConfirmationFileStates(["__git_index__"]);
      expect(states[0]?.status).toBe("unavailable");
    } finally {
      fs.rmSync(outerRoot, { recursive: true, force: true });
    }
  });
});
