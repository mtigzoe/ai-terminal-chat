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

/**
 * Apply a unified diff entirely through race-resistant project I/O.
 * Does not invoke `git apply`, so a symlink/junction replacement between
 * validation and write cannot redirect Git's path-based open.
 *
 * Supported: text unified diffs for existing files, new files (--- /dev/null),
 * and deletions (+++ /dev/null). Binary patches and rename headers are rejected.
 */
function applyUnifiedDiffSecure(
  patchText: string,
  dryRun: boolean,
): { files: string[]; error?: string } {
  const files = extractPatchTargetPaths(patchText);
  if (files.length === 0) {
    return {
      files: [],
      error:
        "Could not find any '--- a/<path>' / '+++ b/<path>' headers in the patch. Provide a standard unified diff.",
    };
  }

  // Reject binary / rename-only patches we do not implement.
  if (/^delta \d+/m.test(patchText) || /^GIT binary patch/m.test(patchText)) {
    return { files: [], error: "Binary patches are not supported by apply_patch." };
  }
  if (/^rename from /m.test(patchText) || /^copy from /m.test(patchText)) {
    return {
      files: [],
      error: "Rename/copy patches are not supported; use write_file/delete_file instead.",
    };
  }

  const resolvedRel: string[] = [];
  for (const targetPath of files) {
    let filePath: string;
    try {
      filePath = safePath(targetPath);
    } catch (exc) {
      return {
        files: [],
        error: `Patch touches an invalid path '${targetPath}': ${exc}`,
      };
    }
    if (isSensitivePath(filePath)) {
      return { files: [], error: `Refusing to patch sensitive file: ${targetPath}` };
    }
    resolvedRel.push(relativePath(filePath));
  }

  try {
    assertPatchTargetsNotOutsideSymlinks(resolvedRel);
  } catch (exc) {
    return {
      files: [],
      error: exc instanceof Error ? exc.message : String(exc),
    };
  }

  // Parse per-file hunks from the unified diff.
  const filePatches = parseUnifiedDiff(patchText);
  if (filePatches.length === 0) {
    return { files: [], error: "Could not parse any file hunks from the patch." };
  }

  // Dry-run or apply each file through secure read/write.
  for (const fp of filePatches) {
    const rel = fp.newPath === "/dev/null" ? fp.oldPath : fp.newPath;
    if (!rel || rel === "/dev/null") {
      return { files: [], error: "Patch entry missing a usable path." };
    }
    // Validate path again immediately before use.
    try {
      safePath(rel);
    } catch (exc) {
      return { files: [], error: `Invalid path in patch: ${rel}: ${exc}` };
    }

    if (fp.newPath === "/dev/null") {
      // Deletion
      if (dryRun) {
        try {
          readFileWithinProject(rel, MAX_PATCH_SIZE * 2);
        } catch {
          return { files: [], error: `Patch deletes missing file: ${rel}` };
        }
        continue;
      }
      try {
        assertPatchTargetsNotOutsideSymlinks([rel]);
        unlinkWithinProject(rel);
      } catch (exc) {
        return {
          files: [],
          error: `Failed to delete '${rel}': ${exc instanceof Error ? exc.message : String(exc)}`,
        };
      }
      continue;
    }

    let current = "";
    if (fp.oldPath !== "/dev/null") {
      try {
        const read = readFileWithinProject(rel, MAX_PATCH_SIZE * 2);
        current = read.contents;
      } catch (exc) {
        return {
          files: [],
          error: `Cannot read '${rel}' to apply patch: ${exc instanceof Error ? exc.message : String(exc)}`,
        };
      }
    }

    let next: string;
    try {
      next = applyHunksToText(current, fp.hunks);
    } catch (exc) {
      return {
        files: [],
        error: `Patch does not apply cleanly to '${rel}': ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }

    if (dryRun) continue;

    try {
      // Re-check symlink status immediately before the write.
      assertPatchTargetsNotOutsideSymlinks([rel]);
      writeFileWithinProject(rel, next, {});
    } catch (exc) {
      return {
        files: [],
        error: `Failed to write '${rel}': ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  }

  return { files: resolvedRel };
}

type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // including leading ' ', '+', '-'
};

type FilePatch = {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
};

function parseUnifiedDiff(patchText: string): FilePatch[] {
  const result: FilePatch[] = [];
  let current: FilePatch | null = null;
  const lines = patchText.split(/\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const oldHdr = /^--- (?:a\/)?(.+)$/.exec(line);
    if (oldHdr) {
      const oldPath = stripPatchPath(oldHdr[1] ?? "");
      const next = lines[i + 1] ?? "";
      const newHdr = /^\+\+\+ (?:b\/)?(.+)$/.exec(next);
      if (!newHdr) {
        i += 1;
        continue;
      }
      const newPath = stripPatchPath(newHdr[1] ?? "");
      current = { oldPath, newPath, hunks: [] };
      result.push(current);
      i += 2;
      continue;
    }
    const hunkHdr = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHdr && current) {
      const hunk: DiffHunk = {
        oldStart: parseInt(hunkHdr[1]!, 10),
        oldCount: hunkHdr[2] !== undefined ? parseInt(hunkHdr[2], 10) : 1,
        newStart: parseInt(hunkHdr[3]!, 10),
        newCount: hunkHdr[4] !== undefined ? parseInt(hunkHdr[4], 10) : 1,
        lines: [],
      };
      i += 1;
      while (i < lines.length) {
        const hl = lines[i] ?? "";
        if (hl.startsWith("@@ ") || hl.startsWith("diff --git") || hl.startsWith("--- ")) {
          break;
        }
        if (hl.startsWith("\\")) {
          // "\ No newline at end of file"
          i += 1;
          continue;
        }
        if (hl.startsWith(" ") || hl.startsWith("+") || hl.startsWith("-")) {
          hunk.lines.push(hl);
          i += 1;
          continue;
        }
        // Blank line ends the hunk (not context)
        break;
      }
      current.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return result;
}

function stripPatchPath(raw: string): string {
  let candidate = raw.split("\t")[0]!.trim();
  if (
    candidate.length >= 2 &&
    ((candidate.startsWith('"') && candidate.endsWith('"')) ||
      (candidate.startsWith("'") && candidate.endsWith("'")))
  ) {
    candidate = candidate.slice(1, -1);
  }
  return candidate;
}

/**
 * Apply unified-diff hunks to text. Throws if context does not match.
 * Line numbers in hunks are 1-based.
 */
function applyHunksToText(original: string, hunks: DiffHunk[]): string {
  // Preserve whether original ended with newline
  const hadTrailingNewline = original.endsWith("\n");
  const src = original.split("\n");
  // split leaves trailing empty string if ends with \n
  if (hadTrailingNewline && src.length > 0 && src[src.length - 1] === "") {
    src.pop();
  }
  const out: string[] = [];
  let srcIndex = 0; // 0-based

  for (const hunk of hunks) {
    const targetStart = Math.max(0, hunk.oldStart - 1);
    while (srcIndex < targetStart) {
      out.push(src[srcIndex]!);
      srcIndex += 1;
    }
    for (const hl of hunk.lines) {
      const tag = hl.charAt(0);
      const body = hl.slice(1);
      if (tag === " ") {
        if (srcIndex >= src.length || src[srcIndex] !== body) {
          throw new Error(
            `context mismatch at line ${srcIndex + 1}: expected '${body}', got '${src[srcIndex] ?? "<eof>"}'`,
          );
        }
        out.push(body);
        srcIndex += 1;
      } else if (tag === "-") {
        if (srcIndex >= src.length || src[srcIndex] !== body) {
          throw new Error(
            `removal mismatch at line ${srcIndex + 1}: expected '${body}', got '${src[srcIndex] ?? "<eof>"}'`,
          );
        }
        srcIndex += 1;
      } else if (tag === "+") {
        out.push(body);
      }
    }
  }
  while (srcIndex < src.length) {
    out.push(src[srcIndex]!);
    srcIndex += 1;
  }
  if (out.length === 0) return "";
  return out.join("\n") + (hadTrailingNewline || out.length > 0 ? "\n" : "");
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

  // Preview / confirm: dry-run through secure applicator (no git apply).
  const dry = applyUnifiedDiffSecure(patch, true);
  if (dry.error) {
    return { error: dry.error };
  }

  if (!confirm) {
    return {
      requires_confirmation: true,
      files: dry.files,
      message: `This patch was NOT applied. It would modify: ${dry.files.join(", ")}. Show the user the patch and ask them to explicitly confirm it, then call apply_patch again with confirm=true.`,
    };
  }

  const applied = applyUnifiedDiffSecure(patch, false);
  if (applied.error) {
    return { error: applied.error };
  }
  return { files: applied.files, applied: true };
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

function stageFileWithoutFiltersForWriteTool(relativePath: string, absolutePath: string): void {
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let payload: Buffer;
  let mode = "100644";
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("git_add can only stage a single file, not a directory.");
    mode = (st.mode & 0o111) !== 0 ? "100755" : "100644";
    payload = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = fs.readSync(fd, payload, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    if (offset < st.size) payload = payload.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
  const hashed = runGit(["hash-object", "-w", "--stdin", "--no-filters"], payload.toString("utf8"));
  if (hashed.code !== 0) throw new Error(hashed.stderr.trim() || hashed.stdout.trim() || "hash-object failed");
  const oid = hashed.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) throw new Error("Unexpected hash-object output.");
  const updated = runGit(["update-index", "--add", "--cacheinfo", `${mode},${oid},${relativePath}`]);
  if (updated.code !== 0) throw new Error(updated.stderr.trim() || updated.stdout.trim() || "update-index failed");
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

  try {
    stageFileWithoutFiltersForWriteTool(rel, filePath);
  } catch (exc) {
    return { error: `git add failed: ${exc instanceof Error ? exc.message : String(exc)}` };
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
        // Refuse all final-component symlinks: git apply / path opens would
        // follow them, and a replace-after-validate race is a classic TOCTOU.
        throw new SecurityValidationError(
          `Refusing to patch a symbolic link or reparse point: ${rel}`,
        );
      }
      const target = fs.realpathSync(abs);
      if (!isPathWithinRoot(root, target)) {
        throw new SecurityValidationError(
          `Refusing to patch path outside the project: ${rel}`,
        );
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
