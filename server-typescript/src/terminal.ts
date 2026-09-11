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
import {
  getAllowedReadPaths,
  getProjectRoot,
  isReadAllowed,
} from "./security.ts";
import { runIsolatedGit } from "./git.ts";
import { resolveTrustedExecutable, TrustedExecutableError } from "./trusted-exec.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_ALLOWED_COMMAND_PREFIXES = [
  "git status",
  "git branch --list",
  "git branch --show-current",
  "git log",
  "git diff",
  "git show",
  "git remote -v",
  "pwd",
  "dir",
  "ls",
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
] as const;

export const DANGEROUS_COMMAND_CHARACTERS = [
  ";",
  "&",
  "|",
  "`",
  "$(",
  ">",
  "<",
  "\n",
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
  "git pull",
  "git add",
  // Destructive git branch options (read-only "git branch --list" is safe)
  "git branch -d",
  "git branch -D",
  "git branch -m",
  "git branch -M",
  "git branch -c",
  "git branch -C",
  // Destructive git remote options (read-only "git remote -v" is safe)
  // Remote URLs may contain embedded credentials (for example, HTTPS tokens).
  "git remote add",
  "git remote set-url",
  "git remote remove",
  "git remote rename",
  "git remote set-head",
  // Broad execution prefixes that enable arbitrary code execution
  "wsl",
  "uv run",
] as const;

// These executables are intentionally allowed only through narrowly scoped
// prefixes in DEFAULT_ALLOWED_COMMAND_PREFIXES. A user must not be able to
// add the bare executable because arguments such as `-e`, `-c`, or arbitrary
// package/script names can turn the terminal allowlist into arbitrary code
// execution.
const FORBIDDEN_BROAD_EXECUTABLE_PREFIXES = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "python.exe",
  "python3.exe",
  "py",
  "perl",
  "ruby",
  "php",
  "pwsh",
  "powershell",
  "bash",
  "sh",
  "zsh",
  "cmd",
  "cmd.exe",
  "npx",
  "npm",
  "pip",
  "pip3",
  "pipx",
  "pytest",
  "uv",
]);

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

let allowedCommandPrefixes: string[] = [...DEFAULT_ALLOWED_COMMAND_PREFIXES];

function normalizePrefix(prefix: string): string {
  return (prefix ?? "").trim();
}

/** True if a proposed allowlist prefix must be rejected for safety reasons. */
export function isForbiddenPrefix(prefix: string): boolean {
  const normalized = normalizePrefix(prefix).toLowerCase();

  if (!normalized) return true;

  // Path-qualified executables must never be added to the allowlist.
  if (
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..") ||
    /^[a-z]:[\\/]/.test(normalized) ||
    normalized.startsWith("\\\\")
  ) {
    return true;
  }

  if (DANGEROUS_COMMAND_CHARACTERS.some((character) => normalized.includes(character))) {
    return true;
  }

  // Explicit denylist prefixes (git push, rm, wsl, uv run, …).
  const hasForbiddenMatch = FORBIDDEN_ALLOWED_COMMAND_PREFIXES.some(
    (forbidden) =>
      normalized === forbidden ||
      normalized.startsWith(`${forbidden} `) ||
      forbidden.startsWith(`${normalized} `),
  );
  if (hasForbiddenMatch) {
    return true;
  }

  // Intentional narrow defaults that use tools which are otherwise broad
  // execution surfaces. These must remain addable/persistable.
  const safeDefaults = new Set(
    DEFAULT_ALLOWED_COMMAND_PREFIXES.map((item) => item.toLowerCase()),
  );
  if (safeDefaults.has(normalized)) {
    return false;
  }

  // Leading executable token (strip common Windows extensions).
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const rawExe = tokens[0] ?? "";
  const exe = rawExe.replace(/\.(exe|cmd|bat)$/i, "");

  if (FORBIDDEN_BROAD_EXECUTABLE_PREFIXES.has(rawExe) || FORBIDDEN_BROAD_EXECUTABLE_PREFIXES.has(exe)) {
    // Bare interpreter / package manager — always forbidden.
    if (tokens.length === 1) {
      return true;
    }

    // Dangerous interpreter / shell flags enable arbitrary code execution.
    const rest = tokens.slice(1).join(" ");
    const dangerousFlag =
      /^(-e|--eval|-p|--print|-c|-r|--run|\/c|\/k|-command|-encodedcommand)\b/.test(
        rest,
      );
    if (dangerousFlag) {
      return true;
    }

    // npx / npm exec / npm explore always escalate to arbitrary packages/scripts.
    if (exe === "npx" || (exe === "npm" && (tokens[1] === "exec" || tokens[1] === "explore"))) {
      return true;
    }

    // Bare "npm run" (without a known safe script) allows any package.json script.
    if (exe === "npm" && tokens[1] === "run") {
      const npmRunPrefix = tokens.slice(0, 3).join(" ");
      const safeNpmRun = new Set(["npm run test", "npm run build", "npm run lint"]);
      if (!safeNpmRun.has(npmRunPrefix)) {
        return true;
      }
      return false;
    }

    // "python -m X" only safe for pytest (default allowlist).
    if ((exe === "python" || exe === "python3" || exe === "py") && tokens[1] === "-m") {
      if (tokens[2] === "pytest") {
        return false;
      }
      return true;
    }

    // Version probes that match the spirit of the defaults.
    if (rest === "--version" || rest === "-v" || rest === "-V") {
      return false;
    }

    // Any other use of a broad executable as an allowlist prefix is rejected.
    return true;
  }

  return false;
}

