// Controlled terminal command execution.
//
// Mirrors server-python/tools.py run_command() and its allowlist helpers.
// Commands are executed without a shell, dangerous metacharacters and
// explicitly blocked patterns are rejected, output is capped, and the
// user-configurable allowlist is persisted in the shared config file.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadAppConfig, persistAppConfig } from "./config.js";
import type { RunCommandResult } from "./types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_ALLOWED_COMMAND_PREFIXES = [
  "git status",
  "git branch",
  "git log",
  "git diff",
  "git show",
  "git remote -v",
  "pwd",
  "dir",
  "ls",
  "wsl",
  "python --version",
  "python3 --version",
  "node --version",
  "npm --version",
  "pip --version",
  "pip3 --version",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "npm test",
  "npm run test",
  "npm run build",
  "npm run lint",
  "npm install",
  "npm ci",
  "pip install -r requirements.txt",
  "pip list",
  "pip show",
  "flake8",
  "black --check",
  "ruff check",
  "uv --version",
  "uv run",
] as const;

export const DANGEROUS_COMMAND_CHARACTERS = [";", "&", "|", "`", "$(", ">", "<", "\n"] as const;

export const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bmkfs\b/i,
  /\bformat\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+777\b/i,
  /\bchown\b/i,
  /\.env\b/i,
  /\bgoogle_api_key\b/i,
  /\bprintenv\b/i,
  /\bcredential/i,
  /\bid_rsa\b/i,
] as const;

export const FORBIDDEN_ALLOWED_COMMAND_PREFIXES = [
  "rm",
  "del",
  "rmdir",
  "remove-item",
  "sudo",
  "shutdown",
  "reboot",
  "format",
  "diskpart",
  "git reset",
  "git clean",
  "git push",
  "git commit",
  "git add",
] as const;

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

let allowedCommandPrefixes: string[] = [...DEFAULT_ALLOWED_COMMAND_PREFIXES];

function normalizePrefix(prefix: string): string {
  return (prefix ?? "").trim();
}

function isForbiddenPrefix(prefix: string): boolean {
  const normalized = normalizePrefix(prefix).toLowerCase();
  if (!normalized) return true;
  if (FORBIDDEN_ALLOWED_COMMAND_PREFIXES.some(
    (forbidden) => normalized === forbidden || normalized.startsWith(`${forbidden} `),
  )) {
    return true;
  }
  return DANGEROUS_COMMAND_CHARACTERS.some((character) => normalized.includes(character));
}

function loadAllowedCommandsFromConfig(): string[] | null {
  const raw = loadAppConfig().allowed_commands;
  if (!Array.isArray(raw)) return null;

  const prefixes = raw.filter((item): item is string => typeof item === "string")
    .map(normalizePrefix)
    .filter((prefix) => Boolean(prefix) && !isForbiddenPrefix(prefix));

  return prefixes.length > 0 ? prefixes : null;
}

function persistAllowedCommands(prefixes: string[]): void {
  const config = loadAppConfig();
  config.allowed_commands = [...prefixes];
  persistAppConfig(config);
}

/** Reload the runtime allowlist from the shared configuration file. */
export function reloadAllowedCommands(): string[] {
  allowedCommandPrefixes = loadAllowedCommandsFromConfig() ?? [...DEFAULT_ALLOWED_COMMAND_PREFIXES];
  return getAllowedCommands();
}

/** Return the active allowlist in deterministic order. */
export function getAllowedCommands(): string[] {
  return [...allowedCommandPrefixes].sort();
}

/** Add a safe command prefix and persist the updated list. */
export function addAllowedCommand(prefix: string): string[] {
  const normalized = normalizePrefix(prefix);
  if (!normalized) throw new Error("A non-empty command prefix is required.");
  if (isForbiddenPrefix(normalized)) {
    throw new Error(`Command prefix '${normalized}' is not permitted for safety reasons.`);
  }
  if (!allowedCommandPrefixes.includes(normalized)) {
    allowedCommandPrefixes.push(normalized);
    persistAllowedCommands(allowedCommandPrefixes);
  }
  return getAllowedCommands();
}

