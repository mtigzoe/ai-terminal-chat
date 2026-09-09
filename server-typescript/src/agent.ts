import { Provider, ProviderResponse, ToolCall } from "./providers/base.ts";
import type { PendingAction, ResumeState } from "./pending.ts";

/**
 * Tokenize a shell command string, matching Python's shlex.split(posix=False)
 * behavior. This is used for direct command parsing (e.g., "read file.txt",
 * "git add path").
 *
 * Key behaviors (posix=False):
 * - Outside quotes: backslash is NOT an escape character; it's literal
 * - Inside double quotes: backslash escapes only '"' and '\\'
 * - Inside single quotes: no escaping; everything is literal until closing quote
 * - Quote characters are not included in the output tokens
 * - Whitespace separates tokens unless quoted
 */
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    // Whitespace separates tokens (outside quotes)
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }

    // Double-quoted string
    if (char === '"') {
      i++;
      while (i < command.length) {
        const c = command[i];
        if (c === '"') {
          i++;
          break;
        }
        // Inside double quotes, backslash escapes only " and \
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
      continue;
    }

    // Single-quoted string (no escaping inside)
    if (char === "'") {
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
      if (i < command.length && command[i] === "'") {
        i++;
      }
      continue;
    }

    // Regular character (outside quotes, backslash is literal)
    current += char;
    i++;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export const MAX_TOOL_ROUNDS = 10;
export const MAX_CONSECUTIVE_IDENTICAL_CALLS = 3;
export const HARD_ABORT_CONSECUTIVE_CALLS = 6;
export const MAX_CONSECUTIVE_ERRORS = 5;

const _INSPECT_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_files",
  "git_status",
  "git_committed_file_count",
  "git_diff",
  "git_log",
  "git_branch",
  "git_fetch",
]);
const _EXECUTE_TOOLS = new Set(["run_command"]);

const WRITE_TOOL_NAMES = new Set([
  "create_file",
  "write_file",
  "apply_patch",
  "delete_file",
]);
const GIT_CONFIRM_TOOL_NAMES = new Set([
  "git_add",
  "git_pull",
  "git_restore",
  "git_commit",
  "git_push",
]);

const TOOL_TIMEOUTS: Record<string, number> = {
  list_files: 5,
  read_file: 5,
  search_files: 15,
  run_command: 65,
  git_status: 10,
  git_committed_file_count: 10,
  git_diff: 10,
  git_log: 10,
  git_branch: 10,
  git_fetch: 15,
  git_pull: 30,
  git_restore: 15,
  git_commit: 15,
  git_push: 30,
  create_file: 5,
  write_file: 5,
  apply_patch: 35,
  delete_file: 5,
  git_add: 10,
};
const DEFAULT_TOOL_TIMEOUT = 15;

export interface AgentLoopOptions {
  provider: Provider;
  contents: unknown[];
  toolFunctions: Record<string, (args: Record<string, unknown>) => unknown>;
  cancelSignal?: AbortSignal;
  createPending: (
    toolName: string,
    args: Record<string, unknown>,
    preview: Record<string, unknown>,
    resume?: ResumeState
  ) => { action_id: string };
}

/** Identify a provider+model pair so a resumed loop can refuse to run
 * against a different backend than the one that produced its saved
 * `contents` (those are provider-specific objects and are not
 * interchangeable across providers). Mirrors agent.py's provider_fingerprint(). */
export function providerFingerprint(provider: Provider): string {
  const name = provider.name || provider.constructor.name;
  return `${name}:${provider.model || ""}`;
}

export interface ProgressEvent {
  type: "progress";
  phase: string;
  message: string;
  round?: number;
  max_rounds?: number;
  tool?: string;
  action_id?: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool_result";
  name: string;
  result: unknown;
}

export interface PendingConfirmationEvent {
  type: "pending_confirmation";
  action_id: string;
  name: string;
  args: Record<string, unknown>;
  preview: Record<string, unknown>;
}

