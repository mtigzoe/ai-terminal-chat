import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { getProjectRoot, isSensitivePath, isPathWithinRoot, safePath, writeFileWithinProject, unlinkWithinProject, readFileWithinProject, SecurityValidationError } from "./security.ts";
import { getGitSshCommand } from "./git.ts";
import { resolveTrustedExecutable } from "./trusted-exec.ts";

const PREVIEW_CHAR_LIMIT = 2000;
const MAX_PATCH_SIZE = 200_000;
const GIT_TIMEOUT = 15;

/**
 * Same defense-in-depth -c overrides used by git.ts so repository-local
 * configuration cannot supply command-executing settings.
 */
const GIT_CONFIG_OVERRIDES: string[] = [
  "-c", "core.hooksPath=",
  "-c", "core.fsmonitor=",
  "-c", "core.fsmonitorHook=",
  "-c", "merge.*.command=",
  "-c", "merge.*.driver=",
  "-c", "gpg.program=",
  "-c", "sendemail.smtpserver=",
  "-c", "sendemail.smtpencryption=",
  "-c", "sendemail.smtpuser=",
  "-c", "sendemail.smtppass=",
  "-c", "sendemail.smtpdomain=",
  "-c", "http.extraHeader=",
  "-c", "http.proxy=",
  "-c", "http.postBuffer=",
  "-c", "credential.helper=",
  "-c", "core.gitProxy=none",
];

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

/**
 * Run Git with the same isolation boundary as git.ts:
 * empty GIT_CONFIG, disabled system/global config, SSH isolation,
 * and -c overrides that neutralize command-executing settings.
 */
