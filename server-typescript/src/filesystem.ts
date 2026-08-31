// Project-scoped filesystem operations.
//
// Reference: server-python/tools.py, "Filesystem tools" section
// (list_files, read_file, search_files) and the corresponding tests in
// server-python/tests/test_tools.py (safe_path/is_sensitive_path regression
// tests) — there is no dedicated Python unit-test file for these three
// functions' own normal-path behavior (size limits, sorting, walk
// exclusions); they're only exercised indirectly through agent/provider
// mocks elsewhere in the Python test suite. The tests added here
// (filesystem.test.ts) are therefore written directly against tools.py's
// implementation as the specification, not just against existing pytest
// coverage — see the Phase 2 report for details.
//
// Every function here returns either a success payload or `{ error }`,
// matching the ToolResult shapes in types.ts, so these can be wired
// directly into the tool registry in tools.ts (Phase 5) without adaptation.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

import { getProjectRoot, isSensitiveFilename, isSensitivePath, safePath } from "./security.js";
import type {
  FileEntry,
  ListFilesResult,
  ReadFileResult,
  SearchFilesResult,
  SearchMatch,
} from "./types.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "." for the project root itself, otherwise the path relative to it — mirrors `str(p.relative_to(PROJECT_ROOT))`, which pathlib renders as "." for the root. */
function relativeToProjectRoot(absolutePath: string): string {
  const root = getProjectRoot();
  return relative(root, absolutePath) || ".";
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

const localeAwareCompare = (a: string, b: string): number => {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al < bl) return -1;
  if (al > bl) return 1;
  return 0;
};

/**
 * List files and directories inside the application project.
 *
 * @param inputPath Relative directory path inside the project. "." for the project root.
 */
export function listFiles(inputPath = "."): ListFilesResult {
  let directory: string;
  try {
    directory = safePath(inputPath);
  } catch (err) {
    return { error: errorMessage(err) };
  }

  if (!existsSync(directory)) {
    return { error: `Path does not exist: ${inputPath}` };
  }
  if (!statSync(directory).isDirectory()) {
    return { error: `Not a directory: ${inputPath}` };
  }

  const entries: FileEntry[] = readdirSync(directory, { withFileTypes: true })
    .map((dirent): FileEntry => {
      // Python's Path.is_dir() follows symlinks; fs.Dirent.isDirectory()
      // does not. stat() through the symlink to match — falling back to
      // the non-dereferencing dirent type (i.e. "file") for a broken
      // symlink, which is also what Python's is_dir() reports for one.
      let isDirectory: boolean;
      try {
        isDirectory = statSync(join(directory, dirent.name)).isDirectory();
      } catch {
        isDirectory = dirent.isDirectory();
      }
      return { name: dirent.name, type: isDirectory ? "directory" : "file" };
    })
    .sort((a, b) => localeAwareCompare(a.name, b.name));

  return { path: relativeToProjectRoot(directory), entries };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const READ_FILE_MAX_BYTES = 200_000;

/**
 * Read a UTF-8 text file inside the application project.
 *
 * @param inputPath Relative path to the text file.
 */
export function readFile(inputPath: string): ReadFileResult {
  let filePath: string;
  try {
    filePath = safePath(inputPath);
  } catch (err) {
    return { error: errorMessage(err) };
  }

  if (isSensitivePath(filePath)) {
    return {
      error:
        `Refusing to read '${inputPath}': it looks like a secrets/` +
        `credentials file (e.g. .env). Its contents are never ` +
        `exposed to the model.`,
    };
  }

  if (!existsSync(filePath)) {
    return { error: `File does not exist: ${inputPath}` };
  }
  if (!statSync(filePath).isFile()) {
    return { error: `Not a file: ${inputPath}` };
  }
  if (statSync(filePath).size > READ_FILE_MAX_BYTES) {
    return {
      error: `File is too large to read. Maximum size is ${READ_FILE_MAX_BYTES} bytes.`,
    };
  }

  let contents: string;
  try {
    const buffer = readFileSync(filePath);
    // { fatal: true } makes TextDecoder throw on invalid byte sequences,
    // matching Python's str.decode()/read_text() strict-by-default
    // behavior (Node's Buffer#toString("utf8") would silently substitute
    // U+FFFD instead, which is not the behavior being preserved here).
    contents = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { error: "The file is not a UTF-8 text file." };
  }

  return { path: relativeToProjectRoot(filePath), contents };
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

// Directories that are never worth searching (build output, deps, VCS
// internals) — matches SEARCH_EXCLUDED_DIR_NAMES in tools.py exactly.
const SEARCH_EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  ".next",
  ".pytest_cache",
  ".mypy_cache",
]);

