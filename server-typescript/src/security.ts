import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".ai-terminal-chat");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const CHOOSE_PROJECT_ROOT = "__CHOOSE_PROJECT_ROOT__";

function defaultProjectRoot(): string {
  return process.cwd();
}

function loadProjectRoot(): string {
  const envConfigured = process.env.AI_TERMINAL_PROJECT_ROOT?.trim();
  if (envConfigured) {
    const candidate = path.resolve(envConfigured);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const configured = String(data.project_root ?? "").trim();
    if (configured) {
      const candidate = path.resolve(configured);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }

  return defaultProjectRoot();
}

let _projectRoot: string = loadProjectRoot();

export function getProjectRoot(): string {
  return _projectRoot;
}

export function setProjectRoot(newRoot: string): string {
  const trimmed = newRoot.trim();
  if (trimmed === CHOOSE_PROJECT_ROOT) {
    throw new Error("Native folder picker is not available in this environment.");
  }

  if (!trimmed) {
    throw new Error("A project path is required.");
  }

  const candidate = path.resolve(trimmed);

  if (!fs.existsSync(candidate)) {
    throw new Error(`Project path does not exist: ${candidate}`);
  }
  if (!fs.statSync(candidate).isDirectory()) {
    throw new Error(`Project path is not a directory: ${candidate}`);
  }

  _persistProjectRoot(candidate);
  _projectRoot = candidate;
  return candidate;
}

function _loadConfig(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null) {
      return data;
    }
  } catch {
    // ignore
  }
  return {};
}

function _persistConfig(payload: Record<string, unknown>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const json = JSON.stringify(payload, undefined, 2) + "\n";
  fs.writeFileSync(CONFIG_FILE, json, "utf-8");
}

function _persistProjectRoot(root: string): void {
  const payload = _loadConfig();
  payload["project_root"] = root;
  _persistConfig(payload);
}

export interface ProviderSelection {
  provider?: string;
  model?: string;
  ollama_base_url?: string;
}

/** Load persisted provider selection from config.json (mirrors Python). */
export function loadProviderSelection(): ProviderSelection {
  const data = _loadConfig();
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

/**
 * Persist provider selection to config.json (mirrors Python).
 * When ollama_base_url is provided it is scheme-normalised; when the
 * active provider is not ollama and no new URL is passed, a stored URL
 * is removed so stale values do not leak across provider switches.
 */
export function persistProviderSelection(
  provider: string,
  model?: string | null,
  ollamaBaseUrl?: string | null
): void {
  const payload = _loadConfig();
  payload["provider"] = String(provider).trim().toLowerCase();

  if (model !== undefined && model !== null) {
    const modelS = String(model).trim();
    if (modelS) {
      payload["model"] = modelS;
    } else {
      delete payload["model"];
    }
  }

  if (ollamaBaseUrl !== undefined && ollamaBaseUrl !== null) {
    let url = String(ollamaBaseUrl).trim();
    if (url) {
      if (!url.includes("://")) {
        url = `http://${url}`;
      }
      payload["ollama_base_url"] = url;
    } else {
      delete payload["ollama_base_url"];
    }
  } else if (payload["provider"] !== "ollama") {
    delete payload["ollama_base_url"];
  }

  _persistConfig(payload);
}

export function safePath(requested: string): string {
  if (!requested || !String(requested).trim()) {
    throw new Error("A path is required.");
  }

  // Do not allow callers to smuggle an absolute POSIX or Windows path into
  // a project-root-relative API, even when that absolute path is inside the
  // project. This matches Python's PurePosixPath/PureWindowsPath checks.
  if (path.isAbsolute(requested) || path.win32.isAbsolute(requested)) {
    throw new Error("Absolute paths are not allowed. Use a path relative to the project root.");
  }

  const root = getProjectRoot();
  const resolved = path.resolve(root, requested);

  try {
    path.relative(root, resolved);
  } catch {
    throw new Error("Access outside the project directory is not allowed.");
  }

  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Access outside the project directory is not allowed.");
  }

  return resolved;
}

const SENSITIVE_EXACT_NAMES = new Set([
  ".git-credentials",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
]);
const SENSITIVE_SUFFIXES = [".pem", ".key"];
// Template env files document required keys without real secrets.
const ENV_TEMPLATE_NAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

export function isSensitiveFilename(name: string): boolean {
  const lower = name.toLowerCase();
  if (ENV_TEMPLATE_NAMES.has(lower)) return false;
  if (lower.startsWith(".env")) return true;
  if (SENSITIVE_EXACT_NAMES.has(lower)) return true;
  if (SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (lower.includes("secret") || lower.includes("credential")) return true;
  return false;
}

export function isSensitivePath(filePath: string): boolean {
  const root = getProjectRoot();
  try {
    const relative = path.relative(root, filePath);
    if (relative.split(path.sep).includes(".git")) {
      return true;
    }
  } catch {
    return true;
  }
  return isSensitiveFilename(path.basename(filePath));
}

// Agent read permissions are request-scoped. Undefined means this function is
// being called outside an agent request (for example by the Project page), so
// normal project reads remain available. A Set, including an empty Set, means
// an agent request is active and only the selected relative paths are readable.
const allowedReadPaths = new AsyncLocalStorage<ReadonlySet<string>>();

function normalizeAllowedPath(requested: string): string {
  const resolved = safePath(requested);
  return path.relative(getProjectRoot(), resolved).split(path.sep).join("/");
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
  callback: () => T | Promise<T>
): Promise<T> {
  const allowed = setAllowedReadPaths(paths);
  return allowedReadPaths.run(allowed, callback);
}

export function isReadAllowed(requested: string): boolean {
  const allowed = getAllowedReadPaths();
  if (allowed === undefined) return true;

  try {
    return allowed.has(normalizeAllowedPath(requested));
  } catch {
    return false;
  }
}

export function requireReadAllowed(requested: string): void {
  const allowed = getAllowedReadPaths();
  if (allowed === undefined) return;

  if (!isReadAllowed(requested)) {
    throw new Error(
      `Access denied: '${requested}' is not in the set of files the user selected for the agent. Select it on the Project page first.`
    );
  }
}
