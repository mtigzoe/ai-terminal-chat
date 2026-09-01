import { Provider, ProviderResponse } from "./providers/base.ts";

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
    preview: Record<string, unknown>
  ) => { action_id: string };
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

function directGitCommand(contents: unknown[]): ProviderResponse | null {
  const userText = extractLastUserText(contents);
  if (!userText) return null;

  const command = userText.trim();
  const addMatch = command.match(/^git\s+add\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);

  if (addMatch) {
    const path = addMatch[1] ?? addMatch[2] ?? addMatch[3];
    if (!path || path.startsWith("-")) return null;
    return {
      text: null,
      tool_calls: [{ name: "git_add", args: { path } }],
      raw: null,
    };
  }

  const fetchMatch = command.match(/^git\s+fetch\s+(?:(\S+))?\s*$/i);
  if (fetchMatch) {
    return {
      text: null,
      tool_calls: [{ name: "git_fetch", args: { remote: fetchMatch[1] ?? "" } }],
      raw: null,
    };
  }

  const pullMatch = command.match(/^git\s+pull\s+(?:(\S+)\s+(?:(\S+))?)?\s*$/i);
  if (pullMatch) {
    return {
      text: null,
      tool_calls: [{ name: "git_pull", args: { remote: pullMatch[1] ?? "", branch: pullMatch[2] ?? "" } }],
      raw: null,
    };
  }

  const restoreMatch = command.match(/^git\s+restore\s+(?:--staged\s+)?(?:(\S+))\s*$/i);
  if (restoreMatch) {
    const staged = command.includes("--staged");
    const pathMatch = command.match(/(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
    const path = pathMatch ? (pathMatch[1] ?? pathMatch[2] ?? pathMatch[3]) : "";
    if (!path) return null;
    return {
      text: null,
      tool_calls: [{ name: "git_restore", args: { path, staged } }],
      raw: null,
    };
  }

  const commitMatch = command.match(/^git\s+commit\s+(?:-m\s+(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*$/i);
  if (commitMatch) {
    const message = commitMatch[1] ?? commitMatch[2] ?? commitMatch[3];
    if (message) {
      return {
        text: null,
        tool_calls: [{ name: "git_commit", args: { message } }],
        raw: null,
      };
    }
    return {
      text: "Git commit requires a message. Use: git commit -m \"your message\"",
      tool_calls: [],
      raw: null,
    };
  }

  const pushMatch = command.match(/^git\s+push\s+(?:(\S+)\s+(?:(\S+))?)?\s*$/i);
  if (pushMatch) {
    return {
      text: null,
      tool_calls: [{ name: "git_push", args: { remote: pushMatch[1] ?? "", branch: pushMatch[2] ?? "" } }],
      raw: null,
    };
  }

  if (/^git\s+status\s*$/i.test(command)) {
    return {
      text: null,
      tool_calls: [{ name: "git_status", args: {} }],
      raw: null,
    };
  }

  if (/^git\s+branch\s+--show-current\s*$/i.test(command)) {
    return {
      text: null,
      tool_calls: [{ name: "run_command", args: { command } }],
      raw: null,
    };
  }

  return null;
}

export async function* runAgentLoop(
  options: AgentLoopOptions
): AsyncGenerator<AgentEvent, void, unknown> {
  const {
    provider,
    contents,
    toolFunctions,
    cancelSignal,
    createPending,
  } = options;

  let lastCallSignature: [string, string] | null = null;
  let consecutiveRepeatCount = 0;
  let consecutiveErrorCount = 0;

  yield {
    type: "progress",
    phase: "plan",
    message: "Planning next step",
    round: 1,
    max_rounds: MAX_TOOL_ROUNDS,
  };

  let currentContents = contents;

  for (let roundIndex = 0; roundIndex < MAX_TOOL_ROUNDS; roundIndex++) {
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

    let response: ProviderResponse;
    try {
      const directResponse = roundIndex === 0 ? directGitCommand(currentContents) : null;
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
    const toolResults: { name: string; result: unknown }[] = [];

    for (const call of response.tool_calls) {
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
          const action = createPending(functionName, functionArgs, preview);
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
