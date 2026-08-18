// Backend tool definitions and controlled tool execution.
//
// This module is the TypeScript tool registry. It keeps the tool names and
// argument contracts aligned with types.ts while delegating security and
// execution to the focused filesystem, terminal, and git modules.

import { gitAdd, gitBranch, gitDiff, gitLog, gitStatus } from "./git.js";
import { listFiles, readFile, searchFiles } from "./filesystem.js";
import {
  addAllowedCommand,
  getAllowedCommands,
  reloadAllowedCommands,
  removeAllowedCommand,
  runCommand,
} from "./terminal.js";
import type { ToolArgsByName, ToolName, ToolResult } from "./types.js";

export type ToolHandler<Name extends ToolName> = (
  args: ToolArgsByName[Name],
) => ToolResult | Promise<ToolResult>;

/** Runtime handlers implemented by the current migration phase. */
export const TOOL_FUNCTIONS = {
  list_files: (args: ToolArgsByName["list_files"]) => listFiles(args.path ?? "."),
  read_file: (args: ToolArgsByName["read_file"]) => readFile(args.path),
  search_files: (args: ToolArgsByName["search_files"]) => searchFiles(args.query, args.path ?? "."),
  run_command: (args: ToolArgsByName["run_command"]) => runCommand(args.command),
  git_status: () => gitStatus(),
  git_diff: (args: ToolArgsByName["git_diff"]) => gitDiff(args.path ?? "", args.staged ?? false),
  git_log: (args: ToolArgsByName["git_log"]) => gitLog(args.max_count ?? 10),
  git_branch: () => gitBranch(),
  git_add: (args: ToolArgsByName["git_add"]) => gitAdd(args.path, args.confirm ?? false),
} satisfies Partial<Record<ToolName, (args: never) => ToolResult | Promise<ToolResult>>>;

/**
 * Execute a named tool with runtime argument validation kept intentionally
 * small; individual tools perform the security-sensitive validation.
 */
export async function executeTool(name: ToolName, args: Record<string, unknown> = {}): Promise<ToolResult> {
  switch (name) {
    case "list_files":
      return listFiles(typeof args.path === "string" ? args.path : ".");
    case "read_file":
      return typeof args.path === "string" ? readFile(args.path) : { error: "path is required." };
    case "search_files":
      return typeof args.query === "string"
        ? searchFiles(args.query, typeof args.path === "string" ? args.path : ".")
        : { error: "query is required." };
    case "run_command":
      return typeof args.command === "string" ? runCommand(args.command) : { error: "command is required." };
    case "git_status":
      return gitStatus();
    case "git_diff":
      return gitDiff(typeof args.path === "string" ? args.path : "", args.staged === true);
    case "git_log":
      return gitLog(typeof args.max_count === "number" ? args.max_count : 10);
    case "git_branch":
      return gitBranch();
    case "git_add":
      return typeof args.path === "string"
        ? gitAdd(args.path, args.confirm === true)
        : { error: "path is required." };
    default:
      return { error: `Tool '${name}' is not implemented in the current migration phase.` };
  }
}

/** Current persisted/runtime terminal command allowlist. */
export function listAllowedCommands(): string[] {
  return getAllowedCommands();
}

/** Reload the terminal allowlist from ~/.ai-terminal-chat/config.json. */
export function reloadToolConfiguration(): string[] {
  return reloadAllowedCommands();
}

/** Add a safe terminal prefix through the same persistence path used by the UI/API. */
export function allowCommand(prefix: string): string[] {
  return addAllowedCommand(prefix);
}

/** Remove a terminal prefix through the same persistence path used by the UI/API. */
export function disallowCommand(prefix: string): string[] {
  return removeAllowedCommand(prefix);
}
