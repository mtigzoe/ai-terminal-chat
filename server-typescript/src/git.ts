// Git inspection and confirmation-required Git operations.
//
// Mirrors the Git portion of server-python/tools.py. Read-only operations
// never mutate repository state. gitAdd() uses an explicit preview/confirm
// flag and stages exactly one non-sensitive file.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getAllowedReadPaths, getProjectRoot, isReadAllowed, isSensitivePath, safePath } from "./security.ts";

const execFileAsync = promisify(execFile);

const GIT_STATUS_TIMEOUT_MS = 10_000;
const GIT_DIFF_TIMEOUT_MS = 10_000;
const GIT_LOG_TIMEOUT_MS = 10_000;
const GIT_BRANCH_TIMEOUT_MS = 10_000;
const GIT_ADD_TIMEOUT_MS = 15_000;

const GIT_FETCH_TIMEOUT_MS = 15_000;
const GIT_PULL_TIMEOUT_MS = 30_000;
const GIT_RESTORE_TIMEOUT_MS = 15_000;
const GIT_COMMIT_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 30_000;

const GIT_FETCH_MAX_CHARS = 10_000;
const GIT_PULL_MAX_CHARS = 10_000;
const GIT_RESTORE_MAX_CHARS = 10_000;
const GIT_COMMIT_MAX_CHARS = 10_000;
const GIT_PUSH_MAX_CHARS = 10_000;

const GIT_STATUS_MAX_CHARS = 20_000;
const GIT_LOG_MAX_CHARS = 20_000;
const GIT_BRANCH_MAX_CHARS = 20_000;
const GIT_DIFF_MAX_CHARS = 50_000;

function cap(value: string, limit: number): { value: string; truncated: boolean } {
  return { value: value.slice(0, limit), truncated: value.length > limit };
}

function errorText(error: unknown): string {
  const value = error as NodeJS.ErrnoException & { stderr?: string };
  if (value.code === "ENOENT") return "git is not installed or not on PATH.";
  if (value.stderr) return String(value.stderr).trim();
  return value.message ?? String(error);
}

async function runGit(args: string[], timeout: number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: getProjectRoot(),
      shell: false,
      timeout,
      windowsHide: true,
      maxBuffer: Math.max(GIT_DIFF_MAX_CHARS * 2, 100_000),
      encoding: "utf8",
    });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
      code?: number | string;
      killed?: boolean;
    };
    if (value.code === "ENOENT") throw error;
    if (value.code === "ETIMEDOUT" || value.killed) {
      throw Object.assign(new Error(`Git command timed out after ${timeout / 1000} seconds.`), {
        code: "ETIMEDOUT",
      });
    }
    return {
      code: typeof value.code === "number" ? value.code : (value.status ?? 1),
      stdout: String(value.stdout ?? ""),
      stderr: String(value.stderr ?? ""),
    };
  }
}

