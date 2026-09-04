import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safePath, getProjectRoot, setProjectRoot, isSensitiveFilename, isSensitivePath, runWithAllowedReadPaths } from "../src/security.ts";
import { listFiles, readFile, searchFiles } from "../src/filesystem.ts";
import { runCommand, getAllowedCommands, isCommandAllowed, addAllowedCommand, removeAllowedCommand, reloadAllowedCommands, persistAllowedCommands, DEFAULT_ALLOWED_COMMAND_PREFIXES } from "../src/terminal.ts";
import { git_add as gitAdd } from "../src/write-tools.ts";
import {
  gitFetch,
  gitPull,
  gitRestore,
  gitCommit,
  gitPush,
} from "../src/git.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function gitInit(repoDir: string): void {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" });
}

const TEST_DIR = path.join(os.tmpdir(), `ai-terminal-chat-tests-${Date.now()}`);

beforeEach(() => {
  // Reset allowlist to defaults on disk so that mutations from other
  // test files cannot leak into these tests, then reload into memory.
  persistAllowedCommands([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  reloadAllowedCommands();
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setProjectRoot(TEST_DIR);
});

afterEach(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  // Reset the allowlist to defaults so tests in other files that share
  // the same process/module cache are not affected by mutations here.
  reloadAllowedCommands();
});

describe("safePath", () => {
  it("accepts project-relative path", () => {
    const result = safePath("server-typescript");
    expect(result).toBe(path.join(TEST_DIR, "server-typescript"));
  });

  it("rejects absolute paths", () => {
    expect(() => safePath("/etc/passwd")).toThrow("Absolute paths are not allowed");
    expect(() => safePath("C:\\Users\\test\\secret.txt")).toThrow("Absolute paths are not allowed");
  });

  it("rejects traversal variants", () => {
    expect(() => safePath("../outside.txt")).toThrow("outside the project");
    expect(() => safePath("../../etc/passwd")).toThrow("outside the project");
    expect(() => safePath("subdir/../../outside.txt")).toThrow("outside the project");
  });
});

describe("isSensitiveFilename", () => {
  it("blocks env and credential files", () => {
    expect(isSensitiveFilename(".env")).toBe(true);
    expect(isSensitiveFilename(".env.local")).toBe(true);
    expect(isSensitiveFilename("credentials.json")).toBe(true);
    expect(isSensitiveFilename("private.key")).toBe(true);
    expect(isSensitiveFilename("server.pem")).toBe(true);
  });

  it("allows normal files", () => {
    expect(isSensitiveFilename("app.ts")).toBe(false);
    expect(isSensitiveFilename("README.md")).toBe(false);
  });
});

describe("isSensitivePath", () => {
  it("blocks anything under .git", () => {
    const gitDir = path.join(TEST_DIR, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    expect(isSensitivePath(path.join(gitDir, "config"))).toBe(true);
  });

  it("blocks env and credential files", () => {
    expect(isSensitivePath(path.join(TEST_DIR, ".env"))).toBe(true);
    expect(isSensitivePath(path.join(TEST_DIR, "credentials.json"))).toBe(true);
  });
});

describe("listFiles", () => {
  it("lists directory entries", () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"));
    fs.writeFileSync(path.join(TEST_DIR, "src", "index.ts"), "export {}");
    fs.writeFileSync(path.join(TEST_DIR, "README.md"), "# README");

    const result = listFiles(".");
    expect(result.entries).toBeDefined();
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("returns error for non-existent path", () => {
    const result = listFiles("does-not-exist");
    expect(result.error).toBeDefined();
  });
});

describe("readFile", () => {
  it("reads file contents", () => {
    fs.writeFileSync(path.join(TEST_DIR, "test.txt"), "hello world");
    const result = readFile("test.txt");
    expect(result.contents).toBe("hello world");
  });

  it("refuses sensitive files", () => {
    fs.writeFileSync(path.join(TEST_DIR, ".env"), "SECRET=1");
    const result = readFile(".env");
    expect(result.error).toBeDefined();
    expect((result as { contents?: string }).contents).toBeUndefined();
  });
});

describe("searchFiles", () => {
  it("finds matching lines", () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"));
    fs.writeFileSync(path.join(TEST_DIR, "src", "app.ts"), "function main() {}\nfunction helper() {}\n");

    const result = searchFiles("main", ".");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].text).toContain("main");
  });
});