/** Remove an existing command prefix and persist the updated list. */
export function removeAllowedCommand(prefix: string): string[] {
  const normalized = normalizePrefix(prefix);
  if (!normalized) throw new Error("A non-empty command prefix is required.");
  const index = allowedCommandPrefixes.indexOf(normalized);
  if (index < 0) throw new Error(`Command prefix '${normalized}' is not in the allowlist.`);
  allowedCommandPrefixes.splice(index, 1);
  persistAllowedCommands(allowedCommandPrefixes);
  return getAllowedCommands();
}

/** True when a command is exactly a prefix or starts with the prefix plus whitespace. */
export function isCommandAllowed(command: string): boolean {
  return allowedCommandPrefixes.some(
    (prefix) => command === prefix || command.startsWith(`${prefix} `),
  );
}

/**
 * Tokenize one plain command without invoking a shell. Supports whitespace,
 * single/double quotes, and backslash escaping. Shell operators are rejected
 * before tokenization, so this parser never needs to implement shell syntax.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote !== null) throw new Error("Unterminated quote in command.");
  if (current) tokens.push(current);
  return tokens;
}

function commandBlocked(command: string): string | null {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) return `This command is blocked for safety: ${command}`;
  }
  if (DANGEROUS_COMMAND_CHARACTERS.some((character) => command.includes(character))) {
    return "Command chaining, piping, redirection, and substitution are not allowed. Run one plain command at a time.";
  }
  return null;
}

function executableForCommand(args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && args.length > 0 && ["ls", "dir"].includes(args[0].toLowerCase())) {
    return { file: "cmd", args: ["/c", "dir", ...args.slice(1)] };
  }
  return { file: args[0], args: args.slice(1) };
}

function capOutput(value: string): { value: string; truncated: boolean } {
  return { value: value.slice(0, MAX_OUTPUT_CHARS), truncated: value.length > MAX_OUTPUT_CHARS };
}

/** Execute one allowlisted command in the configured project root. */
export async function runCommand(command: string): Promise<RunCommandResult> {
  if (!command || !command.trim()) return { error: "No command was provided." };
  const normalized = command.trim();

  const blocked = commandBlocked(normalized);
  if (blocked) return { error: blocked };

  if (!isCommandAllowed(normalized)) {
    return {
      error: `Command not allowed: '${normalized}'. Allowed command prefixes: ${JSON.stringify(getAllowedCommands())}`,
    };
  }

  let args: string[];
  try {
    args = tokenizeCommand(normalized);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (args.length === 0) return { error: "No command was provided." };

  const { file, args: fileArgs } = executableForCommand(args);

  try {
    const { stdout, stderr } = await execFileAsync(file, fileArgs, {
      cwd: (await import("./security.js")).getProjectRoot(),
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_CHARS * 2,
      encoding: "utf8",
    });
    const out = capOutput(String(stdout ?? ""));
    const err = capOutput(String(stderr ?? ""));
    const truncated = out.truncated || err.truncated;
    const payload: RunCommandResult = {
      command: normalized,
      returncode: 0,
      stdout: out.value,
      stderr: err.value,
      truncated,
    };
    if (truncated && !("error" in payload)) {
      payload.truncation_note = `Output was truncated to ${MAX_OUTPUT_CHARS} characters per stream.`;
    }
    return payload;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    if (error.killed && error.signal === "SIGTERM") {
      return { error: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.` };
    }
    if (error.code === "ENOENT") {
      return { error: `${args[0]} is not installed or not on PATH.` };
    }

    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    const out = capOutput(stdout);
    const errText = capOutput(stderr);
    if (typeof error.code === "number") {
      const payload: RunCommandResult = {
        command: normalized,
        returncode: error.code,
        stdout: out.value,
        stderr: errText.value,
        truncated: out.truncated || errText.truncated,
      };
      if (payload.truncated && !("error" in payload)) {
        payload.truncation_note = `Output was truncated to ${MAX_OUTPUT_CHARS} characters per stream.`;
      }
      return payload;
    }
    return { error: `Could not execute command: ${error.message ?? String(err)}` };
  }
}

// Initialize from persisted configuration when the module is loaded.
reloadAllowedCommands();
