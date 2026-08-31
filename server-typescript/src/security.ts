import { AsyncLocalStorage } from "node:async_hooks";
// Security boundaries, validation, path restrictions, and command safety.
//
// Reference: server-python/security.py, and the security-relevant tests in
// server-python/tests/test_project_root.py and server-python/tests/test_tools.py
// (test_safe_path_*, test_is_sensitive_path_*, test_sensitive_filenames_are_blocked).
//
// Every path-facing tool (filesystem.ts, and later terminal.ts/git.ts/tools.ts)
// goes through safePath()/isSensitivePath() here. Nothing in this module talks
// to any AI provider, so it does not change when providers change — same
// design intent as the Python original.
//
// SECURITY NOTE ON SYMLINKS (verified empirically against server-python,
// not just inferred from source): Python's `Path.resolve()` follows
// symlinks for path segments that exist on disk, so `safe_path()` already
// rejects a symlink inside the project that points outside PROJECT_ROOT —
// confirmed by constructing such a symlink and calling `security.safe_path()`
// against it directly. `path.resolve()` in Node is purely lexical and does
// NOT touch the filesystem or follow symlinks, so a naive port would silently
// drop this protection. `resolveFollowingSymlinks()` below replicates
// Python's behavior: resolve real paths for whatever prefix of the path
// already exists (following symlinks along the way), then lexically append
// any remaining, not-yet-existing path segments — matching
// `Path.resolve(strict=False)` exactly, including the case where the full
// path doesn't exist yet (e.g. a new file about to be created).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep, win32 } from "node:path";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A rejected/invalid request — the caller did something not allowed (bad
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
 * of the host OS — matches security.py's use of both PurePosixPath and
 * PureWindowsPath so a Windows-style absolute path (`C:\...`, `\\server\share\...`)
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
 * prefix already exists on disk and lexically joining the rest — see the
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
      // Reached the filesystem root and even that doesn't resolve —
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
 * server-side. client-react never actually sends this sentinel — it uses
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

function configDir(): string {
  return configDirOverride ?? join(homedir(), ".ai-terminal-chat");
}

function configFilePath(): string {
  return join(configDir(), "config.json");
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
    // Missing file, unreadable, or invalid JSON — start from an empty
    // config, matching Python's `except (OSError, ValueError, TypeError): pass`.
  }
  return {};
}

/**
 * Persist the full configuration object atomically outside the project.
 * Mirrors security.py's `_persist_config()`.
 */
function persistConfig(payload: Record<string, unknown>): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });

  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const tempPath = join(
    dir,
    `config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, serialized, "utf8");
    // Atomic on both POSIX (rename(2)) and Windows (MoveFileExW with
    // MOVEFILE_REPLACE_EXISTING), matching Python's os.replace().
    renameSync(tempPath, configFilePath());
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw err;
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
    // Missing file, unreadable, or invalid JSON — fall through to cwd,
    // matching Python's `except (OSError, ValueError, TypeError): pass`.
    // (Deliberately not using loadConfig() here: Python's own
    // _load_project_root() still has this same separate inline read
    // rather than being consolidated onto _load_config() — the Allowed
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
 * write back the whole object) so other keys — e.g. the terminal
 * allowlist persisted by tools.ts (Phase 3) — are preserved. Mirrors
 * security.py's `_persist_project_root()`, which was changed to this
 * load/merge/persist approach by the Allowed Commands feature; this
 * function previously overwrote the file with only `{ project_root }`,
 * which would have silently dropped any other key already saved there.
 */
function persistProjectRoot(root: string): void {
  const payload = loadConfig();
  payload.project_root = root;
  persistConfig(payload);
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
 * `node:fs` call) for persistence failures — callers can use
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
 * server-python's pytest fixtures. Not for use outside tests — application
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

// ---------------------------------------------------------------------------
// safe_path
// ---------------------------------------------------------------------------

/**
 * Resolve a path while keeping it inside the configured project.
 *
 * Rejects absolute paths (POSIX or Windows-style) and any traversal
 * (including via symlinks — see the module-level SECURITY NOTE) that would
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
  // `file_path.relative_to(root)` fails — treat anything outside the
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
  const payload = loadConfig();
  const normalizedProvider = String(provider).trim().toLowerCase();

  payload.provider = normalizedProvider;

  if (model !== undefined && model !== null) {
    const modelS = String(model).trim();
    if (modelS) {
      payload.model = modelS;
    } else {
      delete payload.model;
    }
  }

  if (ollamaBaseUrl !== undefined && ollamaBaseUrl !== null) {
    let url = String(ollamaBaseUrl).trim();

    if (url) {
      if (!url.includes("://")) {
        url = `http://${url}`;
      }
      payload.ollama_base_url = url;
    } else {
      delete payload.ollama_base_url;
    }
  } else if (normalizedProvider !== "ollama") {
    delete payload.ollama_base_url;
  }

  persistConfig(payload);
}

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

export async function runWithAllowedReadPaths<T>(
  paths: unknown,
  callback: () => T | Promise<T>,
): Promise<T> {
  const allowed = setAllowedReadPaths(paths);
  return allowedReadPaths.run(allowed, callback);
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


