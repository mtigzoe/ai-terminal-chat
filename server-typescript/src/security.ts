import { AsyncLocalStorage } from "node:async_hooks";
// Security boundaries, validation, path restrictions, and command safety.
//
// Reference: server-python/security.py, and the security-relevant tests in
// server-python/tests/test_project_root.py and server-python/tests/test_tools.py
// (test_safe_path_*, test_is_sensitive_path_*, test_sensitive_filenames_are_blocked).
//
// Every path-facing tool (filesystem.ts, and later terminal.ts/git.ts/tools.ts)
// goes through safePath()/isSensitivePath() here. Nothing in this module talks
// to any AI provider, so it does not change when providers change - same
// design intent as the Python original.
//
// SECURITY NOTE ON SYMLINKS (verified empirically against server-python,
// not just inferred from source): Python's `Path.resolve()` follows
// symlinks for path segments that exist on disk, so `safe_path()` already
// rejects a symlink inside the project that points outside PROJECT_ROOT -
// confirmed by constructing such a symlink and calling `security.safe_path()`
// against it directly. `path.resolve()` in Node is purely lexical and does
// NOT touch the filesystem or follow symlinks, so a naive port would silently
// drop this protection. `resolveFollowingSymlinks()` below replicates
// Python's behavior: resolve real paths for whatever prefix of the path
// already exists (following symlinks along the way), then lexically append
// any remaining, not-yet-existing path segments - matching
// `Path.resolve(strict=False)` exactly, including the case where the full
// path doesn't exist yet (e.g. a new file about to be created).

import {
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  ftruncateSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  openRelativeToDirFd,
  mkdirRelativeToDirFd,
  WindowsHandlePathError,
} from "./windows-handle-path.ts";
import { basename, dirname, join, posix, relative, resolve, sep, win32 } from "node:path";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A rejected/invalid request - the caller did something not allowed (bad
 * path, missing input). Mirrors Python's `ValueError` here, which app.py
 * maps to HTTP 400. Distinguished from plain `Error` (persistence/filesystem
 * failures, mirroring Python's `OSError`, which app.py maps to HTTP 500) so
 * app.ts (Phase 7) can make the same distinction without string-matching
 * error messages.
 */
export class SecurityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityValidationError";
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** True if `inputPath` is absolute under POSIX *or* Windows rules, regardless
 * of the host OS - matches security.py's use of both PurePosixPath and
 * PureWindowsPath so a Windows-style absolute path (`C:\\...`, `\\\\server\\share\\...`)
 * is rejected even when the backend happens to be running on Linux, and vice versa. */
export function isAbsoluteOnAnyPlatform(inputPath: string): boolean {
  return posix.isAbsolute(inputPath) || win32.isAbsolute(inputPath);
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  // Python's Path.expanduser() also handles "~otheruser"; that form is rare
  // in practice for this app (a locally-run dev tool) and is left
  // unsupported here rather than adding OS-user-lookup complexity.
  return inputPath;
}

/**
 * Resolve `inputPath` to an absolute path, following symlinks for whatever
 * prefix already exists on disk and lexically joining the rest - see the
 * module-level SECURITY NOTE above. Errors other than "this segment doesn't
 * exist" (ENOENT/ENOTDIR) propagate, matching a fail-closed posture.
 */
export function resolveFollowingSymlinks(inputPath: string): string {
  const absolute = resolve(inputPath);
  try {
    return realpathSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw err;
    }
    const parent = dirname(absolute);
    if (parent === absolute) {
      // Reached the filesystem root and even that doesn't resolve -
      // nothing further can be done; return the lexical form.
      return absolute;
    }
    return join(resolveFollowingSymlinks(parent), basename(absolute));
  }
}

/**
 * True if `candidate` is `root` itself or lives under it.
 *
 * `caseInsensitive` defaults to matching the host platform (Windows
 * filesystems are case-insensitive by default; POSIX ones are
 * case-sensitive) but is an explicit parameter so both branches are
 * unit-testable on any single CI platform.
 */
export function isPathWithinRoot(
  root: string,
  candidate: string,
  options: { caseInsensitive?: boolean } = {},
): boolean {
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";
  const normalize = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + sep)
  );
}

// ---------------------------------------------------------------------------
// Project root
// ---------------------------------------------------------------------------

/**
 * Sentinel `path` value requesting the native OS folder picker.
 *
 * server-python's security.py implements this via a Tkinter dialog invoked
 * server-side. client-react never actually sends this sentinel - it uses
 * its own folder picker (Electron's native dialog, or the browser File
 * System Access API in SettingsPage.jsx) and POSTs the resolved path
 * string to /project-root directly. The sentinel is preserved here for
 * API-shape compatibility (some other client could still send it), but
 * setProjectRoot() rejects it with a clear error rather than spawning a
 * server-side native dialog, which has no straightforward, dependency-free
 * Node equivalent and is unused by the current frontend. See the Phase 2
 * report for the full rationale.
 */