export interface FinalEvent {
  type: "final";
  text: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface CancelledEvent {
  type: "cancelled";
}

export type AgentEvent =
  | ProgressEvent
  | ToolCallEvent
  | ToolResultEvent
  | PendingConfirmationEvent
  | FinalEvent
  | ErrorEvent
  | CancelledEvent;

function extractLastUserText(contents: unknown[]): string | null {
  for (let index = contents.length - 1; index >= 0; index--) {
    const item = contents[index];
    if (!item || typeof item !== "object") continue;

    const record = item as Record<string, unknown>;
    if (record.role !== "user") continue;

    const content = record.content;
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            const partRecord = part as Record<string, unknown>;
            return typeof partRecord.text === "string" ? partRecord.text : "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }

  return null;
}

function directReadCommand(contents: unknown[]): ProviderResponse | null {
  const userText = extractLastUserText(contents);
  if (!userText) return null;

  const command = userText.trim();
  let parts: string[];
  try {
    parts = tokenizeShellCommand(command);
  } catch {
    return null;
  }

  if (parts.length === 0) return null;

  const subcommand = parts[0].toLowerCase();

  if (subcommand === "read" || subcommand === "read_file") {
    if (parts.length < 2) {
      return {
        text: "Please specify a file to read. Usage: read <path>",
        tool_calls: [],
        raw: null,
      };
    }
    let path = parts[1];
    if (!path || path.startsWith("-")) return null;
    if (path.length >= 2 && path[0] === path[path.length - 1] && (path[0] === '"' || path[0] === "'")) {
      path = path.slice(1, -1);
    }
    return {
      text: null,
      tool_calls: [{ name: "read_file", args: { path } }],
      raw: null,
    };
  }

  return null;
}

function directGitCommand(contents: unknown[]): ProviderResponse | null {
  const userText = extractLastUserText(contents);
  if (!userText) return null;

  const command = userText.trim();
  let parts: string[];
  try {
    parts = tokenizeShellCommand(command);
  } catch {
    return null;
  }

  if (parts.length === 0 || parts[0].toLowerCase() !== "git") return null;

  const subcommand = parts[1]?.toLowerCase() ?? "";

  if (subcommand === "add") {
    if (parts.length === 3) {
      var path = parts[2];
    } else if (parts.length === 4 && parts[2] === "--") {
      path = parts[3];
    } else {
      return null;
    }
    if (!path || path.startsWith("-")) return null;
    if (path.length >= 2 && path[0] === path[path.length - 1] && (path[0] === '"' || path[0] === "'")) {
      path = path.slice(1, -1);
    }
    return {
      text: null,
      tool_calls: [{ name: "git_add", args: { path } }],
      raw: null,
    };
  }

  if (subcommand === "fetch") {
    const rest = parts.slice(2);
    if (rest.some((part) => part.startsWith("-"))) {
      return {
        text: "Unsupported git fetch option. The agent currently supports only: git fetch [remote]",
        tool_calls: [],
        raw: null,
      };
    }
    if (rest.length > 1) {
      return {
        text: "Unsupported git fetch syntax. The agent currently supports only: git fetch [remote]",
        tool_calls: [],
        raw: null,
      };
    }
    const remote = rest[0] ?? "";
    return {
      text: null,
      tool_calls: [{ name: "git_fetch", args: { remote } }],
      raw: null,
    };
  }

  if (subcommand === "pull") {
    const rest = parts.slice(2);
    if (rest.some((part) => part.startsWith("-"))) {
      return {
        text: "Unsupported git pull option. The agent currently supports only: git pull [remote] [branch]",
        tool_calls: [],
        raw: null,
      };
    }
    if (rest.length > 2) {
      return {
        text: "Unsupported git pull syntax. The agent currently supports only: git pull [remote] [branch]",
        tool_calls: [],
        raw: null,
      };
    }
    const remote = rest[0] ?? "";
    const branch = rest[1] ?? "";
    return {
      text: null,
      tool_calls: [{ name: "git_pull", args: { remote, branch } }],
      raw: null,
    };
  }

  if (subcommand === "restore") {
    const remaining = parts.slice(2);
    let staged = false;
    if (remaining.length > 0 && remaining[0] === "--staged") {
      staged = true;
      remaining.shift();
    }
    if (remaining.some((part) => part.startsWith("-"))) {
      return {
        text: "Unsupported git restore option. The agent currently supports only: git restore [--staged] <path>",
        tool_calls: [],
        raw: null,
      };
    }
    if (remaining.length !== 1) {
      return {
        text: "Git restore requires exactly one path. Use: git restore [--staged] <path>",
        tool_calls: [],
        raw: null,
      };
    }
    let path = remaining[0];
    if (path.length >= 2 && path[0] === path[path.length - 1] && (path[0] === '"' || path[0] === "'")) {
      path = path.slice(1, -1);
    }
    return {
      text: null,
      tool_calls: [{ name: "git_restore", args: { path, staged } }],
      raw: null,
    };
  }

  if (subcommand === "commit") {
    let message: string | null = null;
    let i = 2;
    while (i < parts.length) {
      const part = parts[i];
      if (part === "-m") {
        if (message !== null) {
          return {
            text: 'Git commit accepts one message. Use: git commit -m "your message"',
            tool_calls: [],
            raw: null,
          };
        }
        if (i + 1 >= parts.length) {
          return {
            text: 'Git commit requires a message. Use: git commit -m "your message"',
            tool_calls: [],
            raw: null,
          };
        }
        message = parts[i + 1];
        i += 2;
      } else if (part.startsWith("-m") && part.length > 2) {
        if (message !== null) {
          return {
            text: 'Git commit accepts one message. Use: git commit -m "your message"',
            tool_calls: [],
            raw: null,
          };
        }
        message = part.slice(2);
        i += 1;
      } else if (part.startsWith("-")) {
        return {
          text: 'Unsupported git commit option. The agent currently supports only: git commit -m "message"',
          tool_calls: [],
          raw: null,
        };
      } else {
        return {
          text: 'Unsupported git commit syntax. The agent currently supports only: git commit -m "message"',
          tool_calls: [],
          raw: null,
        };
      }
    }
    if (message) {
      if (message.length >= 2 && message[0] === message[message.length - 1] && (message[0] === '"' || message[0] === "'")) {
        message = message.slice(1, -1);
      }
      return {
        text: null,
        tool_calls: [{ name: "git_commit", args: { message } }],
        raw: null,
      };
    }
    return {
      text: 'Git commit requires a message. Use: git commit -m "your message"',
      tool_calls: [],
      raw: null,
    };
  }

  if (subcommand === "push") {
    const rest = parts.slice(2);
    if (rest.some((part) => part.startsWith("-"))) {
      return {
        text: "Unsupported git push option. The agent currently supports only: git push [remote] [branch]",
        tool_calls: [],
        raw: null,
      };
    }
    if (rest.length > 2) {
      return {
        text: "Unsupported git push syntax. The agent currently supports only: git push [remote] [branch]",
        tool_calls: [],
        raw: null,
      };
    }
    const remote = rest[0] ?? "";
    const branch = rest[1] ?? "";
    return {
      text: null,
      tool_calls: [{ name: "git_push", args: { remote, branch } }],
      raw: null,
    };
  }

  if (subcommand === "status" && parts.length === 2) {
    return {
      text: null,
      tool_calls: [{ name: "git_status", args: {} }],
      raw: null,
    };
  }

  if (subcommand === "branch" && parts.length === 3 && parts[2] === "--show-current") {
    return {
      text: null,
      tool_calls: [{ name: "run_command", args: { command } }],
      raw: null,
    };
  }

  return null;
}

interface CoreLoopOptions extends AgentLoopOptions {
  startRoundIndex: number;
  // undefined = fresh loop, call the model. An array (even empty) = resuming
  // mid-round: skip the model call and finish out these calls first. This
  // mirrors the None-vs-list distinction on seed_tool_calls in
  // server-python/agent.py's _agent_loop().
  seedToolCalls?: ToolCall[];
  seedToolResults?: { name: string; result: unknown }[];
  seedLastCallSignature?: [string, string] | null;
  seedConsecutiveRepeatCount?: number;
  seedConsecutiveErrorCount?: number;
}

/**
 * Core round loop, shared by a fresh runAgentLoop() call and by a
 * resumeAgentLoop() continuation. When seedToolCalls is given (even as an
 * empty array), the first iteration skips calling the model and instead
 * finishes out the in-progress round using the seeded calls and results —
 * this is how a resumed confirmation picks up mid-round. Mirrors
 * server-python/agent.py's `_agent_loop`.
 */
async function* agentLoopCore(
  options: CoreLoopOptions
): AsyncGenerator<AgentEvent, void, unknown> {
  const {
    provider,
    toolFunctions,
    cancelSignal,
    createPending,
    startRoundIndex,
    seedToolCalls,
    seedToolResults,
  } = options;

  let lastCallSignature: [string, string] | null =
    options.seedLastCallSignature ?? null;
  let consecutiveRepeatCount = options.seedConsecutiveRepeatCount ?? 0;
  let consecutiveErrorCount = options.seedConsecutiveErrorCount ?? 0;

  if (seedToolCalls === undefined) {
    yield {
      type: "progress",
      phase: "plan",
      message: "Planning next step",
      round: 1,
      max_rounds: MAX_TOOL_ROUNDS,
    };
  }

  let currentContents = options.contents;
  let pendingCalls: ToolCall[] | undefined = seedToolCalls;
  let pendingResults: { name: string; result: unknown }[] | undefined =
    seedToolResults;

  for (
    let roundIndex = startRoundIndex;
    roundIndex < MAX_TOOL_ROUNDS;
    roundIndex++
  ) {
    const roundNumber = roundIndex + 1;

    if (cancelSignal?.aborted) {
      yield {
        type: "progress",
        phase: "cancelled",
        message: "Stopped: cancelled by user",
        round: roundNumber,
        max_rounds: MAX_TOOL_ROUNDS,
      };
      yield { type: "cancelled" };
      return;
    }

    let currentToolCalls: ToolCall[];
    let toolResults: { name: string; result: unknown }[];

    if (pendingCalls !== undefined) {
      currentToolCalls = pendingCalls;
      toolResults = pendingResults ?? [];
      pendingCalls = undefined;
      pendingResults = undefined;
    } else {
      let response: ProviderResponse;
      try {
        let directResponse: ProviderResponse | null = null;
        if (roundIndex === 0) {
          directResponse = directReadCommand(currentContents);
          if (!directResponse) {
            directResponse = directGitCommand(currentContents);
          }
        }
        response = directResponse ?? (await provider.generate(currentContents));
      } catch (exc) {
        yield {
          type: "progress",
          phase: "error",
          message: `Provider failed: ${exc}`,
          round: roundNumber,
          max_rounds: MAX_TOOL_ROUNDS,
        };
        yield {
          type: "error",
          message: `${provider.constructor.name} error: ${exc}`,
        };
        return;
      }

      if (!response.tool_calls || response.tool_calls.length === 0) {
        if (!response.text) {
          yield {
            type: "progress",
            phase: "error",
            message: "Model returned no text and requested no further tools.",
            round: roundNumber,
            max_rounds: MAX_TOOL_ROUNDS,
          };
          yield {
            type: "error",
            message: "Model returned no text and requested no further tools.",
          };
          return;
        }

        yield {
          type: "progress",
          phase: "complete",
          message: "Task completed",
          round: roundNumber,
          max_rounds: MAX_TOOL_ROUNDS,
        };
        yield { type: "final", text: response.text };
        return;
      }

      currentContents = provider.appendModelTurn(currentContents, response);
      currentToolCalls = response.tool_calls;
      toolResults = [];
    }

    for (let callIndex = 0; callIndex < currentToolCalls.length; callIndex++) {
      const call = currentToolCalls[callIndex];

      if (cancelSignal?.aborted) {
        yield {
          type: "progress",
          phase: "cancelled",
          message: "Stopped: cancelled by user",
          round: roundNumber,
          max_rounds: MAX_TOOL_ROUNDS,
        };
        yield { type: "cancelled" };
        return;
      }

      const functionName = call.name;
      const functionArgs = { ...call.args };

      const { phase, message: progressMessage } = describeToolProgress(
        functionName,
        functionArgs
      );
      yield {
        type: "progress",
        phase,
        message: progressMessage,
        round: roundNumber,
        max_rounds: MAX_TOOL_ROUNDS,
        tool: functionName,
      };

      yield {
        type: "tool_call",
        name: functionName,
        args: functionArgs,
      };

      const callSignature: [string, string] = [
        functionName,
        JSON.stringify(normalizeArgs(functionArgs)),
      ];

      if (
        lastCallSignature &&
        callSignature[0] === lastCallSignature[0] &&
        callSignature[1] === lastCallSignature[1]
      ) {
        consecutiveRepeatCount++;
      } else {
        lastCallSignature = callSignature;
        consecutiveRepeatCount = 1;
      }

      const toolFn = toolFunctions[functionName];

      if (!toolFn) {
        const unknownResult = { error: `Unknown tool requested: ${functionName}.` };
        toolResults.push({
          name: functionName,
          result: unknownResult,
        });
        yield {
          type: "tool_result",
          name: functionName,
          result: unknownResult,
        };
        continue;
      }

      if (consecutiveRepeatCount > HARD_ABORT_CONSECUTIVE_CALLS) {
        yield {
          type: "progress",
          phase: "error",
          message: `Stopped after ${consecutiveRepeatCount} identical calls to ${functionName}.`,
          round: roundNumber,
          max_rounds: MAX_TOOL_ROUNDS,
          tool: functionName,
        };
        yield {
          type: "error",
          message: `Stopping: ${functionName} was called with the exact same arguments ${consecutiveRepeatCount} times in a row.`,
        };
        return;
      }

      if (consecutiveRepeatCount > MAX_CONSECUTIVE_IDENTICAL_CALLS) {
        const softBlockResult = {
          error: `${functionName} has already been called with these exact arguments ${
            consecutiveRepeatCount - 1
          } time(s) in a row.`,
        };
        toolResults.push({
          name: functionName,
          result: softBlockResult,
        });
        yield {
          type: "tool_result",
          name: functionName,
          result: softBlockResult,
        };
        continue;
      }

      let result: unknown;
      const isWriteTool =
        WRITE_TOOL_NAMES.has(functionName) ||
        GIT_CONFIRM_TOOL_NAMES.has(functionName);

      if (isWriteTool) {
        const previewArgs = { ...functionArgs, confirm: false };
        result = await executeTool(
          toolFn,
          previewArgs,
          functionName,
          TOOL_TIMEOUTS[functionName] || DEFAULT_TOOL_TIMEOUT
        );

        if (
          result &&
          typeof result === "object" &&
          !("error" in result) &&
          "requires_confirmation" in result
        ) {
          const preview = result as Record<string, unknown>;
          const resumeState: ResumeState = {
            provider_fingerprint: providerFingerprint(provider),
            contents: currentContents,
            round_index: roundIndex,
            tool_results: [...toolResults],
            remaining_calls: currentToolCalls.slice(callIndex),
            last_call_signature: lastCallSignature,
            consecutive_repeat_count: consecutiveRepeatCount,
            consecutive_error_count: consecutiveErrorCount,
          };
          const action = createPending(
            functionName,
            functionArgs,
            preview,
            resumeState
          );
          const path = functionArgs.path as string | undefined;
          let confirmMessage: string;
          if (functionName === "apply_patch") {
            confirmMessage = "Waiting for confirmation to apply patch";
          } else if (functionName === "git_add") {
            confirmMessage = path?.trim()
              ? `Waiting for confirmation to stage ${path}`
              : "Waiting for confirmation to stage file(s)";
          } else if (functionName === "git_restore") {
            const action = (preview as Record<string, unknown>).action as string || "restore";
            confirmMessage = path?.trim()
              ? `Waiting for confirmation to ${action} ${path}`
              : `Waiting for confirmation to ${action} file`;
          } else if (functionName === "git_commit") {
            confirmMessage = "Waiting for confirmation to commit";
          } else if (functionName === "git_push") {
            confirmMessage = "Waiting for confirmation to push";
          } else if (functionName === "git_pull") {
            confirmMessage = "Waiting for confirmation to pull";
          } else if (path?.trim()) {
            confirmMessage = `Waiting for confirmation to modify ${path}`;
          } else {
            confirmMessage = `Waiting for confirmation for ${functionName}`;
          }

          yield {
            type: "progress",
            phase: "confirm",
            message: confirmMessage,
            round: roundNumber,
            max_rounds: MAX_TOOL_ROUNDS,
            tool: functionName,
            action_id: action.action_id,
          };
          yield {
            type: "pending_confirmation",
            action_id: action.action_id,
            name: functionName,
            args: functionArgs,
            preview,
          };
          return;
        }
      } else {
        result = await executeTool(
          toolFn,
          functionArgs,
          functionName,
          TOOL_TIMEOUTS[functionName] || DEFAULT_TOOL_TIMEOUT
        );
      }

      // Reading a file outside the user's current Project-page selection is
      // a permission boundary, not a normal model/tool error. Pause here
      // and let the browser present an explicit Allow/Decline choice,
      // rather than handing the model a dead-end "Access denied" error.
      if (
        functionName === "read_file" &&
        result &&
        typeof result === "object" &&
        typeof (result as Record<string, unknown>).error === "string" &&
        ((result as Record<string, unknown>).error as string).startsWith("Access denied:")
      ) {
        const readPath = functionArgs.path as string | undefined;
        if (readPath?.trim()) {
          const resumeState: ResumeState = {
            provider_fingerprint: providerFingerprint(provider),
            contents: currentContents,
            round_index: roundIndex,
            tool_results: [...toolResults],
            remaining_calls: currentToolCalls.slice(callIndex),
            last_call_signature: lastCallSignature,
            consecutive_repeat_count: consecutiveRepeatCount,
            consecutive_error_count: consecutiveErrorCount,
          };
          const permissionPreview = {
            message: `The assistant wants to read '${readPath}'. Allowing this will add the file to your Project-page agent selection.`,
            permission_request: true,
          };
          const action = createPending(
            "read_file_permission",
            { path: readPath },
            permissionPreview,
            resumeState
          );

          yield {
            type: "progress",
            phase: "confirm",
            message: `Waiting for permission to read ${readPath}`,
            round: roundNumber,
            max_rounds: MAX_TOOL_ROUNDS,
            tool: "read_file",
            action_id: action.action_id,
          };
          yield {
            type: "pending_confirmation",
            action_id: action.action_id,
            name: "read_file_permission",
            args: { path: readPath },
            preview: permissionPreview,
          };
          return;
        }
      }

      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        (result as Record<string, unknown>).error
      ) {
        consecutiveErrorCount++;
      } else {
        consecutiveErrorCount = 0;
      }

      if (consecutiveErrorCount >= 3 && result && typeof result === "object") {
        const resultObj = { ...(result as Record<string, unknown>) };
        resultObj.recovery_hint =
          "Multiple consecutive tool failures have occurred. Stop repeating the same pattern.";
        yield {
          type: "progress",
          phase: "recover",
          message: `Recovery needed after ${consecutiveErrorCount} consecutive tool failures`,
          round: roundNumber,
          max_rounds: MAX_TOOL_ROUNDS,
          tool: functionName,
        };
        result = resultObj;
      }

      if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        yield {
          type: "progress",
          phase: "error",
          message: `Stopped after ${consecutiveErrorCount} consecutive tool failures.`,
          round: roundNumber,
          max_rounds: MAX_TOOL_ROUNDS,
        };
        yield {
          type: "error",
          message: `Stopping: ${consecutiveErrorCount} consecutive tool failures without a successful recovery.`,
        };
        return;
      }

      if (isSuccessfulWriteResult(result)) {
        const path = (result as Record<string, unknown>).path as
          | string
          | undefined;
        const verifyTarget = path?.trim() ? ` ${path}` : "";
        yield {
          type: "progress",
          phase: "verify",
          message: `Verifying changes${verifyTarget}`,
          round: roundNumber,
          max_rounds: MAX_TOOL_ROUNDS,
          tool: functionName,
        };
        if (result && typeof result === "object") {
          const resultObj = { ...(result as Record<string, unknown>) };
          resultObj.verification_hint =
            "A write operation succeeded. Verify the result next: read the affected file back and/or inspect git_diff.";
          result = resultObj;
        }
      }

      yield {
        type: "tool_result",
        name: functionName,
        result,
      };
      toolResults.push({ name: functionName, result });
    }

    currentContents = provider.appendToolResults(currentContents, toolResults);

    if (roundNumber < MAX_TOOL_ROUNDS) {
      yield {
        type: "progress",
        phase: "plan",
        message: "Planning next step",
        round: roundNumber + 1,
        max_rounds: MAX_TOOL_ROUNDS,
      };
    }
  }

