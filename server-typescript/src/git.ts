// Git inspection and confirmation-required Git operations.
  //
  // Mirrors the Git portion of server-python/tools.py. Read-only operations
  // never mutate repository state. gitAdd() uses an explicit preview/confirm
  // flag and stages exactly one non-sensitive file.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getAllowedReadPaths, getProjectRoot, isReadAllowed, isSensitivePath, safePath } from "./security.ts";

const execFileAsync = promisify(execFile);

/**
 * Git configuration overrides for settings that can execute external commands
 * or otherwise weaken the application's Git execution boundary.
 *
 * Repository configuration is isolated separately with GIT_CONFIG pointing at
 * a temporary empty file. These -c values provide defense in depth and keep
 * hooks/known command-execution settings disabled even if configuration
 * isolation changes in a future Git version.
 */
const GIT_CONFIG_OVERRIDES: string[] = [
  // Hooks - disable all hooks
  "-c", "core.hooksPath=",

  // FS monitor hooks
  "-c", "core.fsmonitor=",
  "-c", "core.fsmonitorHook=",

  // Merge drivers - can execute arbitrary commands
  "-c", "merge.*.command=",
  "-c", "merge.*.driver=",

  // GPG
  "-c", "gpg.program=",

  // Email/sendemail
  "-c", "sendemail.smtpserver=",
  "-c", "sendemail.smtpencryption=",
  "-c", "sendemail.smtpuser=",
  "-c", "sendemail.smtppass=",
  "-c", "sendemail.smtpdomain=",

  // HTTP configuration that can affect outbound requests
  "-c", "http.extraHeader=",
  "-c", "http.proxy=",
  "-c", "http.postBuffer=",

  // Credential helpers can execute shell commands. An empty value resets
  // inherited/multi-valued helpers.
  "-c", "credential.helper=",

  // Git protocol proxy command can execute an external program.
  "-c", "core.gitProxy=none",
] as const;

/**
 * Validates a Git remote name.
 * Git remote names must not start with '-' (option) and should only contain
 * alphanumeric, dash, underscore, and dot characters.
 * Returns validated name or throws Error for invalid input.
 */
function validateGitRemote(remote: string): string {
  if (!remote || !remote.trim()) {
    throw new Error("Remote name is required");
  }
  const trimmed = remote.trim();
  if (trimmed.startsWith("-")) {
    throw new Error("Remote name cannot start with '-' (reserved for Git options)");
  }
  // Git remote names: alphanumeric, dash, underscore, dot
  if (!/^[\w.-]+$/.test(trimmed)) {
    throw new Error(`Invalid remote name: '${trimmed}'. Use alphanumeric, dash, underscore, or dot.`);
  }
  return trimmed;
}

/**
 * Validates a Git branch name.
 * Git branch names have restrictions but primarily must not start with '-'.
 * We allow a reasonable subset that covers normal branch names.
 * Returns validated name or throws Error for invalid input.
 */
function validateGitBranch(branch: string): string {
  if (!branch || !branch.trim()) {
    throw new Error("Branch name is required");
  }
  const trimmed = branch.trim();
  if (trimmed.startsWith("-")) {
    throw new Error("Branch name cannot start with '-' (reserved for Git options)");
  }
  // Basic validation - reject obviously dangerous patterns
  // Git branch names can't contain spaces, ~, ^, :, ?, *, [, \\, or control chars
  if (/[\s~^:?*[\\]/.test(trimmed)) {
    throw new Error(`Invalid branch name: '${trimmed}'. Contains disallowed characters.`);
  }
  if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.endsWith(".lock")) {
    throw new Error(`Invalid branch name: '${trimmed}'.`);
  }
  return trimmed;
}

/**
 * Wraps a validation function to return an object with either { error } or { value }.
 */