export const CHOOSE_PROJECT_ROOT = "__CHOOSE_PROJECT_ROOT__";

let currentProjectRoot: string | null = null;
let configDirOverride: string | null = null;
let configFileOverride: string | null = null;

function configDir(): string {
  return configDirOverride ?? join(homedir(), ".ai-terminal-chat");
}

function configFilePath(): string {
  return configFileOverride ?? join(configDir(), "config.json");
}

/** Return the config file path currently in effect (respects test overrides). */
export function getConfigFile(): string {
  return configFilePath();
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Load the full application configuration file, or an empty object if it
 * doesn't exist, isn't readable, or isn't valid JSON holding an object.
 * Mirrors security.py's `_load_config()`.
 */
function loadConfig(): Record<string, unknown> {
  try {
    const raw = readFileSync(configFilePath(), "utf8");
    const data = JSON.parse(raw) as unknown;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    // Missing file, unreadable, or invalid JSON - start from an empty
    // config, matching Python's `except (OSError, ValueError, TypeError): pass`.
  }
  return {};
}

/**
 * Persist the full configuration object atomically outside the project.
 * Mirrors security.py's `_persist_config()`.
 *
 * Uses a simple file-based lock to prevent concurrent writes from losing
 * updates. The lock is a temporary file created with exclusive creation
 * (via openSync with flag 'wx' on Node 16+). Waits up to 5 seconds
 * with exponential backoff and actual sleep.
 *
 * If the lock cannot be acquired (timeout, EPERM, or other error), the
 * operation fails rather than performing an unsafe unlocked write. This
 * ensures mutual exclusion is never silently bypassed.
 */
/**
 * Synchronous sleep using Atomics.wait on a SharedArrayBuffer.
 * This provides real sleep without busy-spinning the CPU.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Write the config payload to the target file atomically.
 *
 * This function does NOT acquire any locks - the caller must hold the lock.
 * Mirrors the write logic from the internal config persistence functions.
 */
function writeConfigFile(targetFile: string, payload: Record<string, unknown>): void {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const dir = dirname(targetFile);
  const tempPath = join(
    dir,
    `config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, serialized, "utf8");
    // On Windows, renameSync can fail with EPERM if the target is locked
    // by another process (e.g., antivirus). Retry multiple times with
    // increasing delays.
    let renameAttempts = 0;
    const maxRenameAttempts = 5;
    while (true) {
      try {
        renameSync(tempPath, targetFile);
        break;
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code === "EPERM" && renameAttempts < maxRenameAttempts - 1) {
          renameAttempts++;
          sleepSync(50 * renameAttempts); // 50ms, 100ms, 150ms, 200ms
          continue;
        }
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw err;
  }
}

/**
 * Acquire the config file lock.
 *
 * Returns an object with the lock file descriptor and lock path, or throws
 * if the lock cannot be acquired within the timeout.
 */
function acquireConfigLock(targetFile: string): { lockFd: number; lockPath: string } {
  const dir = dirname(targetFile);
  mkdirSync(dir, { recursive: true });

  const configFileName = basename(targetFile).replace(/\.[^.]+$/, "");
  const lockPath = join(dir, `.config.${configFileName}.lock`);
  const maxLockWaitMs = 5000;
  const lockWaitStart = Date.now();
  let lockFd: number | null = null;
  let lockAcquired = false;

  // Try to acquire the lock with exponential backoff and real sleep
  while (Date.now() - lockWaitStart < maxLockWaitMs) {
    try {
      lockFd = openSync(lockPath, "wx");
      lockAcquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const elapsed = Date.now() - lockWaitStart;
        const backoff = Math.min(10 + elapsed * 0.1, 100);
        sleepSync(backoff);
        continue;
      }
      throw err;
    }
  }

  if (!lockAcquired) {
    throw new Error(`Could not acquire config lock for ${configFileName} after ${maxLockWaitMs}ms`);
  }

  return { lockFd: lockFd!, lockPath };
}

/**
 * Release the config file lock.
 */
function releaseConfigLock(lockFd: number, lockPath: string): void {
  try {
    closeSync(lockFd);
  } catch {
    // Ignore
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Ignore lock cleanup errors
  }
}

function loadProjectRootFromDisk(): string {
  const envConfigured = (process.env.AI_TERMINAL_PROJECT_ROOT ?? "").trim();
  if (envConfigured) {
    const candidate = resolveFollowingSymlinks(expandHome(envConfigured));
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
  }

  try {
    const raw = readFileSync(configFilePath(), "utf8");
    const data = JSON.parse(raw) as { project_root?: unknown };
    const configured = String(data.project_root ?? "").trim();
    if (configured) {
      const candidate = resolveFollowingSymlinks(expandHome(configured));
      if (isExistingDirectory(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Missing file, unreadable, or invalid JSON - fall through to cwd,
    // matching Python's `except (OSError, ValueError, TypeError): pass`.
    // (Deliberately not using loadConfig() here: Python's own
    // _load_project_root() still has this same separate inline read
    // rather than being consolidated onto _load_config() - the Allowed
    // Commands change only refactored _persist_project_root(). Keeping
    // this function standalone mirrors that scope exactly.)
  }

  return resolveFollowingSymlinks(process.cwd());
}

/** Return the currently configured absolute project root, loading it on first use. */
export function getProjectRoot(): string {
  if (currentProjectRoot === null) {
    currentProjectRoot = loadProjectRootFromDisk();
  }
  return currentProjectRoot;
}

/**
 * Persist the selected project root atomically outside the project.
 *
 * Merges into any existing configuration file (load, update the one key,
 * write back the whole object) so other keys - e.g. the terminal
 * allowlist persisted by tools.ts (Phase 3) - are preserved. Mirrors
 * security.py's `_persist_project_root()`, which was changed to this
 * load/merge/persist approach by the Allowed Commands feature; this
 * function previously overwrote the file with only `{ project_root }`,
 * which would have silently dropped any other key already saved there.
 */
function persistProjectRoot(root: string): void {
  withConfigLock((config) => {
    config.project_root = root;
  });
}

/**
 * Internal helper to update project_root in a config object without persisting.
 * Used by withConfigLock mutations to avoid double-persistence races.
 */
function setProjectRootInConfig(config: Record<string, unknown>, root: string): void {
  config.project_root = root;
}

/**
 * Internal helper to update the in-memory project root without validation or persistence.
 * Used by withConfigLock mutations after config object has been updated.
 */
export function __setProjectRootInMemory(root: string): void {
  currentProjectRoot = root;
}

/**
 * Validate, persist, and activate a new project root.
 *
 * The configuration file lives under the user's home directory, outside
 * any project, so the filesystem tools (which are confined to
 * PROJECT_ROOT) can never expose or modify it.
 *
 * Throws `SecurityValidationError` for invalid input (empty path, path
 * does not exist, path is not a directory, or the unsupported
 * CHOOSE_PROJECT_ROOT sentinel) and a plain `Error` (from the underlying
 * `node:fs` call) for persistence failures - callers can use
 * `instanceof SecurityValidationError` to tell the two apart, matching
 * Python's ValueError vs. OSError distinction in app.py.
 */
export function setProjectRoot(inputPath: string): string {
  const trimmed = (inputPath ?? "").trim();

  if (trimmed === CHOOSE_PROJECT_ROOT) {
    throw new SecurityValidationError(
      "The native folder picker is not available from this backend over HTTP. " +
        "Choose a folder in the desktop app, or provide the full path directly.",
    );
  }

  if (!trimmed) {
    throw new SecurityValidationError("A project path is required.");
  }

  const candidate = resolveFollowingSymlinks(expandHome(trimmed));

  if (!existsSync(candidate)) {
    throw new SecurityValidationError(`Project path does not exist: ${candidate}`);
  }
  if (!statSync(candidate).isDirectory()) {
    throw new SecurityValidationError(`Project path is not a directory: ${candidate}`);
  }

  persistProjectRoot(candidate);
  currentProjectRoot = candidate;
  return candidate;
}

/**
 * Test-only: directly override the in-memory project root, bypassing
 * validation and persistence. Mirrors
 * `monkeypatch.setattr(security, "PROJECT_ROOT", tmp_path)` in
 * server-python's pytest fixtures. Not for use outside tests - application
 * code should call setProjectRoot() so the change is validated and
 * persisted.
 */
export function __setProjectRootForTests(inputPath: string): void {
  currentProjectRoot = resolve(inputPath);
}

/**
 * Test-only: reset the in-memory project root so the next getProjectRoot()
 * call reloads it from the environment/config file/cwd.
 */
export function __resetProjectRootForTests(): void {
  currentProjectRoot = null;
}

/**
 * Test-only: override where setProjectRoot() persists its config file, so
 * tests never touch the real `~/.ai-terminal-chat/config.json`. Pass `null`
 * to restore the default. Mirrors
 * `monkeypatch.setattr(security, "_CONFIG_DIR", ...)` in
 * server-python/tests/test_project_root.py.
 */
export function __setConfigDirForTests(dir: string | null): void {
  configDirOverride = dir;
}

/**
 * Test-only: override the exact config *file* path used by
 * loadConfig() (and therefore
 * loadProviderSelection()/persistProviderSelection()/getConfigFile()), so
 * tests can redirect config storage to a throwaway temp file instead of the
 * real `~/.ai-terminal-chat/config.json`. Pass `null` to restore the
 * default (configDir()-derived) path. Distinct from
 * `__setConfigDirForTests()`, which only overrides the directory and keeps
 * the `config.json` filename.
 */
export function setConfigFileForTests(file: string | null): void {
  configFileOverride = file;
}

// ---------------------------------------------------------------------------
// safe_path
// ---------------------------------------------------------------------------

/**
 * Resolve a path while keeping it inside the configured project.
 *
 * Rejects absolute paths (POSIX or Windows-style) and any traversal
 * (including via symlinks - see the module-level SECURITY NOTE) that would
 * escape the project root. Throws `SecurityValidationError` on rejection.
 */
export function safePath(inputPath: string): string {
  if (!inputPath || !inputPath.trim()) {
    throw new SecurityValidationError("A path is required.");
  }

  if (isAbsoluteOnAnyPlatform(inputPath)) {
    throw new SecurityValidationError(
      "Absolute paths are not allowed. Use a path relative to the project root.",
    );
  }

  const root = getProjectRoot();
  const requested = resolveFollowingSymlinks(join(root, inputPath));

  if (!isPathWithinRoot(root, requested)) {
    throw new SecurityValidationError("Access outside the project directory is not allowed.");
  }

  return requested;
}

// ---------------------------------------------------------------------------
// Sensitive files
// ---------------------------------------------------------------------------

const SENSITIVE_EXACT_NAMES = new Set([
  ".git-credentials",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
]);
const SENSITIVE_SUFFIXES = [".pem", ".key"];

/** True if a filename looks like it holds secrets/credentials. */
export function isSensitiveFilename(name: string): boolean {
  const lower = name.toLowerCase();

  if (lower.startsWith(".env")) {
    return true;
  }
  if (SENSITIVE_EXACT_NAMES.has(lower)) {
    return true;
  }
  if (SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  if (lower.includes("secret") || lower.includes("credential")) {
    return true;
  }

  return false;
}

/** True if a resolved absolute path is a secret file, lives inside `.git`, or falls outside the project root. */
export function isSensitivePath(filePath: string): boolean {
  const root = getProjectRoot();

  // Mirrors Python's `except ValueError: return True` when
  // `file_path.relative_to(root)` fails - treat anything outside the
  // project root as sensitive, as defense in depth.
  if (!isPathWithinRoot(root, filePath)) {
    return true;
  }

  const relParts = filePath === root ? [] : filePath.slice(root.length + 1).split(sep);
  if (relParts.includes(".git")) {
    return true;
  }

  return isSensitiveFilename(basename(filePath));
}

export interface ProviderSelection {
  provider?: string;
  model?: string;
  ollama_base_url?: string;
}

/** Load persisted provider selection from config.json. */
export function loadProviderSelection(): ProviderSelection {
  const data = loadConfig();
  const out: ProviderSelection = {};

  const provider = data.provider;
  if (typeof provider === "string" && provider.trim()) {
    out.provider = provider.trim().toLowerCase();
  }

  const model = data.model;
  if (typeof model === "string" && model.trim()) {
    out.model = model.trim();
  }

  const ollamaBaseUrl = data.ollama_base_url;
  if (typeof ollamaBaseUrl === "string" && ollamaBaseUrl.trim()) {
    out.ollama_base_url = ollamaBaseUrl.trim();
  }

  return out;
}

/** Persist provider selection to config.json. */
export function persistProviderSelection(
  provider: string,
  model?: string | null,
  ollamaBaseUrl?: string | null,
): void {
  withConfigLock((config) => {
    const normalizedProvider = String(provider).trim().toLowerCase();

    config.provider = normalizedProvider;

    if (model !== undefined && model !== null) {
      const modelS = String(model).trim();
      if (modelS) {
        config.model = modelS;
      } else {
        delete config.model;
      }
    }

    if (ollamaBaseUrl !== undefined && ollamaBaseUrl !== null) {
      let url = String(ollamaBaseUrl).trim();

      if (url) {
        if (!url.includes("://")) {
          url = `http://${url}`;
        }
        config.ollama_base_url = url;
      } else {
        delete config.ollama_base_url;
      }
    } else if (normalizedProvider !== "ollama") {
      delete config.ollama_base_url;
    }
  });
}
/**
 * Execute a configuration mutation atomically under the config file lock.
 *
 * This ensures that the entire read-modify-write sequence is protected by
 * the same file lock used by the internal persistence functions, preventing
 * race conditions where concurrent operations could see stale state or
 * overwrite each other.
 *
 * @param mutation A function that receives the current config and returns the modified config
 * @returns The modified config that was persisted
 */
