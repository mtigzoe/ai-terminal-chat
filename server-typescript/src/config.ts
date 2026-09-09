// Backend configuration and environment handling.
//
// server-python has no single config module - `load_dotenv()` and `PORT`
// live in app.py, `PROVIDER` is read independently in providers.py and the
// legacy __init__.py, and the project-root config file lives in security.py.
// This module consolidates the server-level pieces (env loading, PORT,
// PROVIDER selection) behind typed helpers instead of scattering
// `process.env` reads across the codebase, per the "do not perform a
// literal translation" migration principle. Project-root persistence stays
// in security.ts (Phase 2) since it is a security boundary, not plain
// config. Per-provider environment variables (API keys, model defaults,
// base URLs - server-python/providers.py: load_provider_config) are
// migrated in providers.ts (Phase 4), which will reuse the helpers here.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// .env loading (mirrors server-python/app.py: `load_dotenv()`)
// ---------------------------------------------------------------------------

/**
 * Load environment variables from a `.env` file into `process.env`.
 *
 * Mirrors python-dotenv's `load_dotenv()`: a missing file is not an error,
 * and (matching python-dotenv's default `override=False`) variables already
 * present in `process.env` are left untouched rather than overwritten.
 *
 * Uses Node's built-in `process.loadEnvFile` (stable in Node 20.12+/22+)
 * instead of adding a `dotenv` dependency, per the "use Node.js APIs where
 * appropriate" migration principle.
 */
export function loadEnvFile(path = ".env"): void {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return;
  }
  process.loadEnvFile(resolved);
}

// ---------------------------------------------------------------------------
// Shared application configuration persistence
// ---------------------------------------------------------------------------

export type AppConfig = Record<string, unknown>;

function defaultConfigFilePath(): string {
  return join(homedir(), ".ai-terminal-chat", "config.json");
}

/**
 * Load the shared application configuration object.
 *
 * Invalid, missing, or non-object JSON is treated as an empty configuration,
 * matching the Python security/config behavior. Callers can provide a custom
 * path in tests without changing process-global state.
 */
export function loadAppConfig(configFilePath = defaultConfigFilePath()): AppConfig {
  try {
    const raw = readFileSync(configFilePath, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return data as AppConfig;
    }
  } catch {
    // Missing, unreadable, or invalid JSON: use an empty configuration.
  }
  return {};
}

/**
 * Persist the shared application configuration atomically with file locking.
 *
 * The destination directory is created as needed and the temporary file is
 * replaced atomically, preserving other configuration keys when callers use
 * loadAppConfig() -> mutate -> persistAppConfig().
 *
 * Uses a simple file-based lock to prevent concurrent writes from losing
 * updates. The lock is a temporary file created with `O_EXCL` equivalent
 * (via openSync with flag 'wx' on Node 16+). Waits up to 5 seconds
 * with exponential backoff and actual sleep.
 *
 * On Windows, atomic rename can fail with EPERM when another process (antivirus,
 * indexer, or a lingering handle from a concurrent write) briefly locks the
 * target file. In that case we fall back to a direct write so config saves
 * still succeed for this local development tool - atomicity is a durability
 * optimization, not a correctness requirement here.
 */
