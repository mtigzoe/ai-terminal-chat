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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
 * Persist the shared application configuration atomically.
 *
 * The destination directory is created as needed and the temporary file is
 * replaced atomically, preserving other configuration keys when callers use
 * loadAppConfig() -> mutate -> persistAppConfig().
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
      throw err;
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

/** Read an integer environment variable, falling back to `defaultValue` if unset or invalid. */
export function getEnvInt(
  name: string,
  defaultValue: number,
  options: GetEnvIntOptions = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    if (options.strict) {
      throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
    }
    return defaultValue;
  }

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
