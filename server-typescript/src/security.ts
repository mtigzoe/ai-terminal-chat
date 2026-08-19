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

export function isSensitiveFilename(name: string): boolean {
  const lower = name.toLowerCase();
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
