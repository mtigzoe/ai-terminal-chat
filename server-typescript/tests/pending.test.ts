import { describe, it, expect, beforeEach } from "vitest";
import { clear, createPending, getPending, popPending, restorePending } from "../src/pending.ts";

describe("pending", () => {
  beforeEach(() => {
    clear();
  });

  it("round-trips a pending action", () => {
    const action = createPending("tool-roundtrip", { path: "__pending_roundtrip__.txt" }, { requires_confirmation: true, diff: "+change" });

    const stored = getPending(action.action_id);
    expect(stored).not.toBeNull();
    expect(stored!.tool_name).toBe("tool-roundtrip");
    expect(stored!.args).toEqual({ path: "__pending_roundtrip__.txt" });
    expect(stored!.preview.requires_confirmation).toBe(true);

    const consumed = popPending(action.action_id);
    expect(consumed!.action_id).toBe(action.action_id);
    expect(getPending(action.action_id)).toBeUndefined();
    expect(popPending(action.action_id)).toBeUndefined();
  });

  it("restores a consumed action for a cancellation that happened before execution", () => {
    const action = createPending(
      "tool-restore",
      { path: "__pending_restore__.txt" },
      { requires_confirmation: true },
    );

    expect(popPending(action.action_id)?.action_id).toBe(action.action_id);
    expect(getPending(action.action_id)).toBeUndefined();

    expect(restorePending(action)).toBe(true);
    expect(getPending(action.action_id)?.action_id).toBe(action.action_id);

    expect(restorePending(action)).toBe(false);
  });

  it("getPending returns undefined for unknown id", () => {
    expect(getPending("missing")).toBeUndefined();
  });

  it("popPending returns undefined for unknown id", () => {
    expect(popPending("missing")).toBeUndefined();
  });

  it("clear removes all pending actions", () => {
    createPending("tool-a", { x: 1 }, {});
    createPending("tool-b", { y: 2 }, {});
    clear();
    expect(getPending("tool-a")).toBeUndefined();
    expect(getPending("tool-b")).toBeUndefined();
  });

  it("invalidates git push confirmation when common worktree remote config changes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const { getProjectRoot, setProjectRoot } = await import("../src/security.ts");

    const originalRoot = getProjectRoot();
    const repoRoot = path.join(os.tmpdir(), `pending-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const worktreeRoot = `${repoRoot}-linked`;
    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, "file.txt"), "initial\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoRoot });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial"], { cwd: repoRoot });
      execFileSync("git", ["remote", "add", "origin", "https://example.com/one.git"], { cwd: repoRoot });
      execFileSync("git", ["worktree", "add", "-q", worktreeRoot], { cwd: repoRoot });

      setProjectRoot(worktreeRoot);
      const action = createPending(
        "git_push",
        { remote: "origin", branch: "main" },
        { requires_confirmation: true },
      );

      execFileSync("git", ["remote", "set-url", "origin", "https://example.com/two.git"], { cwd: repoRoot });

      expect(popPending(action.action_id)).toBeUndefined();
    } finally {
      setProjectRoot(originalRoot);
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: repoRoot });
      } catch {
        // best effort
      }
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("invalidates git push confirmation when a legacy remote file changes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const { getProjectRoot, setProjectRoot } = await import("../src/security.ts");

    const originalRoot = getProjectRoot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-legacy-remote-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      fs.writeFileSync(path.join(root, "file.txt"), "one\n");
      execFileSync("git", ["add", "file.txt"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "one"], { cwd: root });

      const remotesDir = path.join(root, ".git", "remotes");
      fs.mkdirSync(remotesDir, { recursive: true });
      const remoteFile = path.join(remotesDir, "origin");
      fs.writeFileSync(remoteFile, "URL: https://example.com/one.git\nPush: refs/heads/main:refs/heads/main\n");

      setProjectRoot(root);
      const action = createPending(
        "git_push",
        { remote: "origin", branch: "main" },
        { requires_confirmation: true },
      );

      fs.writeFileSync(remoteFile, "URL: https://example.com/two.git\nPush: refs/heads/main:refs/heads/main\n");

      expect(popPending(action.action_id)).toBeUndefined();
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates git push HEAD confirmation when HEAD advances", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const { getProjectRoot, setProjectRoot } = await import("../src/security.ts");

    const originalRoot = getProjectRoot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-push-head-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      fs.writeFileSync(path.join(root, "file.txt"), "one\n");
      execFileSync("git", ["add", "file.txt"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "one"], { cwd: root });

      setProjectRoot(root);
      const action = createPending(
        "git_push",
        { remote: "origin", branch: "HEAD" },
        { requires_confirmation: true },
      );

      fs.writeFileSync(path.join(root, "file.txt"), "two\n");
      execFileSync("git", ["add", "file.txt"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "two"], { cwd: root });

      expect(popPending(action.action_id)).toBeUndefined();
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates git_add confirmation when a symlink is retargeted", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { getProjectRoot } = await import("../src/security.ts");
    const targetA = "__pending_symlink_target_a__.txt";
    const targetB = "__pending_symlink_target_b__.txt";
    const link = "__pending_symlink_link__.txt";
    const root = getProjectRoot();
    const absA = path.join(root, targetA);
    const absB = path.join(root, targetB);
    const absLink = path.join(root, link);
    try {
      fs.rmSync(absA, { force: true });
      fs.rmSync(absB, { force: true });
      fs.rmSync(absLink, { force: true });
      fs.writeFileSync(absA, "same contents", "utf8");
      fs.writeFileSync(absB, "same contents", "utf8");
      fs.symlinkSync(targetA, absLink);

      const action = createPending(
        "git_add",
        { path: link },
        { requires_confirmation: true },
      );

      fs.unlinkSync(absLink);
      fs.symlinkSync(targetB, absLink);

      expect(popPending(action.action_id)).toBeUndefined();
    } finally {
      fs.rmSync(absLink, { force: true });
      fs.rmSync(absA, { force: true });
      fs.rmSync(absB, { force: true });
    }
  });

  it("invalidates create_file confirmation when the target appears", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { getProjectRoot } = await import("../src/security.ts");
    const rel = "__pending_create_file_test__.txt";
    const abs = path.join(getProjectRoot(), rel);
    try {
      fs.rmSync(abs, { force: true });
      const action = createPending("create_file", { path: rel }, { requires_confirmation: true });
      fs.writeFileSync(abs, "created elsewhere", "utf8");
      expect(popPending(action.action_id)).toBeUndefined();
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });

});