function loadAllowedCommandsFromConfig(): string[] | null {
  const raw = loadAppConfig().allowed_commands;
  if (!Array.isArray(raw)) return null;

  const prefixes = raw
    .filter((item): item is string => typeof item === "string")
    .map(normalizePrefix)
    .filter((prefix) => Boolean(prefix) && !isForbiddenPrefix(prefix));

  return prefixes.length > 0 ? prefixes : null;
}

/** Write the current allowlist to the configuration file. */
export function persistAllowedCommands(prefixes: string[]): void {
  const config = loadAppConfig();
  config.allowed_commands = [...prefixes];
  persistAppConfig(config);
}

/** Reload the runtime allowlist from the shared configuration file. */
export function reloadAllowedCommands(): string[] {
  allowedCommandPrefixes =
    loadAllowedCommandsFromConfig() ?? [...DEFAULT_ALLOWED_COMMAND_PREFIXES];

  return getAllowedCommands();
}

/** Return the active allowlist in deterministic order. */
export function getAllowedCommands(): string[] {
  return [...allowedCommandPrefixes].sort();
}

/** Add a safe command prefix and persist the updated list. */
export function addAllowedCommand(prefix: string): string[] {
  const normalized = normalizePrefix(prefix);

  if (!normalized) {
    throw new Error("A non-empty command prefix is required.");
  }

  if (isForbiddenPrefix(normalized)) {
    throw new Error(
      `Command prefix '${normalized}' is not permitted for safety reasons.`,
    );
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

  if (!normalized) {
    throw new Error("A non-empty command prefix is required.");
  }

  const index = allowedCommandPrefixes.indexOf(normalized);

  if (index < 0) {
    throw new Error(
      `Command prefix '${normalized}' is not in the allowlist.`,
    );
  }

  allowedCommandPrefixes.splice(index, 1);
  persistAllowedCommands(allowedCommandPrefixes);

  return getAllowedCommands();
}

/** Replace the runtime allowlist without persisting it; intended for tests.
 *
 * Uses Array.splice to mutate the existing array in place so that any
 * closure or imported binding that captured the original reference
 * (e.g. addAllowedCommand / removeAllowedCommand) continues to observe
 * mutations on the same object.
 */
export function __setAllowedCommandsForTests(prefixes: string[]): void {
  allowedCommandPrefixes.splice(0, allowedCommandPrefixes.length, ...prefixes);
}

/** True when a command matches an allowed prefix (arguments permitted).
 *
 * The command is normalized by tokenizing it and rejoining with single
 * spaces before matching, so leading/trailing whitespace, repeated spaces,
 * and tabs do not affect the result.
 */
export function isCommandAllowed(command: string): boolean {
  let normalized: string;
  try {
    normalized = tokenizeCommand(command).join(" ");
  } catch {
    normalized = command.trim();
  }

  return allowedCommandPrefixes.some(
    (prefix) =>
      normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

/**
 * Tokenize one plain command without invoking a shell, matching Python's
 * shlex.split(posix=False) behavior. Supports whitespace, single/double quotes,
 * and backslash escaping inside double quotes. Backslash is literal outside quotes.
 * Shell operators are rejected before tokenization, so this parser never needs
 * to implement shell syntax.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;
  let inQuotes = false;
  let lastWasQuoted = false;

  while (i < command.length) {
    const char = command[i];

    // Whitespace separates tokens (outside quotes)
    if (/\s/.test(char) && !inQuotes) {
      if (current || lastWasQuoted) {
        tokens.push(current);
        current = "";
        lastWasQuoted = false;
      }
      i++;
      continue;
    }

    // Double-quoted string
    if (char === '"') {
      inQuotes = true;
      i++;
      let foundClosingQuote = false;
      while (i < command.length) {
        const c = command[i];
        if (c === '"') {
          i++;
          foundClosingQuote = true;
          break;
        }
        // Inside double quotes, backslash escapes only " and \\
        if (c === "\\" && i + 1 < command.length) {
          const next = command[i + 1];
          if (next === '"' || next === "\\") {
            current += next;
            i += 2;
            continue;
          }
        }
        current += c;
        i++;
      }
      inQuotes = false;
      if (!foundClosingQuote) {
        throw new Error("Unterminated double quote");
      }
      lastWasQuoted = true;
      continue;
    }

    // Single-quoted string (no escaping inside)
    if (char === "'") {
      inQuotes = true;
      i++;
      let foundClosingQuote = false;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
      if (i < command.length && command[i] === "'") {
        i++;
        foundClosingQuote = true;
      }
      inQuotes = false;
      if (!foundClosingQuote) {
        throw new Error("Unterminated single quote");
      }
      lastWasQuoted = true;
      continue;
    }

    // Regular character (outside quotes, backslash is literal)
    current += char;
    lastWasQuoted = false;
    i++;
  }

  // Handle trailing token (including empty quoted string at end)
  if (current || lastWasQuoted) {
    tokens.push(current);
  }

  return tokens;
}

function commandReadsFileContents(command: string): boolean {
  const trimmed = command.trim();

  const prefixes = [
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

  return prefixes.some(
    (prefix) =>
      trimmed === prefix ||
      trimmed.startsWith(prefix + " ") ||
      trimmed.toLowerCase().startsWith(prefix.toLowerCase() + " "),
  );
}

function contentPathArguments(command: string): string[] {
  const args = tokenizeCommand(command);

  if (args.length < 2) return [];

  return args
    .slice(1)
    .filter((arg) => arg && !arg.startsWith("-"));
}

function gitShowPathAllowed(arg: string): boolean {
  const colon = arg.indexOf(":");

  if (colon >= 0 && colon + 1 < arg.length) {
    return isReadAllowed(arg.slice(colon + 1));
  }

  return false;
}

function runCommandRespectsReadPermissions(
  command: string,
): string | null {
  const allowed = getAllowedReadPaths();

  if (allowed === undefined || !commandReadsFileContents(command)) {
    return null;
  }

  const args = contentPathArguments(command);
  const lower = command.toLowerCase();

  if (lower.startsWith("git show ")) {
    let fullArgs: string[];
    try {
      fullArgs = tokenizeCommand(command);
    } catch {
      fullArgs = command.trim().split(/\s+/);
    }

    const argsAfterShow = fullArgs.slice(2);

    if (
      argsAfterShow.some(
        (arg) => arg === "--name-only" || arg === "--name-status"
      )
    ) {
      return null;
    }

    const hasContentFlag = argsAfterShow.some((arg) => {
      if (arg === "--patch" || arg === "-p" || arg === "--oneline") {
        return true;
      }
      if (arg === "--unified") {
        return true;
      }
      if (arg.startsWith("--unified=")) {
        return true;
      }
      if (arg === "--format" || arg === "--pretty") {
        return true;
      }
      if (arg.startsWith("--format=") || arg.startsWith("--pretty=")) {
        return true;
      }
      return false;
    });

    if (hasContentFlag) {
      return (
        "Access denied: git show can expose file contents. " +
        "Remove content-producing flags or use --no-patch/--stat/--name-only."
      );
    }

    const noContentFlags = new Set(["--no-patch", "--quiet", "--stat"]);
    if (argsAfterShow.some((arg) => noContentFlags.has(arg))) {
      return null;
    }

    const explicitPaths: string[] = [];
    let pastDoubleDash = false;

    for (let i = 2; i < fullArgs.length; i++) {
      const arg = fullArgs[i];
      if (arg === "--") {
        pastDoubleDash = true;
        continue;
      }
      if (pastDoubleDash) {
        explicitPaths.push(arg);
      } else if (!arg.startsWith("-") && arg.includes(":")) {
        explicitPaths.push(arg.slice(arg.indexOf(":") + 1));
      }
    }

    if (explicitPaths.length === 0) {
      return (
        "Access denied: git show can expose file contents. " +
        "Use --no-patch, --stat, --name-only, or specify an allowed file path."
      );
    }

    if (explicitPaths.every((path) => isReadAllowed(path))) {
      return null;
    }

    return (
      "Access denied: git show can expose file contents and the requested " +
      "file was not selected on the Project page."
    );
  }

  if (lower === "git diff" || lower.startsWith("git diff ")) {
    if (
      args.length > 0 &&
      args.every((arg) => arg === "--" || isReadAllowed(arg))
    ) {
      const realPaths = args.filter((arg) => arg !== "--");

      if (
        realPaths.length > 0 &&
        realPaths.every((arg) => isReadAllowed(arg))
      ) {
        return null;
      }
    }

    return (
      "Access denied: git diff can expose file contents and is blocked " +
      "unless it is scoped to selected files."
    );
  }

  if (args.length > 0 && args.every((arg) => isReadAllowed(arg))) {
    return null;
  }

  return `Access denied for ${
    args.join(", ") || "the requested file"
  }: this command can read arbitrary file contents and is blocked while agent file selection is active. Select the file on the Project page first.`;
}

function commandBlocked(command: string): string | null {
  let tokens: string[];
  try {
    tokens = tokenizeCommand(command);
  } catch {
    tokens = command.trim().split(/\s+/);
  }

  if (tokens.length === 0) {
    return null;
  }

  const cmd = tokens[0].toLowerCase();

  const blockedCommands = new Set([
    "rm",
    "del",
    "rmdir",
    "remove-item",
    "sudo",
    "shutdown",
    "reboot",
    "format",
    "diskpart",
    "mkfs",
    "dd",
    "chmod",
    "chown",
    "printenv",
  ]);

  if (blockedCommands.has(cmd)) {
    if (cmd === "rm" && tokens.length >= 2 && tokens[1] === "-rf") {
      return `This command is blocked for safety: ${command}`;
    }
    return `This command is blocked for safety: ${command}`;
  }

  const blockedPrefixes = [
    "git reset",
    "git clean",
    "git push",
    "git commit",
    "git pull",
    "git add",
  ];

  const normalizedCommand = tokens.join(" ").toLowerCase();
  for (const prefix of blockedPrefixes) {
    if (normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")) {
      return `This command is blocked for safety: ${command}`;
    }
  }

  if (/\.env\b/i.test(command)) {
    return `This command is blocked for safety: ${command}`;
  }
  if (/\bcredential/i.test(command)) {
    return `This command is blocked for safety: ${command}`;
  }
  if (/\bid_rsa\b/i.test(command)) {
    return `This command is blocked for safety: ${command}`;
  }

  if (
    DANGEROUS_COMMAND_CHARACTERS.some((character) =>
      command.includes(character),
    )
  ) {
    return (
      "Command chaining, piping, redirection, and substitution are not " +
      "allowed. Run one plain command at a time."
    );
  }

  return null;
}

function executableForCommand(args: string[]): {
  file: string;
  args: string[];
} {
  const projectRoot = getProjectRoot();

  if (process.platform === "win32" && args.length > 0) {
    const command = args[0].toLowerCase();

    if (command === "pwd") {
      return {
        file: resolveTrustedExecutable("cmd", { projectRoot }),
        args: ["/c", "cd"],
      };
    }

    if (command === "dir" || command === "ls") {
      return {
        file: resolveTrustedExecutable("cmd", { projectRoot }),
        args: ["/c", "dir", ...args.slice(1)],
      };
    }
  }

  return {
    file: resolveTrustedExecutable(args[0], { projectRoot }),
    args: args.slice(1),
  };
}

function capOutput(value: string): {
  value: string;
  truncated: boolean;
} {
  return {
    value: value.slice(0, MAX_OUTPUT_CHARS),
    truncated: value.length > MAX_OUTPUT_CHARS,
  };
}

/** Environment variable names that must not be inherited by terminal
 * subprocesses. Project-controlled scripts (npm lifecycle, pytest plugins,
 * etc.) must not observe provider API keys from the server process. */
const SENSITIVE_ENV_VAR_NAMES = new Set([
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "KILO_API_KEY",
  "API_AUTH_TOKEN",
  "AI_TERMINAL_CHAT_HEALTH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
]);

function sanitizedTerminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SENSITIVE_ENV_VAR_NAMES) {
    delete env[name];
  }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper.endsWith("_API_KEY") ||
      upper.endsWith("_SECRET") ||
      upper.endsWith("_TOKEN") ||
      upper.includes("PASSWORD")
    ) {
      delete env[key];
    }
  }
  return env;
}

