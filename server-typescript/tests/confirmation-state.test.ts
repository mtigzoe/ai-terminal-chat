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