export async function gitStatus(): Promise<Record<string, unknown>> {
  try {
    const result = await runGit(["status", "--short", "--branch"], GIT_STATUS_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git status failed." };
    const status = cap(result.stdout, GIT_STATUS_MAX_CHARS);
    const payload: Record<string, unknown> = { status: status.value, truncated: status.truncated };
    if (status.truncated && !('error' in payload)) {
      payload.truncation_note = `Status output was truncated to ${GIT_STATUS_MAX_CHARS} characters.`;
    }
    return payload;
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** Count files recorded in the current commit without changing repository state. */
export async function gitCommittedFileCount(): Promise<Record<string, unknown>> {
  try {
    const result = await runGit(
      ["ls-tree", "-r", "--name-only", "HEAD"],
      GIT_STATUS_TIMEOUT_MS,
    );

    if (result.code !== 0) {
      return {
        error:
          result.stderr.trim() ||
          "Could not count files in the current commit. The repository may not have a commit yet.",
      };
    }

    return {
      committed_files: result.stdout.split(/\r?\n/).filter(Boolean).length,
    };
  } catch (error) {
    return { error: errorText(error) };
  }
}

export async function gitDiff(path = "", staged = false): Promise<Record<string, unknown>> {
  const args = ["diff"];
  if (staged) args.push("--staged");

  const allowed = getAllowedReadPaths();

  if (allowed !== undefined) {
    if (path) {
      try {
        const filePath = safePath(path);
        if (!isReadAllowed(path)) {
          return { error: `Access denied: '${path}' is not selected for the agent.` };
        }
        if (isSensitivePath(filePath)) {
          return { error: `Refusing to inspect sensitive file: ${path}` };
        }
        const root = getProjectRoot();
        const relativePath = filePath.slice(root.length).replace(/^[/\\]+/, "");
        args.push("--", relativePath);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      const selected = [...allowed];

      if (selected.length === 0) {
        return { diff: "", truncated: false };
      }

      args.push("--", ...selected);
    }
  } else if (path) {
    let filePath: string;
    try {
      filePath = safePath(path);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }

    if (isSensitivePath(filePath)) {
      return { error: `Refusing to inspect sensitive file: ${path}` };
    }

    const root = getProjectRoot();
    const relativePath = filePath.slice(root.length).replace(/^[/\\]+/, "");
    args.push("--", relativePath);
  }

  try {
    const result = await runGit(args, GIT_DIFF_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git diff failed." };
    const diff = cap(result.stdout, GIT_DIFF_MAX_CHARS);
    const payload: Record<string, unknown> = { diff: diff.value, truncated: diff.truncated };
    if (diff.truncated && !('error' in payload)) {
      payload.truncation_note = `Diff output was truncated to ${GIT_DIFF_MAX_CHARS} characters. Request a path-scoped diff for a smaller view.`;
    }
    return payload;
  } catch (error) {
    return { error: errorText(error) };
  }
}

export async function gitLog(maxCount = 10): Promise<Record<string, unknown>> {
  const numeric = Number(maxCount);
  if (!Number.isInteger(numeric)) return { error: "max_count must be a whole number." };
  const count = Math.max(1, Math.min(numeric, 100));

  try {
    const result = await runGit(["log", `-${count}`, "--oneline", "--decorate"], GIT_LOG_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git log failed." };
    const log = cap(result.stdout, GIT_LOG_MAX_CHARS);
    const payload: Record<string, unknown> = { log: log.value, truncated: log.truncated };
    if (log.truncated && !('error' in payload)) {
      payload.truncation_note = `Log output was truncated to ${GIT_LOG_MAX_CHARS} characters.`;
    }
    return payload;
  } catch (error) {
    return { error: errorText(error) };
  }
}

export async function gitBranch(): Promise<Record<string, unknown>> {
  try {
    const result = await runGit(["branch", "--list"], GIT_BRANCH_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git branch failed." };
    const branches = cap(result.stdout, GIT_BRANCH_MAX_CHARS);
    const payload: Record<string, unknown> = { branches: branches.value, truncated: branches.truncated };
    if (branches.truncated && !('error' in payload)) {
      payload.truncation_note = `Branch list was truncated to ${GIT_BRANCH_MAX_CHARS} characters.`;
    }
    return payload;
  } catch (error) {
    return { error: errorText(error) };
  }
}

export async function gitAdd(path: string, confirm = false): Promise<Record<string, unknown>> {
  let filePath: string;
  try {
    filePath = safePath(path);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (isSensitivePath(filePath)) return { error: `Refusing to stage sensitive file: ${path}` };

  try {
    const repository = await runGit(["rev-parse", "--show-toplevel"], GIT_ADD_TIMEOUT_MS);
    if (repository.code !== 0) {
      return { error: "git_add requires the project to be inside a git repository." };
    }
  } catch (error) {
    return { error: errorText(error) };
  }

  const { statSync } = await import("node:fs");
  try {
    if (!statSync(filePath).isFile()) return { error: "git_add can only stage a single file, not a directory." };
  } catch {
    return { error: `File does not exist: ${path}` };
  }

  const root = getProjectRoot();
  const relativePath = filePath.slice(root.length).replace(/^[/\\]+/, "");

  if (!confirm) {
    return {
      requires_confirmation: true,
      path: relativePath,
      message: `'${relativePath}' was NOT staged. Ask the user to explicitly confirm it, then call git_add again with confirm=true.`,
    };
  }

  try {
    const result = await runGit(["add", "--", relativePath], GIT_ADD_TIMEOUT_MS);
    if (result.code !== 0) {
      return { error: `git add failed: ${result.stderr.trim() || result.stdout.trim()}` };
    }
    return { path: relativePath, staged: true };
  } catch (error) {
    return { error: `Could not stage file: ${errorText(error)}` };
  }
}

const PREVIEW_CHAR_LIMIT = 2000;

export async function gitFetch(remote = ""): Promise<Record<string, unknown>> {
  const args = ["fetch"];
  if (remote) args.push(remote);

  try {
    const result = await runGit(args, GIT_FETCH_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git fetch failed." };

    let output = result.stdout.trim();
    if (!output && !result.stderr.trim()) output = "Fetch completed successfully.";

    return {
      output: output.slice(0, GIT_FETCH_MAX_CHARS),
      remote: remote || "all remotes",
    };
  } catch (exc) {
    return { error: errorText(exc) };
  }
}

export async function gitPull(remote = "", branch = "", confirm = false): Promise<Record<string, unknown>> {
  if (!confirm) {
    return {
      requires_confirmation: true,
      remote: remote || "default",
      branch: branch || "current",
      message: `This will pull from '${remote || "default remote"}' and merge into the current branch. This changes local files and may create merge conflicts. Confirm to proceed.`,
    };
  }

  const args = ["pull"];
  if (remote) args.push(remote);
  if (branch) args.push(branch);

  try {
    const result = await runGit(args, GIT_PULL_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git pull failed." };

    return {
      output: (result.stdout || "").slice(0, GIT_PULL_MAX_CHARS),
      remote: remote || "default",
      branch: branch || "current",
    };
  } catch (exc) {
    return { error: errorText(exc) };
  }
}

export async function gitRestore(path: string, staged = false, confirm = false): Promise<Record<string, unknown>> {
  let filePath: string;
  try {
    filePath = safePath(path);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (isSensitivePath(filePath)) return { error: `Refusing to restore sensitive file: ${path}` };

  const { statSync } = await import("node:fs");
  try {
    if (!statSync(filePath).isFile()) return { error: `File does not exist: ${path}` };
  } catch {
    return { error: `File does not exist: ${path}` };
  }

  const root = getProjectRoot();
  const relativePath = filePath.slice(root.length).replace(/^[/\\]+/, "");

  if (!confirm) {
    const action = staged ? "unstage" : "restore";
    return {
      requires_confirmation: true,
      path: relativePath,
      action,
      message: `'${relativePath}' will be ${action}d. This discards uncommitted changes. Confirm to proceed.`,
    };
  }

  const args = ["restore"];
  if (staged) args.push("--staged");
  args.push("--", relativePath);

  try {
    const result = await runGit(args, GIT_RESTORE_TIMEOUT_MS);
    if (result.code !== 0) {
      return { error: `git restore failed: ${result.stderr.trim() || result.stdout.trim()}` };
    }

    return { path: relativePath, restored: !staged, unstaged: staged };
  } catch (exc) {
    return { error: errorText(exc) };
  }
}

export async function gitCommit(message: string, confirm = false): Promise<Record<string, unknown>> {
  if (!message || !message.trim()) {
    return { error: "A commit message is required." };
  }

  const trimmedMessage = message.trim();

  if (!confirm) {
    const diffResult = await gitDiff("", true);
    let diffText = "";
    if (diffResult && typeof diffResult === "object" && "diff" in diffResult) {
      diffText = String(diffResult.diff ?? "");
    }

    if (!diffText) {
      return { error: "No staged changes to commit." };
    }

    const preview = diffText.slice(0, PREVIEW_CHAR_LIMIT);
    const previewTruncated = diffText.length > PREVIEW_CHAR_LIMIT;

    return {
      requires_confirmation: true,
      commit_message: trimmedMessage,
      preview,
      preview_truncated: previewTruncated,
      message: `About to commit with message: '${trimmedMessage}'. This creates a new commit in the repository. Confirm to proceed.`,
    };
  }

  try {
    const result = await runGit(["commit", "-m", trimmedMessage], GIT_COMMIT_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git commit failed." };

    return {
      output: (result.stdout || "").slice(0, GIT_COMMIT_MAX_CHARS),
      commit_message: trimmedMessage,
      committed: true,
    };
  } catch (exc) {
    return { error: errorText(exc) };
  }
}

export async function gitPush(remote = "", branch = "", confirm = false): Promise<Record<string, unknown>> {
  if (!confirm) {
    return {
      requires_confirmation: true,
      remote: remote || "default",
      branch: branch || "current",
      message: `This will push commits to '${remote || "default remote"}' on branch '${branch || "current branch"}'. This updates the remote repository. Confirm to proceed.`,
    };
  }

  const args = ["push"];
  if (remote) args.push(remote);
  if (branch) args.push(branch);

  try {
    const result = await runGit(args, GIT_PUSH_TIMEOUT_MS);
    if (result.code !== 0) return { error: result.stderr.trim() || "git push failed." };

    return {
      output: (result.stdout || "").slice(0, GIT_PUSH_MAX_CHARS),
      remote: remote || "default",
      branch: branch || "current",
      pushed: true,
    };
  } catch (exc) {
    return { error: errorText(exc) };
  }
}