export function withConfigLock<T>(
  mutation: (config: Record<string, unknown>) => T
): T {
  const targetFile = configFilePath();
  const { lockFd, lockPath } = acquireConfigLock(targetFile);
  try {
    // Load current config, apply mutation, persist result
    const currentConfig = loadConfig();
    const result = mutation(currentConfig);
    writeConfigFile(targetFile, currentConfig);
    return result;
  } finally {
    releaseConfigLock(lockFd, lockPath);
  }
}

// Export lock functions for testing/debugging
export { acquireConfigLock, releaseConfigLock, writeConfigFile, setProjectRootInConfig };

/**
 * Agent read permissions are request-scoped.
 *
 * Undefined means this function is being called outside an agent request,
 * so normal project reads remain available. A Set, including an empty Set,
 * means an agent request is active and only the selected relative paths
 * are readable.
 */
const allowedReadPaths = new AsyncLocalStorage<ReadonlySet<string>>();

function normalizeAllowedPath(requested: string): string {
  const resolved = safePath(requested);
  return relative(getProjectRoot(), resolved).split(sep).join("/");
}

export function getAllowedReadPaths(): ReadonlySet<string> | undefined {
  return allowedReadPaths.getStore();
}

export function setAllowedReadPaths(paths: unknown): ReadonlySet<string> {
  const normalized = new Set<string>();

  if (Array.isArray(paths)) {
    for (const raw of paths) {
      if (typeof raw !== "string" || !raw.trim()) continue;

      try {
        normalized.add(normalizeAllowedPath(raw.trim()));
      } catch {
        // Invalid, absolute, or traversal paths are simply not granted.
      }
    }
  }

  return normalized;
}