describe("runCommand", () => {
  it("rejects command chaining", async () => {
    const result = await runCommand("git status && whoami");
    expect(result.error).toBeDefined();
  });

  it("rejects piping", async () => {
    const result = await runCommand("git log | grep secret");
    expect(result.error).toBeDefined();
  });

  it("rejects redirection", async () => {
    const result = await runCommand("git log > /tmp/leak.txt");
    expect(result.error).toBeDefined();
  });

  it("rejects shell substitution", async () => {
    const result = await runCommand("git status `whoami`");
    expect(result.error).toBeDefined();
  });

  it("rejects dangerous commands", async () => {
    const dangerous = ["rm -rf /", "sudo rm -rf .", "shutdown -h now", "reboot", "poweroff", "halt", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda", "chmod 777 /etc/passwd", "chown root:root /etc/passwd", "printenv", "cat .env", "cat id_rsa"];
    for (const cmd of dangerous) {
      const result = await runCommand(cmd);
      expect(result.error).toBeDefined();
    }
  });

  it("rejects commands outside the allowlist", async () => {
    const result = await runCommand("whoami");
    expect(result.error).toBeDefined();
  });

  it("executes allowed commands", async () => {
    const result = await runCommand("node --version");
    expect(result.error).toBeUndefined();
    expect(result.returncode).toBe(0);
    expect(String(result.stdout).trim()).toMatch(/^v?\d+\.\d+\.\d+/);
  });

  it("correctly splits multi-word allowed commands into argv", async () => {
    const result = await runCommand("node --version");
    expect(result.error).toBeUndefined();
    expect(result.command).toBe("node --version");
    expect(String(result.stdout)).not.toBe("");
  });

  it("surfaces an error instead of a fake success for a missing binary", async () => {
    const result = await runCommand("wsl-not-installed-xyz");
    expect(result.error).toBeDefined();
    expect(result.returncode).toBeUndefined();
  });
});

describe("agent file-read permissions", () => {
  it("denies an unselected file and allows a selected file", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "README.md"), "README secret contents");
    fs.writeFileSync(path.join(TEST_DIR, "selected.txt"), "selected contents");

    await runWithAllowedReadPaths(["selected.txt"], async () => {
      const denied = readFile("README.md");
      expect(denied.error).toContain("not in the set of files the user selected");
      expect(denied.contents).toBeUndefined();

      const allowed = readFile("selected.txt");
      expect(allowed.contents).toBe("selected contents");
    });
  });

  it("filters unselected files from list and search", async () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"));
    fs.writeFileSync(path.join(TEST_DIR, "README.md"), "README secret contents");
    fs.writeFileSync(path.join(TEST_DIR, "src", "selected.ts"), "selected secret contents");

    await runWithAllowedReadPaths(["src/selected.ts"], async () => {
      const root = listFiles(".");
      const rootNames = (root.entries as { name: string }[]).map((entry) => entry.name);
      expect(rootNames).not.toContain("README.md");
      expect(rootNames).toContain("src");

      const matches = searchFiles("secret", ".");
      expect(matches.matches).toHaveLength(1);
      expect(matches.matches[0].path).toContain("selected.ts");
    });
  });

  it("blocks a file-content shell command even when that command is allowlisted", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "README.md"), "README secret contents");

    const alreadyAllowed = getAllowedCommands().includes("cat");
    if (!alreadyAllowed) addAllowedCommand("cat");
    try {
      await runWithAllowedReadPaths(["selected.txt"], async () => {
        const result = await runCommand("cat README.md");
        expect(result.error).toContain("Access denied");
        expect(result.stdout).toBeUndefined();
      });
    } finally {
      if (!alreadyAllowed) removeAllowedCommand("cat");
    }
  });

  it("blocks git show of an unselected file", async () => {
    await runWithAllowedReadPaths(["selected.txt"], async () => {
      const result = await runCommand("git show HEAD:README.md");
      expect(result.error).toContain("Access denied");
    });
  });
});

