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

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Execute a config write while holding the config lock. The callback is
 * invoked only after the lock is acquired, so read-modify-write callers can
 * load the latest on-disk config without a stale-read window.
 */
function withConfigLock<T>(
  configFilePath: string,
  operation: (directory: string, configFileName: string) => T,
): T {
  const directory = dirname(configFilePath);
  mkdirSync(directory, { recursive: true });
  const configFileName = basename(configFilePath).replace(/\.[^.]+$/, "");
  const lockPath = join(directory, `.config.${configFileName}.lock`);
  const maxLockWaitMs = 5000;
  const lockWaitStart = Date.now();
  let lockFd: number | null = null;
  let lockAcquired = false;

  while (Date.now() - lockWaitStart < maxLockWaitMs) {
    try {
      lockFd = fs.openSync(lockPath, "wx");
      lockAcquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const elapsed = Date.now() - lockWaitStart;
        sleepSync(Math.min(10 + elapsed * 0.1, 100));
        continue;
      }
      throw err;
    }
  }

  if (!lockAcquired) {
    throw new Error(`Could not acquire config lock for ${configFileName} after ${maxLockWaitMs}ms`);
  }

  try {
    return operation(directory, configFileName);
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // Ignore cleanup errors.
      }
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function writeConfigWhileLocked(
  payload: AppConfig,
  configFilePath: string,
  directory: string,
): void {
  const tempPath = join(
    directory,
    `config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    let renameAttempts = 0;
    const maxRenameAttempts = 5;
    while (true) {
      try {
        renameSync(tempPath, configFilePath);
        break;
      } catch (renameErr) {
        if (
          (renameErr as NodeJS.ErrnoException).code === "EPERM" &&
          renameAttempts < maxRenameAttempts - 1
        ) {
          renameAttempts++;
          sleepSync(50 * renameAttempts);
          continue;
        }
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original persistence error.
    }
    throw err;
  }
}

/**
 * Persist the shared application configuration atomically with file locking.
 * Existing keys are merged while the lock is held so callers that perform a
 * load-modify-persist sequence cannot overwrite unrelated updates made by a
 * concurrent writer between their initial load and this write.
 */
export function persistAppConfig(
  payload: AppConfig,
  configFilePath = defaultConfigFilePath(),
): void {
  withConfigLock(configFilePath, (directory) => {
    const current = loadAppConfig(configFilePath);
    const merged = { ...current, ...payload };
    writeConfigWhileLocked(merged, configFilePath, directory);
  });
}

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
  /** Throw instead of silently falling back when the variable is invalid. */
  strict?: boolean;
}

export function getEnvInt(
  name: string,
  defaultValue: number,
  options: GetEnvIntOptions = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  if (!/^[+-]?\d+$/.test(raw)) {
    if (options.strict) {
      throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
    }
    return defaultValue;
  }

  return Number.parseInt(raw, 10);
}

export interface ServerConfig {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Always loopback-only, matching server-python. */
  host: string;
}

const DEFAULT_PORT = 9000;
export const SERVER_HOST = "127.0.0.1";

export function loadServerConfig(): ServerConfig {
  return {
    port: getEnvInt("PORT", DEFAULT_PORT),
    host: SERVER_HOST,
  };
}

const DEFAULT_PROVIDER_NAME = "gemini";

export function getConfiguredProviderName(): string {
  return getEnvString("PROVIDER", DEFAULT_PROVIDER_NAME).toLowerCase();
}