/** Execute one allowlisted command in the configured project root. */
export async function runCommand(
  command: string,
): Promise<RunCommandResult> {
  if (!command || !command.trim()) {
    return { error: "No command was provided." };
  }

  const normalized = command.trim();

  const blocked = commandBlocked(normalized);
  if (blocked) {
    return { error: blocked };
  }

  if (!isCommandAllowed(normalized)) {
    return {
      error:
        `Command not allowed: '${normalized}'. ` +
        `Allowed command prefixes: ${JSON.stringify(getAllowedCommands())}`,
    };
  }

  const permissionError =
    runCommandRespectsReadPermissions(normalized);

  if (permissionError) {
    return { error: permissionError };
  }

  let args: string[];

  try {
    args = tokenizeCommand(normalized);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (args.length === 0) {
    return { error: "No command was provided." };
  }

  let file: string;
  let fileArgs: string[];
  try {
    ({ file, args: fileArgs } = executableForCommand(args));
  } catch (err) {
    if (err instanceof TrustedExecutableError) {
      return { error: err.message };
    }
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Allowlisted `git …` commands share the same hardened execution
  // boundary as git.ts (isolated GIT_CONFIG, SSH, helpers, pager).
  // Detect by original token, not the resolved absolute path.
  if (args[0].toLowerCase() === "git") {
    try {
      const result = await runIsolatedGit(fileArgs, {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_CHARS * 2,
      });

      const out = capOutput(String(result.stdout ?? ""));
      const err = capOutput(String(result.stderr ?? ""));
      const truncated = out.truncated || err.truncated;

      const payload: RunCommandResult = {
        command: normalized,
        returncode: result.code,
        stdout: out.value,
        stderr: err.value,
        truncated,
      };

      if (truncated) {
        payload.truncation_note =
          `Output was truncated to ${MAX_OUTPUT_CHARS} ` +
          "characters per stream.";
      }

      return payload;
    } catch (err) {
      const error = err as NodeJS.ErrnoException & {
        code?: number | string;
        killed?: boolean;
        signal?: string;
      };

      if (error.code === "ETIMEDOUT" || (error.killed && error.signal === "SIGTERM")) {
        return {
          error:
            `Command timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.`,
        };
      }

      if (error.code === "ENOENT") {
        return { error: "git is not installed or not on PATH." };
      }

      return {
        error: `Could not execute command: ${
          error instanceof Error ? error.message : String(err)
        }`,
      };
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      file,
      fileArgs,
      {
        cwd: getProjectRoot(),
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_CHARS * 2,
        encoding: "utf8",
        env: sanitizedTerminalEnv(),
      },
    );

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
      payload.truncation_note =
        `Output was truncated to ${MAX_OUTPUT_CHARS} ` +
        "characters per stream.";
    }

    return payload;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };

    if (error.killed && error.signal === "SIGTERM") {
      return {
        error:
          `Command timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.`,
      };
    }

    if (error.code === "ENOENT") {
      return {
        error:
          `${args[0]} is not installed or not on PATH.`,
      };
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
        payload.truncation_note =
          `Output was truncated to ${MAX_OUTPUT_CHARS} ` +
          "characters per stream.";
      }

      return payload;
    }

    return {
      error:
        `Could not execute command: ${
          error.message ?? String(err)
        }`,
    };
  }
}

// Initialize from persisted configuration when the module is loaded.
reloadAllowedCommands();