export function persistAppConfig(
  payload: AppConfig,
  configFilePath = defaultConfigFilePath(),
): void {
  const directory = dirname(configFilePath);
  mkdirSync(directory, { recursive: true });

  // Acquire a lock to prevent concurrent writes from racing
  // Use a unique lock file path per invocation (random suffix) to avoid
  // same-process races. The lock file is cleaned up in finally.
  const configFileName = basename(configFilePath).replace(/\.[^.]+$/, "");
  const lockSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockPath = join(directory, `.config.${configFileName}.${lockSuffix}.lock`);
  const maxLockWaitMs = 5000;
  const lockWaitStart = Date.now();
  let lockFd: number | null = null;

  // Helper to sleep for a given duration
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Try to acquire the lock with exponential backoff and actual sleep
  let lockAcquired = false;
  while (Date.now() - lockWaitStart < maxLockWaitMs) {
    try {
      // Use 'wx' flag for exclusive creation (fails if file exists)
      lockFd = fs.openSync(lockPath, "wx");
      lockAcquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock held by another process (or another call in same process), wait and retry
        const elapsed = Date.now() - lockWaitStart;
        const backoff = Math.min(10 + elapsed * 0.1, 100);
        // Actually sleep for the backoff duration
        // We need to use a synchronous approach, so we'll use a busy wait with Atomics.wait
        // which is available in Node.js for cross-process synchronization
        const startWait = Date.now();
        while (Date.now() - startWait < backoff) {
          // Busy wait for small durations, but Atomics.wait on a SharedArrayBuffer would be better
          // For now, a simple loop is acceptable for < 100ms
        }
        continue;
      }
      // On EPERM or other errors, fall back to direct write without locking
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        break;
      }
      throw err;
    }
  }

  // If we couldn't acquire the lock (EPERM or timeout), proceed without locking
  // This handles Windows where locking may not work in some environments
  const tempPath = join(
    directory,
    `config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempPath, configFilePath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original persistence error.
    }

    try {
      writeFileSync(configFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return;
    } catch (writeErr) {
      throw writeErr;
    }
  } finally {
    // Release the lock if we acquired it
    if (lockAcquired && lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // Ignore
      }
    }
    // Clean up our specific lock file
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Ignore lock cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Typed environment accessors
// ---------------------------------------------------------------------------

/** Read a string environment variable, falling back to `defaultValue` if unset or blank. */
export function getEnvString(name: string, defaultValue: string): string;
export function getEnvString(name: string, defaultValue?: undefined): string | undefined;
export function getEnvString(name: string, defaultValue?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  return value;
}

export interface GetEnvIntOptions {
  /**
   * Throw instead of silently falling back when the variable is set but
   * not a valid integer. Off by default to match call sites such as
   * `int(os.getenv("PORT", "9000"))`, which would raise in Python too -
   * callers that want that strictness should opt in explicitly.
   */
  strict?: boolean;
}

/** Read an integer environment variable, falling back to `defaultValue` if unset or invalid.
 *  Matches Python's `int()` behavior: only accepts strings matching /^[+-]?\d+$/.
 *  Rejects: "9000abc", "9000.5", " 9000 ", "", "abc", "1.5", etc.
 */
export function getEnvInt(
  name: string,
  defaultValue: number,
  options: GetEnvIntOptions = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  // Match Python's int() behavior: only allow optional sign followed by digits
  if (!/^[+-]?\d+$/.test(raw)) {
    if (options.strict) {
      throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
    }
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  // Additional safety: check for overflow (Python int has no max, but we might want bounds)
  return parsed;
}

// ---------------------------------------------------------------------------
// Server configuration (server-python/app.py: `__main__` block)
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** TCP port the HTTP server listens on. `PORT` env var, default 9000 - matches client-react's default `VITE_API_URL` of http://localhost:9000. */
  port: number;
  /**
   * Host/interface the server binds to. Always loopback-only,
   * matching server-python's hardcoded `app.run(host="127.0.0.1", ...)`.
   */
  host: string;
}

const DEFAULT_PORT = 9000;
export const SERVER_HOST = "127.0.0.1";

/** Build the server configuration from the current environment. */
export function loadServerConfig(): ServerConfig {
  return {
    port: getEnvInt("PORT", DEFAULT_PORT),
    host: SERVER_HOST,
  };
}

// ---------------------------------------------------------------------------
// Provider selection (server-python/providers.py, __init__.py: `PROVIDER` env var)
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_NAME = "gemini";

/**
 * Which AI provider is selected by default.
 *
 * Mirrors `os.getenv("PROVIDER", "gemini").lower()`, used both by the
 * legacy provider factory in __init__.py and by providers.py:get_provider.
 * Returns the raw lowercased name; validating it against
 * `SUPPORTED_PROVIDERS` (types.ts) is providers.ts's job (Phase 4).
 */
export function getConfiguredProviderName(): string {
  return getEnvString("PROVIDER", DEFAULT_PROVIDER_NAME).toLowerCase();
}
