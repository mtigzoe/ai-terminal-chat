import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getProjectRoot, isSensitivePath, safePath } from "./security.ts";

const PREVIEW_CHAR_LIMIT = 2000;
const MAX_PATCH_SIZE = 200_000;
const GIT_TIMEOUT = 15;

function relativePath(filePath: string): string {
  return path.relative(getProjectRoot(), filePath);
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeText(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf-8");
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function unlinkFile(filePath: string): void {
  fs.unlinkSync(filePath);
}

function runGit(
  args: string[],
  input?: string
): { code: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync("git", args, {
      cwd: getProjectRoot(),
      encoding: "utf-8",
      timeout: GIT_TIMEOUT * 1000,
      stdio: ["pipe", "pipe", "pipe"],
      input,
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

function hasGitRepo(): boolean {
  if (fs.existsSync(path.join(getProjectRoot(), ".git"))) {
    return true;
  }
  const result = runGit(["rev-parse", "--show-toplevel"]);
  return result.code === 0;
}

function gitRepoError(): Record<string, unknown> | undefined {
  if (fs.existsSync(path.join(getProjectRoot(), ".git"))) {
    return undefined;
  }
  const result = runGit(["rev-parse", "--show-toplevel"]);
  if (result.code === 127) {
    return { error: "git is not installed or not on PATH." };
  }
  if (result.code !== 0) {
    return {
      error:
        "This operation requires the project to be inside a git repository (no .git found in PROJECT_ROOT or any parent directory).",
    };
  }
  return undefined;
}

export function create_file(
  relPath: string,
  contents = "",
  confirm = false
): Record<string, unknown> {
  let filePath: string;
  try {
    filePath = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (isSensitivePath(filePath)) {
    return { error: `Refusing to create sensitive file: ${relPath}` };
  }

  if (fs.existsSync(filePath)) {
    return {
      error: `File already exists: ${relPath}. Use write_file to modify it.`,
    };
  }

  if (!confirm) {
    const preview = contents.slice(0, PREVIEW_CHAR_LIMIT);
    const truncated = contents.length > PREVIEW_CHAR_LIMIT;
    return {
      requires_confirmation: true,
      path: relativePath(filePath),
      preview,
      preview_truncated: truncated,
      message: `'${relPath}' was NOT created. Show the user the preview and ask them to explicitly confirm creating this file, then call create_file again with confirm=true.`,
    };
  }

  try {
    ensureParentDir(filePath);
    writeText(filePath, contents);
  } catch (exc) {
    return { error: `Could not create file: ${exc}` };
  }

  return {
    path: relativePath(filePath),
    created: true,
    bytes_written: Buffer.byteLength(contents, "utf-8"),
  };
}

export function write_file(
  relPath: string,
  contents: string,
  confirm = false
): Record<string, unknown> {
  let filePath: string;
  try {
    filePath = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (isSensitivePath(filePath)) {
    return { error: `Refusing to write to sensitive file: ${relPath}` };
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    return { error: `Cannot write to a directory: ${relPath}` };
  }

  const existed = fs.existsSync(filePath);

  if (!confirm) {
    let oldText = "";
    if (existed) {
      try {
        oldText = readText(filePath);
      } catch {
        oldText = "";
      }
    }

    let diffPreview: string | undefined;
    if (existed) {
      diffPreview = generateUnifiedDiff(
        oldText,
        contents,
        `a/${relPath}`,
        `b/${relPath}`
      ).slice(0, PREVIEW_CHAR_LIMIT);
    }

    return {
      requires_confirmation: true,
      path: relativePath(filePath),
      action: existed ? "overwrite" : "create",
      diff: diffPreview,
      message: `'${relPath}' was NOT written. Show the user the diff and ask them to explicitly confirm this change, then call write_file again with confirm=true.`,
    };
  }

  try {
    ensureParentDir(filePath);
    writeText(filePath, contents);
  } catch (exc) {
    return { error: `Could not write file: ${exc}` };
  }

  return {
    path: relativePath(filePath),
    overwritten: existed,
    bytes_written: Buffer.byteLength(contents, "utf-8"),
  };
}

export function apply_patch(
  patch: string,
  confirm = false
): Record<string, unknown> {
  if (!patch || !patch.trim()) {
    return { error: "No patch text was provided." };
  }

  if (patch.length > MAX_PATCH_SIZE) {
    return {
      error: `Patch is too large (${patch.length} chars). Maximum is ${MAX_PATCH_SIZE} chars — split it into smaller, more targeted patches.`,
    };
  }

  const gitError = gitRepoError();
  if (gitError) {
    return gitError;
  }

  const targetPaths = extractPatchTargetPaths(patch);
  if (targetPaths.length === 0) {
    return {
      error: "Could not find any '--- a/<path>' / '+++ b/<path>' headers in the patch. Provide a standard unified diff.",
    };
  }

  const resolvedPaths: string[] = [];
  for (const targetPath of targetPaths) {
    let filePath: string;
    try {
      filePath = safePath(targetPath);
    } catch (exc) {
      return {
        error: `Patch touches an invalid path '${targetPath}': ${exc}`,
      };
    }

    if (isSensitivePath(filePath)) {
      return { error: `Refusing to patch sensitive file: ${targetPath}` };
    }

    resolvedPaths.push(relativePath(filePath));
  }

  if (!confirm) {
    const check = runGit(["apply", "--check", "-"], patch);
    if (check.code !== 0) {
      return {
        error: `Patch does not apply cleanly: ${check.stderr.trim() || check.stdout.trim()}`,
      };
    }

    return {
      requires_confirmation: true,
      files: resolvedPaths,
      message: `This patch was NOT applied. It would modify: ${resolvedPaths.join(", ")}. Show the user the patch and ask them to explicitly confirm it, then call apply_patch again with confirm=true.`,
    };
  }

  const applied = runGit(["apply", "-"], patch);
  if (applied.code !== 0) {
    return {
      error: `Failed to apply patch: ${applied.stderr.trim() || applied.stdout.trim()}`,
    };
  }

  return { files: resolvedPaths, applied: true };
}

export function delete_file(relPath: string, confirm = false): Record<string, unknown> {
  let filePath: string;
  try {
    filePath = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (isSensitivePath(filePath)) {
    return { error: `Refusing to delete sensitive file: ${relPath}` };
  }

  if (filePath === getProjectRoot()) {
    return { error: "Refusing to delete the project root." };
  }

  if (!fs.existsSync(filePath)) {
    return { error: `File does not exist: ${relPath}` };
  }

  if (fs.statSync(filePath).isDirectory()) {
    return {
      error: "delete_file can only delete a single file, not a directory.",
    };
  }

  if (!confirm) {
    return {
      requires_confirmation: true,
      path: relativePath(filePath),
      message: `'${relPath}' was NOT deleted. Ask the user to explicitly confirm this deletion in the chat, then call delete_file again with confirm=true.`,
    };
  }

  try {
    unlinkFile(filePath);
  } catch (exc) {
    return { error: `Could not delete file: ${exc}` };
  }

  return { path: relativePath(filePath), deleted: true };
}

export function git_add(relPath: string, confirm = false): Record<string, unknown> {
  let filePath: string;
  try {
    filePath = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (isSensitivePath(filePath)) {
    return { error: `Refusing to stage sensitive file: ${relPath}` };
  }

  const gitError = gitRepoError();
  if (gitError) {
    return gitError;
  }

  if (!fs.existsSync(filePath)) {
    return { error: `File does not exist: ${relPath}` };
  }

  if (fs.statSync(filePath).isDirectory()) {
    return { error: "git_add can only stage a single file, not a directory." };
  }

  const rel = relativePath(filePath);

  if (!confirm) {
    return {
      requires_confirmation: true,
      path: rel,
      message: `'${rel}' was NOT staged. Show the user what would be staged and ask them to explicitly confirm it, then call git_add again with confirm=true.`,
    };
  }

  const result = runGit(["add", "--", rel]);
  if (result.code !== 0) {
    return {
      error: `git add failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }

  return { path: rel, staged: true };
}

function extractPatchTargetPaths(patchText: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const line of patchText.split("\n")) {
    for (const prefix of ["+++ b/", "--- a/", "+++ ", "--- "]) {
      if (line.startsWith(prefix)) {
        const candidate = line.slice(prefix.length).split("\t")[0].trim();
        if (candidate && candidate !== "/dev/null" && !seen.has(candidate)) {
          seen.add(candidate);
          paths.push(candidate);
        }
        break;
      }
    }
  }

  return paths;
}

function generateUnifiedDiff(
  oldText: string,
  newText: string,
  fromfile: string,
  tofile: string
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const diff: string[] = [];
  diff.push(`--- ${fromfile}`);
  diff.push(`+++ ${tofile}`);

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      diff.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else {
      const oldRemaining = oldLines.slice(i);
      const newRemaining = newLines.slice(j);

      const oldNext = oldRemaining.findIndex((l) => newRemaining.includes(l));
      const newNext = newRemaining.findIndex((l) => oldRemaining.includes(l));

      if (oldNext === -1 && newNext === -1) {
        while (i < oldLines.length) {
          diff.push(`-${oldLines[i]}`);
          i++;
        }
        while (j < newLines.length) {
          diff.push(`+${newLines[j]}`);
          j++;
        }
        break;
      }

      const oldMatch = oldNext === -1 ? oldLines.length : i + oldNext;
      const newMatch = newNext === -1 ? newLines.length : j + newNext;

      while (i < oldMatch) {
        diff.push(`-${oldLines[i]}`);
        i++;
      }
      while (j < newMatch) {
        diff.push(`+${newLines[j]}`);
        j++;
      }
    }
  }

  return diff.join("\n");
}
