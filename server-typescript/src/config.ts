// Backend configuration and environment handling.
//
// server-python has no single config module — `load_dotenv()` and `PORT`
// live in app.py, `PROVIDER` is read independently in providers.py and the
// legacy __init__.py, and the project-root config file lives in security.py.
// This module consolidates the server-level pieces (env loading, PORT,
// PROVIDER selection) behind typed helpers instead of scattering
// `process.env` reads across the codebase, per the "do not perform a
// literal translation" migration principle. Project-root persistence stays
// in security.ts (Phase 2) since it is a security boundary, not plain
// config. Per-provider environment variables (API keys, model defaults,
// base URLs — server-python/providers.py: load_provider_config) are
// migrated in providers.ts (Phase 4), which will reuse the helpers here.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
   * `int(os.getenv("PORT", "9000"))`, which would raise in Python too —
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
  /** TCP port the HTTP server listens on. `PORT` env var, default 9000 — matches client-react's default `VITE_API_URL` of http://localhost:9000. */
  port: number;
  /**
   * Host/interface the HTTP server binds to. Always loopback-only,
   * matching server-python's hardcoded `app.run(host="127.0.0.1", ...)`.
   * Deliberately not environment-configurable: this backend holds
   * provider API keys and exposes unauthenticated filesystem/terminal
   * tools, so widening the bind address (e.g. to 0.0.0.0) must be a
   * conscious code change, not an accidental env var.
   */
  host: string;
}

const DEFAULT_PORT = 9000;
export const SERVER_HOST = "127.0.0.1";

/**
 * Build the server configuration from the current environment.
 *
 * Call `loadEnvFile()` first if a `.env` file should be consulted — kept
 * as a separate step so tests can set `process.env` directly without
 * touching the filesystem.
 */
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
 * `SUPPORTED_PROVIDERS` (types.ts) is providers.ts's job (Phase 4), since
 * an unrecognized name is a provider-selection error, not a config error.
 */
export function getConfiguredProviderName(): string {
  return getEnvString("PROVIDER", DEFAULT_PROVIDER_NAME).toLowerCase();
}