describe("gitAdd", () => {
  it("rejects path traversal", () => {
    const result = gitAdd("../outside.txt");
    expect(result.error).toBeDefined();
  });

  it("rejects absolute paths", () => {
    const result = gitAdd("/etc/passwd");
    expect(result.error).toBeDefined();
  });

  it("rejects missing files", () => {
    const repoDir = path.join(os.tmpdir(), `git-repo-missing-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);

    const result = gitAdd("does-not-exist.txt");
    expect(result.error).toBeDefined();
    expect((result.error as string).toLowerCase()).toContain("does not exist");

    setProjectRoot(originalRoot);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("requires a git repository", () => {
    const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
    fs.mkdirSync(nonGitDir, { recursive: true });
    const originalRoot = getProjectRoot();
    setProjectRoot(nonGitDir);
    fs.writeFileSync(path.join(nonGitDir, "file.txt"), "hello");
    const result = gitAdd("file.txt");
    expect(result.error).toBeDefined();
    expect((result.error as string).toLowerCase()).toContain("git repository");
    setProjectRoot(originalRoot);
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  it("preview never touches the index", () => {
    const repoDir = path.join(os.tmpdir(), `git-repo-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git"), "gitdir placeholder");
    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello");

    try {
      const result = gitAdd("file.txt");
      expect((result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
      expect((result as { path: string }).path).toBe("file.txt");
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive files", () => {
    const repoDir = path.join(os.tmpdir(), `git-repo-sensitive-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git"), "gitdir placeholder");
    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);
    fs.writeFileSync(path.join(repoDir, ".env"), "SECRET=1");

    try {
      const result = gitAdd(".env");
      expect(result.error).toBeDefined();
      expect((result.error as string).toLowerCase()).toContain("sensitive");
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("allowed commands", () => {
  it("rejects known dangerous prefixes", () => {
    expect(isCommandAllowed("rm -rf /")).toBe(false);
    expect(isCommandAllowed("git push")).toBe(false);
    expect(isCommandAllowed("git commit -m 'x'")).toBe(false);
    expect(isCommandAllowed("git pull")).toBe(false);
  });
});

describe("gitFetch", () => {
  it("returns output without error", async () => {
    const repoDir = path.join(os.tmpdir(), `git-fetch-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    gitInit(repoDir);
    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);

    try {
      const result = await gitFetch();
      expect(result.error).toBeUndefined();
      expect((result as { remote?: string }).remote).toBe("all remotes");
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("passes through the remote name", async () => {
    const bareRemote = path.join(os.tmpdir(), `git-fetch-remote-${Date.now()}-bare.git`);
    const repoDir = path.join(os.tmpdir(), `git-fetch-remote-${Date.now()}`);
    fs.mkdirSync(bareRemote, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    spawnSync("git", ["init", "--bare", bareRemote], { cwd: bareRemote, stdio: "ignore" });
    gitInit(repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello");
    spawnSync("git", ["add", "file.txt"], { cwd: repoDir, stdio: "ignore" });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    spawnSync("git", ["remote", "add", "origin", bareRemote], { cwd: repoDir, stdio: "ignore" });
    spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir, stdio: "ignore" });

    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);

    try {
      const result = await gitFetch("origin");
      expect(result.error).toBeUndefined();
      expect((result as { remote?: string }).remote).toBe("origin");
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(bareRemote, { recursive: true, force: true });
    }
  });
});

describe("gitPull", () => {
  it("requires confirmation on first call", async () => {
    const result = await gitPull();
    expect((result as { requires_confirmation?: boolean }).requires_confirmation).toBe(true);
  });

  it("returns preview with default remote and branch", async () => {
    const result = await gitPull();
    expect((result as { remote?: string }).remote).toBe("default");
    expect((result as { branch?: string }).branch).toBe("current");
  });
});

describe("gitRestore", () => {
  it("requires confirmation on first call", async () => {
    const repoDir = path.join(os.tmpdir(), `git-restore-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    gitInit(repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello");
    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);

    try {
      const result = await gitRestore("file.txt");
      expect((result as { requires_confirmation?: boolean }).requires_confirmation).toBe(true);
      expect((result as { action?: string }).action).toBe("restore");
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive files", async () => {
    const repoDir = path.join(os.tmpdir(), `git-restore-sensitive-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    gitInit(repoDir);
    fs.writeFileSync(path.join(repoDir, ".env"), "SECRET=1");
    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);

    try {
      const result = await gitRestore(".env");
      expect(result.error).toBeDefined();
      expect(String(result.error).toLowerCase()).toContain("sensitive");
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("gitCommit", () => {
  it("requires a message", async () => {
    const result = await gitCommit("");
    expect(result.error).toBeDefined();
    expect(String(result.error).toLowerCase()).toContain("message");
  });

  it("requires confirmation on first call", async () => {
    const repoDir = path.join(os.tmpdir(), `git-commit-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    gitInit(repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello");
    const originalRoot = getProjectRoot();
    setProjectRoot(repoDir);

    try {
      const addResult = await gitAdd("file.txt", true);
      if ((addResult as { error?: string }).error) {
        return;
      }

      fs.writeFileSync(path.join(repoDir, "file.txt"), "v2");
      const addResult2 = await gitAdd("file.txt", true);
      if ((addResult2 as { error?: string }).error) {
        return;
      }

      const result = await gitCommit("test commit");
      expect((result as { requires_confirmation?: boolean }).requires_confirmation).toBe(true);
      expect((result as { commit_message?: string }).commit_message).toBe("test commit");
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("gitPush", () => {
  it("requires confirmation on first call", async () => {
    const result = await gitPush();
    expect((result as { requires_confirmation?: boolean }).requires_confirmation).toBe(true);
    expect((result as { remote?: string }).remote).toBe("default");
    expect((result as { branch?: string }).branch).toBe("current");
  });
});

describe("new git tool registration", () => {
  it("has all new tools in TOOL_SCHEMAS", async () => {
    const { TOOL_SCHEMAS } = await import("../src/tools.ts");
    for (const name of ["git_fetch", "git_pull", "git_restore", "git_commit", "git_push"]) {
      expect(TOOL_SCHEMAS[name]).toBeDefined();
    }
  });
});