  yield {
    type: "progress",
    phase: "error",
    message: "Exceeded maximum tool-calling rounds without a final response.",
    round: MAX_TOOL_ROUNDS,
    max_rounds: MAX_TOOL_ROUNDS,
  };
  yield {
    type: "error",
    message:
      "Model exceeded the maximum number of tool-calling rounds without producing a final response.",
  };
}

export async function* runAgentLoop(
  options: AgentLoopOptions
): AsyncGenerator<AgentEvent, void, unknown> {
  yield* agentLoopCore({ ...options, startRoundIndex: 0 });
}

export interface ResumeAgentLoopOptions {
  provider: Provider;
  action: PendingAction;
  confirmed: boolean;
  toolFunctions: Record<string, (args: Record<string, unknown>) => unknown>;
  cancelSignal?: AbortSignal;
  createPending: AgentLoopOptions["createPending"];
}

/**
 * Resume an agent loop that paused on `action` for confirmation.
 *
 * Executes (or, if declined, records the cancellation of) the tool call the
 * user just resolved, then continues the loop exactly as if it had never
 * paused: any further tool calls the model already queued up in the same
 * round are run next, and once the round is complete the model gets to see
 * the result and keep going. This is what lets a compound request like
 * "add, commit, and push" actually finish across several Allow clicks
 * instead of stopping after the first one. Mirrors
 * server-python/agent.py's `resume_agent_loop`.
 *
 * `action.resume` must be present — callers should fall back to a one-off
 * tool execution for legacy pending actions that don't carry loop state.
 */