const SEARCH_MAX_FILE_BYTES = 500_000;
const SEARCH_MAX_MATCHES = 200;

interface WalkPlan {
  subdirs: string[];
  files: string[];
}

/**
 * Classify one directory's entries the way Python's `os.walk` does under
 * its default `followlinks=False`: a symlink pointing at a directory is
 * recognized as a directory (by following it once to check) but is never
 * descended into; a symlink pointing at a file is treated as a file and
 * read through normally. Verified empirically against server-python:
 * `search_files` finds zero matches for content that exists only behind a
 * symlinked directory inside the project. Plain (non-symlink) entries use
 * the cheap non-dereferencing dirent check.
 */
function planWalk(dir: string, dirents: Dirent[]): WalkPlan {
  const subdirs: string[] = [];
  const files: string[] = [];

  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) {
      let isDirectory: boolean;
      try {
        isDirectory = statSync(join(dir, dirent.name)).isDirectory();
      } catch {
        continue; // Broken symlink — skip, matching a stat/read failure being skipped below.
      }
      if (isDirectory) {
        continue; // Classified as a directory, but never descended into.
      }
      files.push(dirent.name);
      continue;
    }
    if (dirent.isDirectory()) {
      if (!SEARCH_EXCLUDED_DIR_NAMES.has(dirent.name)) {
        subdirs.push(dirent.name);
      }
      continue;
    }
    if (dirent.isFile()) {
      files.push(dirent.name);
    }
  }

  subdirs.sort();
  files.sort();
  return { subdirs, files };
}

/**
 * Search text files inside the project for a query string.
 *
 * @param query Text to search for (case-insensitive substring match).
 * @param inputPath Relative directory to search under. "." for the whole project.
 */
export function searchFiles(query: string, inputPath = "."): SearchFilesResult {
  if (!query || !query.trim()) {
    return { error: "A non-empty search query is required." };
  }

  let directory: string;
  try {
    directory = safePath(inputPath);
  } catch (err) {
    return { error: errorMessage(err) };
  }

  if (!existsSync(directory)) {
    return { error: `Path does not exist: ${inputPath}` };
  }
  if (!statSync(directory).isDirectory()) {
    return { error: `Not a directory: ${inputPath}` };
  }

  const root = getProjectRoot();
  const queryLower = query.toLowerCase();
  const matches: SearchMatch[] = [];
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;

    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory — skip, matching os.walk's default of ignoring errors.
    }

    const { subdirs, files } = planWalk(dir, dirents);

    for (const filename of files) {
      if (truncated) return;
      if (isSensitiveFilename(filename)) continue;

      const filePath = join(dir, filename);
      let size: number;
      try {
        size = statSync(filePath).size;
      } catch {
        continue;
      }
      if (size > SEARCH_MAX_FILE_BYTES) continue;

      let text: string;
      try {
        const buffer = readFileSync(filePath);
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        continue; // Binary or unreadable — skip, matching Python's (UnicodeDecodeError, OSError) catch.
      }

      const lines = text.split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (!line.toLowerCase().includes(queryLower)) continue;

        matches.push({
          path: relative(root, filePath),
          line: i + 1,
          text: line.trim().slice(0, 300),
        });

        if (matches.length >= SEARCH_MAX_MATCHES) {
          truncated = true;
          break;
        }
      }
    }

    if (truncated) return;

    for (const name of subdirs) {
      walk(join(dir, name));
      if (truncated) return;
    }
  };

  walk(directory);

  return {
    query,
    path: relativeToProjectRoot(directory),
    matches,
    truncated,
  };
}