export function runWithAllowedReadPaths<T>(
  paths: unknown,
  callback: () => T | Promise<T>,
): Promise<T> {
  const allowed = setAllowedReadPaths(paths);
  return Promise.resolve(allowedReadPaths.run(allowed, callback));
}

export function isReadAllowed(requested: string): boolean {
  const allowed = getAllowedReadPaths();

  if (allowed === undefined) {
    return true;
  }

  try {
    return allowed.has(normalizeAllowedPath(requested));
  } catch {
    return false;
  }
}

export function requireReadAllowed(requested: string): void {
  const allowed = getAllowedReadPaths();

  if (allowed === undefined) {
    return;
  }

  if (!isReadAllowed(requested)) {
    throw new Error(
      `Access denied: '${requested}' is not in the set of files the user selected for the agent. Select it on the Project page first.`,
    );
  }
}


// ---------------------------------------------------------------------------
// Race-resistant filesystem I/O within the project root
// ---------------------------------------------------------------------------
//
// safePath() validates a path, but a concurrent process can replace the final
// component with a symlink/junction before a subsequent readFileSync/write.
// Mitigation: open the final component with O_NOFOLLOW (so a symlink at the
// last component cannot be followed), then perform I/O on the file descriptor.
// After open, re-check that the real path of the opened object is still under
// PROJECT_ROOT (Linux: /proc/self/fd/<fd>; elsewhere: realpath of the path
// that O_NOFOLLOW just opened as a non-symlink).

