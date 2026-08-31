import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getAllowedReadPaths,
  getConfigFile,
  getProjectRoot,
  isReadAllowed,
} from "./security.ts";

const DEFAULT_ALLOWED_COMMAND_PREFIXES: string[] = [
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
];

let ALLOWED_COMMAND_PREFIXES: string[] = [...DEFAULT_ALLOWED_COMMAND_PREFIXES];

const DANGEROUS_COMMAND_CHARACTERS = [
  ";",
  "&",
  "|",
  "`",
  "$(",
  ">",
  "<",
  "\n",
];

const BLOCKED_COMMAND_PATTERNS = [
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
];

const FORBIDDEN_ALLOWED_COMMAND_PREFIXES = [
  "rm",
  "del",
  "rmdir",
  "Remove-Item",
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
];

function normalizeCommandPrefix(prefix: string): string {
  return (prefix || "").trim();
}

function isForbiddenPrefix(prefix: string): boolean {
  const normalized = normalizeCommandPrefix(prefix).toLowerCase();
  if (!normalized) return true;

  for (const forbidden of FORBIDDEN_ALLOWED_COMMAND_PREFIXES) {
    if (
      normalized === forbidden.toLowerCase() ||
      normalized.startsWith(forbidden.toLowerCase() + " ")
    ) {
      return true;
    }
  }

  for (const char of DANGEROUS_COMMAND_CHARACTERS) {
    if (normalized.includes(char)) return true;
  }
  return false;
}

function loadAllowedCommandsFromConfig(): string[] | null {
  try {
    const raw = fs.readFileSync(getConfigFile(), "utf-8");
    const data = JSON.parse(raw);
    const rawList = data.allowed_commands;
    if (!Array.isArray(rawList)) return null;

    const prefixes: string[] = [];
    for (const item of rawList) {
      if (typeof item !== "string") continue;
      const normalized = normalizeCommandPrefix(item);
      if (normalized && !isForbiddenPrefix(normalized)) {
        prefixes.push(normalized);
      }
    }
    return prefixes.length > 0 ? prefixes : null;
  } catch {
    return null;
  }
}

function persistAllowedCommands(prefixes: string[]): void {
  const configFile = getConfigFile();
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });

  let payload: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configFile, "utf-8");
    payload = JSON.parse(raw);
    if (typeof payload !== "object" || payload === null) {
      payload = {};
    }
  } catch {
    payload = {};
  }

  payload["allowed_commands"] = [...prefixes];

  const tmpFile = configFile + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(payload, undefined, 2) + "\n", "utf-8");
  fs.renameSync(tmpFile, configFile);
}

export function reloadAllowedCommands(): string[] {
  const loaded = loadAllowedCommandsFromConfig();
  if (loaded !== null) {
    ALLOWED_COMMAND_PREFIXES = loaded;
  } else {
    ALLOWED_COMMAND_PREFIXES = [...DEFAULT_ALLOWED_COMMAND_PREFIXES];
  }
  return [...ALLOWED_COMMAND_PREFIXES];
}

export function getAllowedCommands(): string[] {
  return [...ALLOWED_COMMAND_PREFIXES].sort();
}

export function addAllowedCommand(prefix: string): string[] {
  const normalized = normalizeCommandPrefix(prefix);
  if (!normalized) {
    throw new Error("A non-empty command prefix is required.");
  }
  if (isForbiddenPrefix(normalized)) {
    throw new Error(
      `Command prefix '${normalized}' is not permitted for safety reasons.`
    );
  }
  if (!ALLOWED_COMMAND_PREFIXES.includes(normalized)) {
    ALLOWED_COMMAND_PREFIXES.push(normalized);
    persistAllowedCommands(ALLOWED_COMMAND_PREFIXES);
  }
  return getAllowedCommands();
}

export function removeAllowedCommand(prefix: string): string[] {
  const normalized = normalizeCommandPrefix(prefix);
  if (!normalized) {
    throw new Error("A non-empty command prefix is required.");
  }
  const index = ALLOWED_COMMAND_PREFIXES.indexOf(normalized);
  if (index === -1) {
    throw new Error(`Command prefix '${normalized}' is not in the allowlist.`);
  }
  ALLOWED_COMMAND_PREFIXES.splice(index, 1);
  persistAllowedCommands(ALLOWED_COMMAND_PREFIXES);
  return getAllowedCommands();
}

export function isCommandAllowed(command: string): boolean {
  const trimmed = (command || "").trim();
  return ALLOWED_COMMAND_PREFIXES.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(prefix + " ")
  );
}

const MAX_OUTPUT = 20_000;

function shlexSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quoteChar: string | null = null;

  for (const c of command) {
    if (quoteChar) {
      current += c;
      hasToken = true;
      if (c === quoteChar) quoteChar = null;
      continue;
    }

    if (c === '"' || c === "'") {
      quoteChar = c;
      current += c;
      hasToken = true;
      continue;
    }

    if (/\s/.test(c)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += c;
    hasToken = true;
  }

  if (hasToken) tokens.push(current);
  return tokens;
}

const FILE_CONTENT_COMMAND_PREFIXES = [
  "cat",
  "type",
  "Get-Content",
  "gc",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "nl",
  "git show",
  "git diff",
];

function commandReadsFileContents(command: string): boolean {
  const trimmed = command.trim();
  return FILE_CONTENT_COMMAND_PREFIXES.some(
    (prefix) =>
      trimmed === prefix ||
      trimmed.startsWith(prefix + " ") ||
      trimmed.toLowerCase().startsWith(prefix.toLowerCase() + " ")
  );
}

function contentPathArguments(command: string): string[] {
  const args = shlexSplit(command);
  if (args.length < 2) return [];
  return args.slice(1).filter((arg) => arg && !arg.startsWith("-"));
}

function gitShowPathAllowed(arg: string): boolean {
  // `git show REF:path` names a repository path after the first colon.
  const colon = arg.indexOf(":");
  if (colon >= 0 && colon + 1 < arg.length) {
    return isReadAllowed(arg.slice(colon + 1));
  }
  return false;
}

function runCommandRespectsReadPermissions(command: string): Record<string, unknown> | null {
  const allowed = getAllowedReadPaths();
  if (allowed === undefined || !commandReadsFileContents(command)) return null;

  const args = contentPathArguments(command);
  const lower = command.toLowerCase();

  if (lower.startsWith("git show ")) {
    if (args.length === 1 && gitShowPathAllowed(args[0])) return null;
    return {
      error:
        "Access denied: git show can expose file contents and the requested file was not selected on the Project page.",
    };
  }

  if (lower === "git diff" || lower.startsWith("git diff ")) {
    if (args.length > 0 && args.every((arg) => arg === "--" || isReadAllowed(arg))) {
      const realPaths = args.filter((arg) => arg !== "--");
      if (realPaths.length > 0 && realPaths.every((arg) => isReadAllowed(arg))) return null;
    }
    return {
      error:
        "Access denied: git diff can expose file contents and is blocked unless it is scoped to selected files.",
    };
  }

  if (args.length > 0 && args.every((arg) => isReadAllowed(arg))) return null;

  return {
    error:
      `Access denied for ${args.join(", ") || "the requested file"}: this command can read arbitrary file contents and is blocked while agent file selection is active. Select the file on the Project page first.`,
  };
}

export function runCommand(command: string): Record<string, unknown> {
  const trimmed = (command || "").trim();
  if (!trimmed) return { error: "No command was provided." };

  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { error: `This command is blocked for safety: ${trimmed}` };
    }
  }

  for (const char of DANGEROUS_COMMAND_CHARACTERS) {
    if (trimmed.includes(char)) {
      return {
        error:
          "Command chaining, piping, redirection, and substitution are not allowed. Run one plain command at a time.",
      };
    }
  }

  if (!isCommandAllowed(trimmed)) {
    return {
      error: `Command not allowed: '${trimmed}'. Allowed command prefixes: ${getAllowedCommands()}`,
    };
  }

  const permissionError = runCommandRespectsReadPermissions(trimmed);
  if (permissionError) return permissionError;

  try {
    const parsedArgs = shlexSplit(trimmed);
    if (parsedArgs.length === 0) return { error: "No command was provided." };

    let args: string[];
    if (process.platform === "win32") {
      if (parsedArgs[0].toLowerCase() === "ls") {
        args = ["cmd", "/c", "dir", ...parsedArgs.slice(1)];
      } else {
        args = ["cmd", "/c", trimmed];
      }
    } else {
      args = parsedArgs;
    }

    const result = spawnSync(args[0], args.slice(1), {
      cwd: getProjectRoot(),
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === "ETIMEDOUT") return { error: "Command timed out after 60 seconds." };
      return { error: `Could not execute command: ${err.message}` };
    }

    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const stdoutTruncated = stdout.length > MAX_OUTPUT;
    const stderrTruncated = stderr.length > MAX_OUTPUT;
    const truncated = stdoutTruncated || stderrTruncated;

    const payload: Record<string, unknown> = {
      command: trimmed,
      returncode: result.status ?? 0,
      stdout: stdout.slice(0, MAX_OUTPUT),
      stderr: stderr.slice(0, MAX_OUTPUT),
      truncated,
    };
    if (truncated) {
      payload.truncation_note = `Output was truncated to ${MAX_OUTPUT} characters per stream so the model context is not overwhelmed.`;
    }
    return payload;
  } catch (exc: unknown) {
    return { error: `Could not execute command: ${String(exc)}` };
  }
}

reloadAllowedCommands();