export async function* resumeAgentLoop(
  options: ResumeAgentLoopOptions
): AsyncGenerator<AgentEvent, void, unknown> {
  const { provider, action, confirmed, toolFunctions, cancelSignal, createPending } =
    options;

  const resume = action.resume;
  if (!resume) {
    throw new Error(
      `Pending action ${action.action_id} has no saved loop state to resume.`
    );
  }

  const savedFingerprint = resume.provider_fingerprint;
  const currentFingerprint = providerFingerprint(provider);
  if (savedFingerprint && savedFingerprint !== currentFingerprint) {
    throw new Error(
      "Cannot resume this action because the selected AI provider/model differs from the provider/model that created the pending action."
    );
  }

  const remainingCalls = [...resume.remaining_calls];
  const call = remainingCalls.shift();
  if (!call) {
    throw new Error(
      `Pending action ${action.action_id} has no saved tool call to resume.`
    );
  }
  const functionName = call.name;
  const functionArgs = { ...call.args };

  let result: unknown;
  if (action.tool_name === "read_file_permission") {
    // The caller (routes.ts) is responsible for granting read access for
    // this path via runWithAllowedReadPaths() before this generator is
    // consumed, so the retried read below actually succeeds.
    if (confirmed) {
      const toolFn = toolFunctions["read_file"];
      if (!toolFn) {
        result = { error: "Unknown tool requested: read_file." };
      } else {
        result = await executeTool(
          toolFn,
          functionArgs,
          "read_file",
          TOOL_TIMEOUTS["read_file"] || DEFAULT_TOOL_TIMEOUT
        );
      }
    } else {
      result = { cancelled: true, message: "Action declined by user." };
    }
  } else if (confirmed) {
    const toolFn = toolFunctions[functionName];
    if (!toolFn) {
      result = { error: `Unknown tool requested: ${functionName}.` };
    } else {
      const confirmArgs = { ...functionArgs, confirm: true };
      result = await executeTool(
        toolFn,
        confirmArgs,
        functionName,
        TOOL_TIMEOUTS[functionName] || DEFAULT_TOOL_TIMEOUT
      );
    }
  } else {
    result = { cancelled: true, message: "Action declined by user." };
  }

  yield { type: "tool_result", name: functionName, result };

  const toolResults = [...resume.tool_results, { name: functionName, result }];

  yield* agentLoopCore({
    provider,
    contents: resume.contents,
    toolFunctions,
    cancelSignal,
    createPending,
    startRoundIndex: resume.round_index,
    seedToolCalls: remainingCalls,
    seedToolResults: toolResults,
    seedLastCallSignature: resume.last_call_signature,
    seedConsecutiveRepeatCount: resume.consecutive_repeat_count,
    seedConsecutiveErrorCount: resume.consecutive_error_count,
  });
}