function runGit(
  args: string[],
  input?: string
): { code: number; stdout: string; stderr: string } {
  const isolationDir = fs.mkdtempSync(path.join(tmpdir(), "git-isolation-"));
  const emptyConfigPath = path.join(isolationDir, "config");
  fs.writeFileSync(emptyConfigPath, "", { encoding: "utf8", mode: 0o600 });

  try {
    const safeArgs = [...GIT_CONFIG_OVERRIDES, ...args];
    const result = spawnSync(resolveTrustedExecutable("git", { projectRoot: getProjectRoot() }), safeArgs, {
      cwd: getProjectRoot(),
      encoding: "utf-8",
      timeout: GIT_TIMEOUT * 1000,
      stdio: ["pipe", "pipe", "pipe"],
      input,
      shell: false,
      windowsHide: true,
      env: (() => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.GIT_EXTERNAL_DIFF;
        delete env.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE;
        return {
          ...env,
          GIT_CONFIG: emptyConfigPath,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GIT_SSH_COMMAND: getGitSshCommand(),
          GIT_PROXY_COMMAND: "none",
        };
      })(),
    });
    return {
      code: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch {
    return { code: 1, stdout: "", stderr: "git command failed" };
  } finally {
    try {
      fs.rmSync(isolationDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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
    const { resolvedPath, bytesWritten } = writeFileWithinProject(relPath, contents, {
      exclusive: true,
    });
    return {
      path: relativePath(resolvedPath),
      created: true,
      bytes_written: bytesWritten,
    };
  } catch (exc) {
    if (exc instanceof SecurityValidationError) {
      return { error: exc.message };
    }
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { error: `File already exists: ${relPath}` };
    }
    return { error: `Could not create file: ${exc}` };
  }
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
        // O_NOFOLLOW fd read — do not follow a final-component symlink to
        // an outside file when building the confirmation diff.
        oldText = readFileWithinProject(relPath, PREVIEW_CHAR_LIMIT * 4).contents;
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
    const { resolvedPath, bytesWritten } = writeFileWithinProject(relPath, contents, {
      exclusive: false,
    });
    return {
      path: relativePath(resolvedPath),
      overwritten: existed,
      bytes_written: bytesWritten,
    };
  } catch (exc) {
    if (exc instanceof SecurityValidationError) {
      return { error: exc.message };
    }
    return { error: `Could not write file: ${exc}` };
  }
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

  try {
    assertPatchTargetsNotOutsideSymlinks(resolvedPaths);
  } catch (exc) {
    return {
      error: exc instanceof Error ? exc.message : String(exc),
    };
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

  try {
    assertPatchTargetsNotOutsideSymlinks(resolvedPaths);
  } catch (exc) {
    return {
      error: exc instanceof Error ? exc.message : String(exc),
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
    const { resolvedPath } = unlinkWithinProject(relPath);
    return { path: relativePath(resolvedPath), deleted: true };
  } catch (exc) {
    if (exc instanceof SecurityValidationError) {
      return { error: exc.message };
    }
    return { error: `Could not delete file: ${exc}` };
  }
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

  const add = (raw: string) => {
    let candidate = raw.split("\t")[0].trim();
    // Strip optional git path quotes: "foo bar.txt"
    if (
      candidate.length >= 2 &&
      ((candidate.startsWith('"') && candidate.endsWith('"')) ||
        (candidate.startsWith("'") && candidate.endsWith("'")))
    ) {
      candidate = candidate.slice(1, -1);
    }
    if (!candidate || candidate === "/dev/null") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    paths.push(candidate);
  };

  for (const line of patchText.split("\n")) {
    // diff --git a/<path> b/<path> (unquoted paths without spaces)
    const diffGit = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffGit) {
      add(diffGit[1] ?? "");
      add(diffGit[2] ?? "");
      continue;
    }

    for (const prefix of ["+++ b/", "--- a/", "+++ ", "--- "]) {
      if (line.startsWith(prefix)) {
        add(line.slice(prefix.length));
        break;
      }
    }
  }

  return paths;
}

/**
 * Refuse patch targets that are final-component symlinks/junctions pointing
 * outside the project. Closes a TOCTOU class where safePath passed, then
 * `git apply` followed a replaced symlink to an outside file.
 */
function assertPatchTargetsNotOutsideSymlinks(relPaths: string[]): void {
  const root = getProjectRoot();
  for (const rel of relPaths) {
    let abs: string;
    try {
      abs = safePath(rel);
    } catch (exc) {
      throw new SecurityValidationError(
        `Patch touches an invalid path '${rel}': ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
    if (!fs.existsSync(abs)) {
      // New file: ensure parent stays inside the project.
      const parent = path.dirname(abs);
      if (fs.existsSync(parent)) {
        let parentReal: string;
        try {
          parentReal = fs.realpathSync(parent);
        } catch {
          throw new SecurityValidationError(
            `Patch parent path is not accessible: ${rel}`,
          );
        }
        if (!isPathWithinRoot(root, parentReal)) {
          throw new SecurityValidationError(
            `Patch would write outside the project via parent path: ${rel}`,
          );
        }
      }
      continue;
    }
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        const target = fs.realpathSync(abs);
        if (!isPathWithinRoot(root, target)) {
          throw new SecurityValidationError(
            `Refusing to patch symlink that points outside the project: ${rel}`,
          );
        }
      } else {
        const target = fs.realpathSync(abs);
        if (!isPathWithinRoot(root, target)) {
          throw new SecurityValidationError(
            `Refusing to patch path outside the project: ${rel}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof SecurityValidationError) throw err;
      throw new SecurityValidationError(
        `Could not verify patch target '${rel}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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

  const oldCount = oldLines.length;
  const newCount = newLines.length;

  let oldIndex = 1;
  let newIndex = 1;

  let i = 0;
  let j = 0;

  while (i < oldCount || j < newCount) {
    while (
      i < oldCount &&
      j < newCount &&
      oldLines[i] === newLines[j]
    ) {
      i++;
      j++;
    }

    const oldRemaining = oldCount - i;
    const newRemaining = newCount - j;

    if (oldRemaining === 0 && newRemaining === 0) {
      break;
    }

    let oldMatch = oldCount;
    let newMatch = newCount;

    if (oldRemaining > 0 && newRemaining > 0) {
      for (let k = 1; k <= Math.min(oldRemaining, newRemaining); k++) {
        if (oldLines[i + k - 1] === newLines[j + k - 1]) {
          oldMatch = i + k - 1;
          newMatch = j + k - 1;
          break;
        }
      }
    } else if (oldRemaining > 0) {
      for (let k = 1; k <= oldRemaining; k++) {
        if (oldLines[i + k - 1] === newLines[j + newRemaining - 1]) {
          oldMatch = i + k - 1;
          newMatch = j + newRemaining - 1;
          break;
        }
      }
    } else if (newRemaining > 0) {
      for (let k = 1; k <= newRemaining; k++) {
        if (oldLines[i + oldRemaining - 1] === newLines[j + k - 1]) {
          oldMatch = i + oldRemaining - 1;
          newMatch = j + k - 1;
          break;
        }
      }
    }

    const hunkOldStart = oldIndex + (oldMatch - i);
    const hunkOldCount = Math.max(0, oldMatch - i);
    const hunkNewStart = newIndex + (newMatch - j);
    const hunkNewCount = Math.max(0, newMatch - j);

    diff.push(
      `@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`
    );

    for (let k = i; k < oldMatch; k++) {
      diff.push(`-${oldLines[k]}`);
    }
    for (let k = j; k < newMatch; k++) {
      diff.push(`+${newLines[k]}`);
    }

    oldIndex = hunkOldStart + hunkOldCount;
    newIndex = hunkNewStart + hunkNewCount;
    i = oldMatch;
    j = newMatch;
  }

  return diff.join("\n");
}
