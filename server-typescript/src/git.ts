import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getAllowedReadPaths, getProjectRoot, isReadAllowed, safePath } from "./security.ts";

const GIT_STATUS_TIMEOUT = 10;
const GIT_DIFF_TIMEOUT = 10;
const GIT_LOG_TIMEOUT = 10;
const GIT_BRANCH_TIMEOUT = 10;

const GIT_STATUS_MAX_CHARS = 20_000;
const GIT_LOG_MAX_CHARS = 20_000;
const GIT_BRANCH_MAX_CHARS = 20_000;
const GIT_DIFF_MAX_CHARS = 50_000;

function runGit(
  args: string[],
  timeout: number,
  cwd?: string
): { code: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync("git", args, {
      cwd: cwd || getProjectRoot(),
      encoding: "utf-8",
      timeout: timeout * 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      code: result.status ?? 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch {
    return { code: 1, stdout: "", stderr: "git command failed" };
  }
}

export function gitStatus(): Record<string, unknown> {
  const result = runGit(
    ["status", "--short", "--branch"],
    GIT_STATUS_TIMEOUT
  );

  if (result.code === 127) return { error: "git is not installed or not on PATH." };
  if (result.code !== 0) return { error: result.stderr.trim() || "git status failed." };

  const statusText = result.stdout || "";
  const truncated = statusText.length > GIT_STATUS_MAX_CHARS;
  const payload: Record<string, unknown> = {
    status: statusText.slice(0, GIT_STATUS_MAX_CHARS),
    truncated,
  };
  if (truncated) {
    payload.truncation_note = `Status output was truncated to ${GIT_STATUS_MAX_CHARS} characters.`;
  }
  return payload;
}

/** Count files recorded in the current commit without changing repository state. */
export function gitCommittedFileCount(): Record<string, unknown> {
  const result = runGit(["ls-tree", "-r", "--name-only", "HEAD"], GIT_STATUS_TIMEOUT);

  if (result.code === 127) return { error: "git is not installed or not on PATH." };
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
}

export function gitDiff(
  relPath = "",
  staged = false
): Record<string, unknown> {
  const args = ["diff"];
  if (staged) args.push("--staged");

  const allowed = getAllowedReadPaths();
  if (allowed !== undefined) {
    if (relPath) {
      try {
        const filePath = safePath(relPath);
        if (!isReadAllowed(relPath)) {
          return { error: `Access denied: '${relPath}' is not selected for the agent.` };
        }
        args.push("--", path.relative(getProjectRoot(), filePath));
      } catch (exc) {
        return { error: String(exc) };
      }
    } else {
      const selected = [...allowed];
      if (selected.length === 0) {
        return { diff: "", truncated: false };
      }
      args.push("--", ...selected);
    }
  } else if (relPath) {
    try {
      const filePath = safePath(relPath);
      args.push(path.relative(getProjectRoot(), filePath));
    } catch (exc) {
      return { error: String(exc) };
    }
  }

  const result = runGit(args, GIT_DIFF_TIMEOUT);

  if (result.code === 127) return { error: "git is not installed or not on PATH." };
  if (result.code !== 0) return { error: result.stderr.trim() || "git diff failed." };

  const diffText = result.stdout || "";
  const truncated = diffText.length > GIT_DIFF_MAX_CHARS;
  const payload: Record<string, unknown> = {
    diff: diffText.slice(0, GIT_DIFF_MAX_CHARS),
    truncated,
  };
  if (truncated) {
    payload.truncation_note = `Diff output was truncated to ${GIT_DIFF_MAX_CHARS} characters.`;
  }
  return payload;
}

export function gitLog(maxCount = 10): Record<string, unknown> {
  let count: number;
  try {
    count = parseInt(String(maxCount), 10);
  } catch {
    return { error: "max_count must be a whole number." };
  }
  count = Math.max(1, Math.min(count, 100));

  const result = runGit(
    ["log", `-${count}`, "--oneline", "--decorate"],
    GIT_LOG_TIMEOUT
  );

  if (result.code === 127) return { error: "git is not installed or not on PATH." };
  if (result.code !== 0) return { error: result.stderr.trim() || "git log failed." };

  const logText = result.stdout || "";
  const truncated = logText.length > GIT_LOG_MAX_CHARS;
  const payload: Record<string, unknown> = {
    log: logText.slice(0, GIT_LOG_MAX_CHARS),
    truncated,
  };
  if (truncated) {
    payload.truncation_note = `Log output was truncated to ${GIT_LOG_MAX_CHARS} characters.`;
  }
  return payload;
}

export function gitBranch(): Record<string, unknown> {
  const result = runGit(["branch", "--list"], GIT_BRANCH_TIMEOUT);

  if (result.code === 127) return { error: "git is not installed or not on PATH." };
  if (result.code !== 0) return { error: result.stderr.trim() || "git branch failed." };

  const branchesText = result.stdout || "";
  const truncated = branchesText.length > GIT_BRANCH_MAX_CHARS;
  const payload: Record<string, unknown> = {
    branches: branchesText.slice(0, GIT_BRANCH_MAX_CHARS),
    truncated,
  };
  if (truncated) {
    payload.truncation_note = `Branch list was truncated to ${GIT_BRANCH_MAX_CHARS} characters.`;
  }
  return payload;
}