function safeValidate<T>(validator: (input: string) => T, input: string): { error: string } | { value: T } {
  try {
    return { value: validator(input) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

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

/**
 * Reads only the requested Git identity value from a specific config scope.
 * This is deliberately limited to user.name/user.email and uses --no-includes
 * so repository-controlled include directives cannot redirect the read.
 */
async function readGitIdentityValue(scope: "--local" | "--global", key: "user.name" | "user.email"): Promise<string | undefined> {
  const env = { ...process.env };
  delete env.GIT_CONFIG;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_CONFIG_NOSYSTEM;

  try {
    const result = await execFileAsync("git", [scope, "--no-includes", "--get", key], {
      cwd: getProjectRoot(),
      shell: false,
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 8_192,
      encoding: "utf8",
      env,
    });
    const value = String(result.stdout ?? "").trim();
    if (!value || value.length > 256 || /[\u0000\r\n]/.test(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the normal commit identity without exposing any other repository
 * configuration to the isolated Git subprocess. Explicit environment values
 * remain authoritative; otherwise local identity is preferred, then global.
 */
async function getSafeCommitIdentity(): Promise<{ name?: string; email?: string }> {
  const name = process.env.GIT_COMMITTER_NAME ?? process.env.GIT_AUTHOR_NAME
    ?? await readGitIdentityValue("--local", "user.name")
    ?? await readGitIdentityValue("--global", "user.name");
  const email = process.env.GIT_COMMITTER_EMAIL ?? process.env.GIT_AUTHOR_EMAIL
    ?? await readGitIdentityValue("--local", "user.email")
    ?? await readGitIdentityValue("--global", "user.email");

  return { name, email };
}

async function runGit(args: string[], timeout: number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  // GIT_CONFIG is the exclusive Git configuration file used by Git commands.
  // Point it at an empty temporary file so repository-local .git/config and
  // .git/config.worktree cannot supply command-executing configuration.
  const isolationDir = mkdtempSync(join(tmpdir(), "git-isolation-"));
  const emptyConfigPath = join(isolationDir, "config");
  const emptyHooksDir = join(isolationDir, "hooks");
  writeFileSync(emptyConfigPath, "", { encoding: "utf8", mode: 0o600 });

  try {
    const safeArgs = [...GIT_CONFIG_OVERRIDES, ...args];
    const result = await execFileAsync("git", safeArgs, {
      cwd: getProjectRoot(),
      shell: false,
      timeout,
      windowsHide: true,
      maxBuffer: Math.max(GIT_DIFF_MAX_CHARS * 2, 100_000),
      encoding: "utf8",
      env: {
        ...process.env,
        // GIT_CONFIG selects the only configuration file Git reads for this
        // subprocess. The file is empty and lives outside the repository.
        GIT_CONFIG: emptyConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        // Prevent inherited external helpers from becoming another execution
        // path. These environment variables take precedence over corresponding
        // Git configuration where supported.
        GIT_EXTERNAL_DIFF: "",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_SSH_COMMAND: "ssh",
        GIT_PROXY_COMMAND: "none",
      },
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
  } finally {
    try {
      rmSync(isolationDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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
  const args = ["diff", "--no-ext-diff", "--no-textconv"];
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

  if (!isReadAllowed(path)) {
    return { error: `Access denied: '${path}' is not selected for the agent.` };
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
  const args = ["fetch", "--no-recurse-submodules", "--upload-pack=git-upload-pack"];
  if (remote) {
    const validation = safeValidate(validateGitRemote, remote);
    if ("error" in validation) return validation;
    args.push("--", validation.value);
  }

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

  const args = ["pull", "--no-recurse-submodules", "--upload-pack=git-upload-pack"];
  if (remote) {
    const validation = safeValidate(validateGitRemote, remote);
    if ("error" in validation) return validation;
    args.push("--", validation.value);
  }
  if (branch) {
    const validation = safeValidate(validateGitBranch, branch);
    if ("error" in validation) return validation;
    args.push(validation.value);
  }

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
    const identity = await getSafeCommitIdentity();
    const identityArgs: string[] = [];
    if (identity.name) identityArgs.push("-c", `user.name=${identity.name}`);
    if (identity.email) identityArgs.push("-c", `user.email=${identity.email}`);
    const result = await runGit([...identityArgs, "commit", "-m", trimmedMessage], GIT_COMMIT_TIMEOUT_MS);
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
      message: `This will push commits to '${remote || "default"}' on branch '${branch || "current branch"}'. This updates the remote repository. Confirm to proceed.`,
    };
  }

  const args = ["push", "--no-recurse-submodules", "--receive-pack=git-receive-pack"];
  if (remote) {
    const validation = safeValidate(validateGitRemote, remote);
    if ("error" in validation) return validation;
    args.push("--", validation.value);
  }
  if (branch) {
    const validation = safeValidate(validateGitBranch, branch);
    if ("error" in validation) return validation;
    args.push(branch);
  }

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