async function executeTool(
  fn: (args: Record<string, unknown>) => unknown,
  args: Record<string, unknown>,
  name: string,
  timeoutSeconds: number
): Promise<unknown> {
  try {
    return await Promise.race([
      Promise.resolve(fn(args)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Tool ${name} exceeded its ${timeoutSeconds}s execution limit and was abandoned.`
              )
            ),
          timeoutSeconds * 1000
        )
      ),
    ]);
  } catch (exc) {
    if (
      exc instanceof Error &&
      exc.message.includes("exceeded its") &&
      exc.message.includes("execution limit")
    ) {
      return { error: exc.message };
    }
    if (exc instanceof TypeError) {
      return { error: `Malformed arguments for ${name}: ${exc}` };
    }
    return { error: `Tool ${name} failed: ${exc}` };
  }
}

function describeToolProgress(
  functionName: string,
  functionArgs: Record<string, unknown>
): { phase: string; message: string } {
  const path = functionArgs.path as string | undefined;
  const pathLabel = path?.trim() ? ` ${path}` : "";

  if (WRITE_TOOL_NAMES.has(functionName)) {
    const actionMap: Record<string, string> = {
      create_file: "create",
      write_file: "modify",
      apply_patch: "patch",
      delete_file: "delete",
    };
    const action = actionMap[functionName] || "change";
    if (functionName === "apply_patch") {
      return { phase: "confirm", message: "Preparing to patch file(s)" };
    }
    return { phase: "confirm", message: `Preparing to ${action}${pathLabel || " file(s)"}` };
  }

  if (GIT_CONFIRM_TOOL_NAMES.has(functionName)) {
    const path = functionArgs.path as string | undefined;
    const pathLabel = path?.trim() ? ` ${path}` : "";

    if (functionName === "git_add") {
      return {
        phase: "confirm",
        message: `Preparing to stage${pathLabel || " file(s)"}`,
      };
    }

    if (functionName === "git_restore") {
      const action = (functionArgs.action as string | undefined) || "restore";
      return {
        phase: "confirm",
        message: `Preparing to ${action}${pathLabel || " file"}`,
      };
    }

    if (functionName === "git_commit") {
      return { phase: "confirm", message: "Preparing to commit" };
    }

    if (functionName === "git_push") {
      return { phase: "confirm", message: "Preparing to push" };
    }

    if (functionName === "git_pull") {
      return { phase: "confirm", message: "Preparing to pull" };
    }

    return {
      phase: "confirm",
      message: `Preparing to stage${pathLabel || " file(s)"}`,
    };
  }

  if (_INSPECT_TOOLS.has(functionName)) {
    const inspectMap: Record<string, string> = {
      read_file: `Inspecting${pathLabel || " file"}`,
      list_files: `Listing files in${pathLabel || " project"}`,
      search_files: `Searching project${(functionArgs.query ? ` for '${functionArgs.query}'` : "")}`,
      git_status: "Checking git status",
      git_committed_file_count: "Counting files in the current commit",
      git_diff: `Inspecting git diff${pathLabel}`,
      git_log: "Inspecting recent commits",
      git_branch: "Listing git branches",
      git_fetch: "Fetching from remote",
    };
    return { phase: "inspect", message: inspectMap[functionName] || `Inspecting via ${functionName}` };
  }

  if (_EXECUTE_TOOLS.has(functionName)) {
    const command = functionArgs.command as string | undefined;
    if (command) {
      const short =
        command.length <= 60 ? command : command.slice(0, 57) + "...";
      return { phase: "execute", message: `Running command: ${short}` };
    }
    return { phase: "execute", message: "Running command" };
  }

  return { phase: "execute", message: `Calling ${functionName}` };
}

function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    if (key === "path" && typeof value === "string") {
      let normalizedPath = value.trim();
      while (normalizedPath.startsWith("./")) {
        normalizedPath = normalizedPath.slice(2);
      }
      normalized[key] = normalizedPath;
    } else {
      normalized[key] = JSON.stringify(value);
    }
  }
  return normalized;
}

function isSuccessfulWriteResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  if (record.error) return false;
  return !!(
    record.created ||
    record.overwritten !== undefined ||
    record.applied ||
    record.deleted ||
    record.staged ||
    record.committed ||
    record.pushed ||
    record.pulled ||
    record.restored ||
    record.unstaged ||
    record.bytes_written !== undefined
  );
}
