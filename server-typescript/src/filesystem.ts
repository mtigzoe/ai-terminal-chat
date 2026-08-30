import fs from "node:fs";
import path from "node:path";
import {
  getAllowedReadPaths,
  getProjectRoot,
  isSensitiveFilename,
  isSensitivePath,
  requireReadAllowed,
  safePath,
} from "./security.ts";

const MAX_FILE_SIZE = 200_000;

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

export function listFiles(relPath = "."): Record<string, unknown> {
  let directory: string;
  try {
    directory = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (!fs.existsSync(directory)) {
    return { error: `Path does not exist: ${relPath}` };
  }
  if (!fs.statSync(directory).isDirectory()) {
    return { error: `Not a directory: ${relPath}` };
  }

  const entries: { name: string; type: string }[] = [];
  const items = fs.readdirSync(directory, { withFileTypes: true });
  const allowed = getAllowedReadPaths();
  const directoryRelative = path.relative(getProjectRoot(), directory).split(path.sep).join("/");

  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (allowed !== undefined) {
      const itemRelative = directoryRelative
        ? `${directoryRelative}/${item.name}`
        : item.name;
      if (item.isDirectory()) {
        const prefix = `${itemRelative}/`;
        if (![...allowed].some((candidate) => candidate === itemRelative || candidate.startsWith(prefix))) {
          continue;
        }
      } else if (!allowed.has(itemRelative)) {
        continue;
      }
    }

    entries.push({
      name: item.name,
      type: item.isDirectory() ? "directory" : "file",
    });
  }

  return {
    path: path.relative(getProjectRoot(), directory),
    entries,
  };
}

export function readFile(relPath: string): Record<string, unknown> {
  let filePath: string;
  try {
    filePath = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (isSensitivePath(filePath)) {
    return {
      error: `Refusing to read '${relPath}': it looks like a secrets/credentials file.`,
    };
  }

  try {
    requireReadAllowed(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (!fs.existsSync(filePath)) {
    return { error: `File does not exist: ${relPath}` };
  }
  if (!fs.statSync(filePath).isFile()) {
    return { error: `Not a file: ${relPath}` };
  }

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return {
      error: `File is too large to read. Maximum size is ${MAX_FILE_SIZE} bytes.`,
    };
  }

  try {
    const contents = fs.readFileSync(filePath, "utf-8");
    return {
      path: path.relative(getProjectRoot(), filePath),
      contents,
    };
  } catch {
    return { error: "The file is not a UTF-8 text file." };
  }
}

export function searchFiles(
  query: string,
  relPath = "."
): Record<string, unknown> {
  if (!query || !query.trim()) {
    return { error: "A non-empty search query is required." };
  }

  let directory: string;
  try {
    directory = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (!fs.existsSync(directory)) {
    return { error: `Path does not exist: ${relPath}` };
  }
  if (!fs.statSync(directory).isDirectory()) {
    return { error: `Not a directory: ${relPath}` };
  }

  const maxMatches = 200;
  const maxFileSize = 500_000;
  const queryLower = query.toLowerCase();
  const matches: { path: string; line: number; text: string }[] = [];
  let truncated = false;

  function walk(dir: string): void {
    if (truncated) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs: string[] = [];
    const files: fs.Dirent[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else {
        files.push(entry);
      }
    }

    for (const d of dirs.sort()) {
      if (!SEARCH_EXCLUDED_DIR_NAMES.has(d)) {
        const childPath = path.join(dir, d);
        if (getAllowedReadPaths() !== undefined) {
          const childRelative = path.relative(getProjectRoot(), childPath).split(path.sep).join("/");
          const prefix = `${childRelative}/`;
          const allowed = getAllowedReadPaths()!;
          if (![...allowed].some((candidate) => candidate === childRelative || candidate.startsWith(prefix))) {
            continue;
          }
        }
        walk(childPath);
      }
    }

    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) break;
      if (isSensitiveFilename(file.name)) continue;

      const filePath = path.join(dir, file.name);
      const fileRelative = path.relative(getProjectRoot(), filePath).split(path.sep).join("/");
      const allowed = getAllowedReadPaths();
      if (allowed !== undefined && !allowed.has(fileRelative)) continue;

      let fileSize = 0;
      try {
        fileSize = fs.statSync(filePath).size;
      } catch {
        continue;
      }
      if (fileSize > maxFileSize) continue;

      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      for (const [lineNumber, line] of text.split("\n").entries()) {
        if (truncated) break;
        if (line.toLowerCase().includes(queryLower)) {
          matches.push({
            path: path.relative(getProjectRoot(), filePath),
            line: lineNumber + 1,
            text: line.trim().slice(0, 300),
          });
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }
    }
  }

  walk(directory);

  return {
    query,
    path: path.relative(getProjectRoot(), directory),
    matches,
    truncated,
  };
}