function noFollowFlag(): number {
  // Present on modern Node for both Unix and Windows.
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function realPathOfFd(fd: number, fallbackPath: string): string {
  if (process.platform === "linux") {
    try {
      return realpathSync(`/proc/self/fd/${fd}`);
    } catch {
      // Fall through.
    }
  }
  // After a successful O_NOFOLLOW open the final component is not a symlink,
  // so realpath of the path string resolves through trusted parents only for
  // the open we already performed. Still best-effort on non-Linux.
  return realpathSync(fallbackPath);
}

function assertOpenedWithinProject(fd: number, openPath: string): string {
  const root = getProjectRoot();
  let openedReal: string;
  try {
    openedReal = realPathOfFd(fd, openPath);
  } catch (err) {
    closeSync(fd);
    throw new SecurityValidationError(
      `Could not verify opened path stays inside the project: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!isPathWithinRoot(root, openedReal)) {
    closeSync(fd);
    throw new SecurityValidationError(
      "Access outside the project directory is not allowed.",
    );
  }
  return openedReal;
}

/**
 * Open a project path without following a final-component symlink/junction.
 * Validates with safePath first, then opens with O_NOFOLLOW and re-checks
 * the opened object is still under PROJECT_ROOT.
 */
export function openWithinProject(
  inputPath: string,
  flags: number,
  mode?: number,
): { fd: number; resolvedPath: string } {
  const candidate = safePath(inputPath);
  const openFlags = flags | noFollowFlag();
  let fd: number;
  let openPath = candidate;
  try {
    fd =
      mode === undefined
        ? openSync(candidate, openFlags)
        : openSync(candidate, openFlags, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Final component is a symlink/reparse point. Allow only when the
    // resolved target is still inside the project, then open that target
    // with O_NOFOLLOW so a further replacement cannot redirect I/O.
    if (code === "ELOOP" || code === "EINVAL") {
      let target: string;
      try {
        target = realpathSync(candidate);
      } catch {
        throw new SecurityValidationError(
          "Refusing to follow a symbolic link or reparse point at the final path component.",
        );
      }
      if (!isPathWithinRoot(getProjectRoot(), target)) {
        throw new SecurityValidationError(
          "Access outside the project directory is not allowed.",
        );
      }
      try {
        fd =
          mode === undefined
            ? openSync(target, openFlags)
            : openSync(target, openFlags, mode);
        openPath = target;
      } catch (err2) {
        const code2 = (err2 as NodeJS.ErrnoException).code;
        if (code2 === "ELOOP" || code2 === "EINVAL") {
          throw new SecurityValidationError(
            "Refusing to follow a symbolic link or reparse point at the final path component.",
          );
        }
        throw err2;
      }
    } else {
      throw err;
    }
  }
  const resolvedPath = assertOpenedWithinProject(fd, openPath);
  return { fd, resolvedPath };
}

/** Read a UTF-8 text file through an O_NOFOLLOW open + fd I/O. */
export function readFileWithinProject(inputPath: string, maxBytes: number): {
  resolvedPath: string;
  contents: string;
} {
  const { fd, resolvedPath } = openWithinProject(
    inputPath,
    fsConstants.O_RDONLY,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new SecurityValidationError(`Not a file: ${inputPath}`);
    }
    if (st.size > maxBytes) {
      throw new SecurityValidationError(
        `File is too large to read. Maximum size is ${maxBytes} bytes.`,
      );
    }
    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buffer, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, offset),
    );
    return { resolvedPath, contents };
  } catch (err) {
    if (err instanceof SecurityValidationError) throw err;
    if (err instanceof TypeError || (err as Error).name === "TypeError") {
      throw new SecurityValidationError("The file is not a UTF-8 text file.");
    }
    // TextDecoder fatal throws TypeError in some engines; also catch generic
    if (
      err instanceof Error &&
      /UTF-8|utf-8|encoding/i.test(err.message)
    ) {
      throw new SecurityValidationError("The file is not a UTF-8 text file.");
    }
    throw err;
  } finally {
    closeSync(fd);
  }
}

/**
 * Ensure `absDir` exists as a real directory chain under PROJECT_ROOT.
 * Creates missing segments one at a time relative to a pinned parent:
 *   Linux: mkdir via path under /proc/self/fd/<parentFd>/name is still
 *          pathname-based for mkdir — we open O_DIRECTORY|O_NOFOLLOW after
 *          create and verify. For mkdir the kernel create relative to
 *          an open dir uses mkdirat when available; Node lacks mkdirat, so
 *          we use /proc/self/fd parent + name open verification.
 *   Windows: mkdirRelativeToDirFd → NtCreateFile(FILE_DIRECTORY_FILE)
 *          with RootDirectory = parent HANDLE (true handle-relative create).
 */
function ensureDirectoryWithinProject(absDir: string): string {
  const root = getProjectRoot();
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new SecurityValidationError("Project root is not accessible.");
  }

  const target = resolve(absDir);
  const rel = relative(rootReal, target);
  if (rel.startsWith("..")) {
    throw new SecurityValidationError(
      "Access outside the project directory is not allowed.",
    );
  }
  if (!rel || rel === ".") {
    return rootReal;
  }

  let current = rootReal;
  for (const part of rel.split(sep)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw new SecurityValidationError(
        "Access outside the project directory is not allowed.",
      );
    }

    const dirFlags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0) |
      noFollowFlag();

    let currentFd: number;
    try {
      currentFd = openSync(current, dirFlags);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EINVAL") {
        let real: string;
        try {
          real = realpathSync(current);
        } catch {
          throw new SecurityValidationError(
            "Refusing to follow a symbolic link or reparse point in a parent directory.",
          );
        }
        if (!isPathWithinRoot(rootReal, real)) {
          throw new SecurityValidationError(
            "Access outside the project directory is not allowed.",
          );
        }
        currentFd = openSync(real, dirFlags);
        current = assertOpenedWithinProject(currentFd, real);
      } else {
        throw err;
      }
    }

    try {
      current = assertOpenedWithinProject(currentFd, current);

      // Probe whether child exists relative to the pinned parent without
      // walking a replaceable pathname for the *create* step.
      let childExists = false;
      if (process.platform === "linux") {
        try {
          const probe = openSync(
            `/proc/self/fd/${currentFd}/${part}`,
            dirFlags,
          );
          closeSync(probe);
          childExists = true;
        } catch {
          childExists = false;
        }
      } else if (process.platform === "win32") {
        // Existence probe via handle-relative open (FILE_OPEN).
        try {
          const probeFd = openRelativeToDirFd(currentFd, part, {
            create: false,
            write: false,
            directory: true,
          });
          closeSync(probeFd);
          childExists = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            childExists = false;
          } else if (err instanceof WindowsHandlePathError) {
            // Might be "not a directory" etc. — treat as needs create attempt
            childExists = false;
          } else {
            childExists = false;
          }
        }
      } else {
        childExists = existsSync(join(current, part));
      }

      if (!childExists) {
        if (process.platform === "win32") {
          try {
            mkdirRelativeToDirFd(currentFd, part);
          } catch (err) {
            if (err instanceof WindowsHandlePathError) {
              throw new SecurityValidationError(err.message);
            }
            throw err;
          }
        } else if (process.platform === "linux") {
          // Node has no mkdirat; create via /proc path of the pinned fd.
          // The directory object is pinned; the name is created in that object.
          try {
            mkdirSync(`/proc/self/fd/${currentFd}/${part}`);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") throw err;
          }
        } else {
          try {
            mkdirSync(join(current, part));
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") throw err;
          }
        }
      }

      // Open the child relative to the parent handle and verify.
      let nextFd: number;
      if (process.platform === "win32") {
        try {
          nextFd = openRelativeToDirFd(currentFd, part, {
            create: false,
            write: false,
            directory: true,
          });
        } catch (err) {
          if (err instanceof WindowsHandlePathError) {
            throw new SecurityValidationError(err.message);
          }
          throw err;
        }
      } else if (process.platform === "linux") {
        nextFd = openSync(`/proc/self/fd/${currentFd}/${part}`, dirFlags);
      } else {
        nextFd = openSync(join(current, part), dirFlags);
      }
      try {
        const st = fstatSync(nextFd);
        if (!st.isDirectory()) {
          throw new SecurityValidationError(
            "Path component is not a directory.",
          );
        }
        // Parent was in-project; child opened relative to parent handle is
        // inside that directory object. Update current to lexical join for
        // the next iteration's openSync of current on non-Windows.
        current = join(current, part);
        try {
          current = realpathSync(current);
        } catch {
          // keep join path
        }
        if (!isPathWithinRoot(rootReal, current)) {
          throw new SecurityValidationError(
            "Access outside the project directory is not allowed.",
          );
        }
      } finally {
        closeSync(nextFd);
      }
    } finally {
      closeSync(currentFd);
    }
  }
  return current;
}


/**
 * Write contents to a project path with parent-directory and final-component
 * race resistance.
 *
 * Linux: open the parent with O_DIRECTORY, pin it, then open the file via
 * `/proc/self/fd/<parentFd>/<basename>` (openat semantics) so a concurrent
 * parent→symlink swap cannot redirect the create/write.
 *
 * Windows: Node has no openat. We pin the parent directory handle, resolve
 * that handle to a path with GetFinalPathNameByHandleW (the path of the
 * open directory *object*, stable across concurrent name→junction swaps of
 * the original path), then open/create the file under *that* path. O_CREAT
 * therefore targets the pinned directory, not a replaced junction.
 * Requires the optional `koffi` dependency on Windows; if unavailable, new
 * file creates fail closed rather than falling back to unsafe pathname O_CREAT.
 *
 * Existing files (all platforms): open without O_CREAT, verify, ftruncate, write.
 * Never open with O_TRUNC before containment is verified.
 */
function writeBufferToFd(fd: number, contents: string): number {
  ftruncateSync(fd, 0);
  const buffer = Buffer.from(contents, "utf-8");
  let offset = 0;
  while (offset < buffer.length) {
    const n = writeSync(fd, buffer, offset, buffer.length - offset, offset);
    offset += n;
  }
  return buffer.length;
}

/**
 * Windows write: create/open relative to the pinned parent handle path.
 * Does not use renameSync into a pathname under an untrusted parent name.
 */
function writeFileWithinProjectWindows(
  root: string,
  parentFd: number,
  parentOpenPath: string,
  base: string,
  contents: string,
  options: { exclusive?: boolean; mode?: number },
): { resolvedPath: string; bytesWritten: number } {
  // Confirm the open parent descriptor is still inside the project.
  assertOpenedWithinProject(parentFd, parentOpenPath);

  // True handle-relative open/create via NtCreateFile(RootDirectory=parent).
  // No pathname is constructed from GetFinalPathNameByHandle — the child is
  // resolved relative to the directory *object* the parentFd refers to.
  let fd: number;
  try {
    fd = openRelativeToDirFd(parentFd, base, {
      create: true,
      exclusive: options.exclusive === true,
      write: true,
    });
  } catch (err) {
    if (err instanceof WindowsHandlePathError) {
      throw new SecurityValidationError(err.message);
    }
    throw err;
  }

  try {
    // Containment check on the opened object before any truncate/write.
    // realPathOfFd on Windows falls back to realpath of a path; we verify
    // via fstat + requiring the parent was already in-project. Additionally
    // reject if the opened object is a reparse point we didn't intend.
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new SecurityValidationError(
        "Refusing to write to a non-file object.",
      );
    }
    // Reconstruct a path for assertOpenedWithinProject best-effort reporting
    // by using parentOpenPath/base only for the error message path — the
    // security decision is that parentFd was verified and the child was
    // opened relative to that handle (NtCreateFile RootDirectory semantics).
    const resolvedPath = join(
      assertOpenedWithinProject(parentFd, parentOpenPath),
      base,
    );
    if (!isPathWithinRoot(root, resolvedPath)) {
      // Parent verified in-project; relative child under that parent is
      // inside the same directory object. Lexical join under parent real
      // path must still be within root.
      throw new SecurityValidationError(
        "Access outside the project directory is not allowed.",
      );
    }
    const bytesWritten = writeBufferToFd(fd, contents);
    return { resolvedPath, bytesWritten };
  } finally {
    closeSync(fd);
  }
}


export function writeFileWithinProject(
  inputPath: string,
  contents: string,
  options: { exclusive?: boolean; mode?: number } = {},
): { resolvedPath: string; bytesWritten: number } {
  const candidate = safePath(inputPath);
  const root = getProjectRoot();
  const base = basename(candidate);
  if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\\")) {
    throw new SecurityValidationError(`Invalid file name: ${base}`);
  }

  const parentLexical = dirname(candidate);
  if (!existsSync(parentLexical)) {
    ensureDirectoryWithinProject(parentLexical);
  }

  // Pin the parent directory inode/handle.
  const dirFlags =
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0) |
    noFollowFlag();

  let parentFd: number;
  let parentOpenPath = parentLexical;
  try {
    parentFd = openSync(parentLexical, dirFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EINVAL") {
      let parentReal: string;
      try {
        parentReal = realpathSync(parentLexical);
      } catch {
        throw new SecurityValidationError(
          "Refusing to follow a symbolic link or reparse point in a parent directory.",
        );
      }
      if (!isPathWithinRoot(root, parentReal)) {
        throw new SecurityValidationError(
          "Access outside the project directory is not allowed.",
        );
      }
      parentFd = openSync(parentReal, dirFlags);
      parentOpenPath = parentReal;
    } else {
      throw err;
    }
  }

  try {
    if (process.platform === "win32") {
      return writeFileWithinProjectWindows(
        root,
        parentFd,
        parentOpenPath,
        base,
        contents,
        options,
      );
    }

    // Linux (and other POSIX with /proc): openat-style via pinned parent.
    assertOpenedWithinProject(parentFd, parentOpenPath);
    const fileOpenPath =
      process.platform === "linux"
        ? `/proc/self/fd/${parentFd}/${base}`
        : join(assertOpenedWithinProject(parentFd, parentOpenPath), base);

    // Non-Linux POSIX fallback without /proc: use handle-verified parent path
    // only after re-asserting containment (no Windows junction semantics).
    let flags =
      fsConstants.O_RDWR |
      fsConstants.O_CREAT |
      noFollowFlag();
    if (options.exclusive) {
      flags |= fsConstants.O_EXCL;
    }

    let fd: number;
    try {
      fd = openSync(fileOpenPath, flags, options.mode ?? 0o644);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EINVAL") {
        throw new SecurityValidationError(
          "Refusing to follow a symbolic link or reparse point at the final path component.",
        );
      }
      throw err;
    }

    try {
      const resolvedPath = assertOpenedWithinProject(fd, fileOpenPath);
      const bytesWritten = writeBufferToFd(fd, contents);
      return { resolvedPath, bytesWritten };
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parentFd);
  }
}

/**
 * Unlink a project file without the open→close→path-delete TOCTOU.
 *
 * Flow:
 * 1. openWithinProject (O_NOFOLLOW + project-root check) pins an inode.
 * 2. fstat the descriptor — refuse directories / non-files.
 * 3. Confirm the directory entry still names the same (dev, ino).
 * 4. On POSIX, unlink while the descriptor is still open.
 * 5. On Windows, DeleteFile often cannot remove a path that still has an
 *    open handle, so we close only after the inode check and delete
 *    immediately (still stronger than the previous close-then-stat-then-rm).
 *
 * Final-component symlink escapes are refused by openWithinProject.
 */
export function unlinkWithinProject(inputPath: string): { resolvedPath: string } {
  const root = getProjectRoot();
  const { fd, resolvedPath } = openWithinProject(
    inputPath,
    fsConstants.O_RDONLY,
  );
  let closed = false;
  try {
    if (resolvedPath === root) {
      throw new SecurityValidationError("Refusing to delete the project root.");
    }
    if (!isPathWithinRoot(root, resolvedPath)) {
      throw new SecurityValidationError(
        "Access outside the project directory is not allowed.",
      );
    }

    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new SecurityValidationError(
        "delete_file can only delete a single file, not a directory.",
      );
    }

    // Directory-entry must still refer to the inode we opened.
    let entry;
    try {
      entry = statSync(resolvedPath);
    } catch {
      throw new SecurityValidationError("File disappeared before deletion.");
    }
    if (entry.dev !== opened.dev || entry.ino !== opened.ino) {
      throw new SecurityValidationError(
        "File was replaced before deletion; refusing to delete.",
      );
    }
    if (!entry.isFile()) {
      throw new SecurityValidationError(
        "delete_file can only delete a single file, not a directory.",
      );
    }

    if (process.platform === "win32") {
      // Windows: release the handle, re-check inode, then delete immediately.
      closeSync(fd);
      closed = true;
      let entry2;
      try {
        entry2 = statSync(resolvedPath);
      } catch {
        throw new SecurityValidationError("File disappeared before deletion.");
      }
      if (entry2.dev !== opened.dev || entry2.ino !== opened.ino || !entry2.isFile()) {
        throw new SecurityValidationError(
          "File was replaced before deletion; refusing to delete.",
        );
      }
      rmSync(resolvedPath);
      return { resolvedPath };
    }

    // POSIX: delete while the verified descriptor is still held.
    rmSync(resolvedPath);
    return { resolvedPath };
  } finally {
    if (!closed) {
      try {
        closeSync(fd);
      } catch {
        // Ignore double-close / already-closed.
      }
    }
  }
}
