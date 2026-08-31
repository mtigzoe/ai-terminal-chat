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

import {
  getAllowedReadPaths,
  getProjectRoot,
  isSensitiveFilename,
  isSensitivePath,
  requireReadAllowed,
  safePath,
} from "./security.js";
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

function relativeToProjectRoot(absolutePath: string): string {
  const root = getProjectRoot();
  return relative(root, absolutePath) || ".";
}

function allowedPathFor(absolutePath: string): string {
  return relative(getProjectRoot(), absolutePath).split("\\").join("/");
}

/** True when an agent may see this path, including a directory containing a selected file. */
function isListedPathAllowed(absolutePath: string, isDirectory: boolean): boolean {
  const allowed = getAllowedReadPaths();
  if (allowed === undefined) return true;

  const itemRelative = allowedPathFor(absolutePath);
  if (!isDirectory) return allowed.has(itemRelative);

  const prefix = `${itemRelative}/`;
  return [...allowed].some(
    (candidate) => candidate === itemRelative || candidate.startsWith(prefix),
  );
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
    .map((dirent): FileEntry | null => {
      let isDirectory: boolean;
      try {
        isDirectory = statSync(join(directory, dirent.name)).isDirectory();
      } catch {
        isDirectory = dirent.isDirectory();
      }

      const absolutePath = join(directory, dirent.name);
      if (!isListedPathAllowed(absolutePath, isDirectory)) return null;

      return { name: dirent.name, type: isDirectory ? "directory" : "file" };
    })
    .filter((entry): entry is FileEntry => entry !== null)
    .sort((a, b) => localeAwareCompare(a.name, b.name));

  return { path: relativeToProjectRoot(directory), entries };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const READ_FILE_MAX_BYTES = 200_000;

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

  try {
    requireReadAllowed(inputPath);
  } catch (err) {
    return { error: errorMessage(err) };
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
    contents = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { error: "The file is not a UTF-8 text file." };
  }

  return { path: relativeToProjectRoot(filePath), contents };
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

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

function planWalk(dir: string, dirents: Dirent[]): WalkPlan {
  const subdirs: string[] = [];
  const files: string[] = [];

  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) {
      let isDirectory: boolean;
      try {
        isDirectory = statSync(join(dir, dirent.name)).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) continue;
      files.push(dirent.name);
      continue;
    }
    if (dirent.isDirectory()) {
      if (!SEARCH_EXCLUDED_DIR_NAMES.has(dirent.name)) {
        subdirs.push(dirent.name);
      }
      continue;
    }
    if (dirent.isFile()) files.push(dirent.name);
  }

  subdirs.sort();
  files.sort();
  return { subdirs, files };
}

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
      return;
    }

    const { subdirs, files } = planWalk(dir, dirents);

    for (const filename of files) {
      if (truncated) return;
      if (isSensitiveFilename(filename)) continue;

      const filePath = join(dir, filename);
      if (!isListedPathAllowed(filePath, false)) continue;

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
        continue;
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
      const childPath = join(dir, name);
      if (!isListedPathAllowed(childPath, true)) continue;
      walk(childPath);
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
