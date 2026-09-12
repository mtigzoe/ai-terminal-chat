/**
 * Resolve allowlisted tool executables from PATH only — never from the
 * process current directory or the project root.
 *
 * On Windows, CreateProcess searches the application directory and the
 * current working directory before PATH when given a bare name. Because
 * terminal and Git commands use the project root as cwd, a repository
 * that ships `npm.cmd` / `python.exe` / `git.exe` would otherwise hijack
 * allowlisted commands. Resolving an absolute path outside the project
 * root before spawn closes that boundary.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { isPathWithinRoot } from "./security.ts";

export class TrustedExecutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedExecutableError";
  }
}

function looksLikePath(name: string): boolean {
  return (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    /^[a-zA-Z]:[\\/]/.test(name) ||
    name.startsWith("\\\\")
  );
}

function windowsExtensions(): string[] {
  const raw = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
}

function pathDirectories(): string[] {
  const pathEnv = process.env.Path || process.env.PATH || "";
  const pathDelimiter = process.platform === "win32" ? ";" : delimiter;
  return pathEnv.split(pathDelimiter).map((dir) => dir.trim()).filter(Boolean);
}

function tryResolveFile(candidate: string): string | null {
  try {
    if (!existsSync(candidate)) return null;
    const st = statSync(candidate);
    // Accept regular files and symlink-to-file targets.
    if (!st.isFile() && !st.isSymbolicLink()) return null;
    try {
      return realpathSync(candidate);
    } catch {
      return resolve(candidate);
    }
  } catch {
    return null;
  }
}

/**
 * Resolve `commandName` to an absolute path using PATH (and PATHEXT on
 * Windows) only. Never searches the current working directory.
 *
 * When `projectRoot` is provided, candidates that resolve inside the
 * project are skipped so a malicious repo cannot win the search.
 */
export function resolveTrustedExecutable(
  commandName: string,
  options: { projectRoot?: string | null; allowAbsolutePath?: boolean } = {},
): string {
  const name = (commandName ?? "").trim();
  if (!name) {
    throw new TrustedExecutableError("Executable name is required.");
  }

  let pathQualifiedName: string | null = null;
  if (looksLikePath(name)) {
    if (!options.allowAbsolutePath) {
      throw new TrustedExecutableError(
        `Refusing path-qualified executable '${name}'. Use a bare command name from PATH.`,
      );
    }
    pathQualifiedName = name;
  }

  let projectRootResolved: string | null = null;
  if (options.projectRoot) {
    try {
      projectRootResolved = realpathSync(options.projectRoot);
    } catch {
      projectRootResolved = resolve(options.projectRoot);
    }
  }

  if (pathQualifiedName) {
    const resolved = tryResolveFile(pathQualifiedName);
    if (!resolved) {
      throw new TrustedExecutableError(`Executable '${pathQualifiedName}' does not exist.`);
    }
    if (projectRootResolved && isPathWithinRoot(projectRootResolved, resolved)) {
      throw new TrustedExecutableError(`Executable '${pathQualifiedName}' resolves inside the project root.`);
    }
    return resolved;
  }

  const dirs = pathDirectories();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const exts = windowsExtensions();
    const lower = name.toLowerCase();
    const hasExt = exts.some((ext) => lower.endsWith(ext.toLowerCase()));
    for (const dir of dirs) {
      if (hasExt) {
        candidates.push(join(dir, name));
      } else {
        // Prefer PATHEXT order (CreateProcess behavior for bare names).
        for (const ext of exts) {
          candidates.push(join(dir, name + ext));
        }
        // Also try the bare name (e.g. extension-less scripts on PATH).
        candidates.push(join(dir, name));
      }
    }
  } else {
    for (const dir of dirs) {
      candidates.push(join(dir, name));
    }
  }

  for (const candidate of candidates) {
    const resolved = tryResolveFile(candidate);
    if (!resolved) continue;

    if (projectRootResolved && isPathWithinRoot(projectRootResolved, resolved)) {
      // Project-local executable — treat as untrusted hijack candidate.
      continue;
    }

    return resolved;
  }

  throw new TrustedExecutableError(
    `${name} is not installed or not on PATH outside the project root.`,
  );
}

/** Test helper: expose path-like detection. */
export function __looksLikePathForTests(name: string): boolean {
  return looksLikePath(name);
}
