import { Provider, ProviderCapabilities, ProviderResponse } from "./base.ts";

export class StubProvider extends Provider {
  constructor(
    public name: string,
    public model: string,
    capabilities?: Partial<ProviderCapabilities>
  ) {
    super();
    this.capabilities = {
      tools: false,
      streaming: false,
      model_listing: false,
      requires_api_key: false,
      local: false,
      notes: "",
      ...capabilities,
    };
  }

  buildContents(msg: string, history: unknown[]): unknown[] {
    return [...history, { role: "user", content: msg }];
  }

  async generate(_contents: unknown[]): Promise<ProviderResponse> {
    const toolResult = _contents.at(-1);
    const originalQuestion = latestUserMessage(_contents);

    if (isGitCommittedFileCountToolResult(toolResult)) {
      return {
        text: formatCommittedFileCountResponse(toolResult.result),
        tool_calls: [],
        raw: null,
      };
    }
    if (isGitStatusToolResult(toolResult)) {
      return {
        text: formatGitStatusResponse(toolResult.result, originalQuestion),
        tool_calls: [],
        raw: null,
      };
    }
    if (isGitBranchToolResult(toolResult)) {
      return {
        text: formatGitBranchResponse(toolResult.result),
        tool_calls: [],
        raw: null,
      };
    }
    if (isGitLogToolResult(toolResult)) {
      return {
        text: formatGitLogResponse(toolResult.result),
        tool_calls: [],
        raw: null,
      };
    }
    if (isGitDiffToolResult(toolResult)) {
      return {
        text: formatGitDiffResponse(toolResult.result),
        tool_calls: [],
        raw: null,
      };
    }

    if (isCommittedFileCountRequest(originalQuestion)) {
      return {
        text: null,
        tool_calls: [{ name: "git_committed_file_count", args: {} }],
        raw: null,
      };
    }
    if (isGitStatusRequest(originalQuestion)) {
      return {
        text: null,
        tool_calls: [{ name: "git_status", args: {} }],
        raw: null,
      };
    }
    if (isGitBranchRequest(originalQuestion)) {
      return {
        text: null,
        tool_calls: [{ name: "git_branch", args: {} }],
        raw: null,
      };
    }
    if (isGitLogRequest(originalQuestion)) {
      return {
        text: null,
        tool_calls: [{ name: "git_log", args: {} }],
        raw: null,
      };
    }
    if (isGitDiffRequest(originalQuestion)) {
      return {
        text: null,
        tool_calls: [{ name: "git_diff", args: {} }],
        raw: null,
      };
    }

    return {
      text: `[stub] Hello from ${this.model}`,
      tool_calls: [],
      raw: null,
    };
  }

  appendModelTurn(
    contents: unknown[],
    response: ProviderResponse
  ): unknown[] {
    return [
      ...contents,
      { role: "assistant", content: response.text || "" },
    ];
  }

  appendToolResults(
    contents: unknown[],
    results: { name: string; result: unknown }[]
  ): unknown[] {
    return [
      ...contents,
      ...results.map((result) => ({ role: "tool", ...result })),
    ];
  }
}

export function isGitStatusRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return (
    /\bgit\s+status\b/.test(normalized) ||
    /\b(?:what(?:'s| is)|show|check|tell me|can you tell me).{0,80}\b(?:git|repository|repo|working tree)\b.{0,80}\b(?:status|state)\b/.test(normalized) ||
    /\b(?:did|have) i commit (?:everything|all(?: of)? (?:my )?changes)\b/.test(normalized) ||
    /\bdid i (?:git )?(?:commit|push)\b/.test(normalized) ||
    /\bcan i (?:git )?push\b/.test(normalized) ||
    /\b(?:am i|is it|can i).{0,40}\b(?:safe|ready|okay|ok)\b.{0,40}\b(?:to )?git push\b/.test(normalized) ||
    /\b(?:is|are) (?:everything|all(?: of)? (?:my )?changes) committed\b/.test(normalized)
  );
}

export function isGitBranchRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return (
    /\bgit\s+branch\b/.test(normalized) ||
    /\b(?:what|which|show|list|tell me).{0,40}\bbranch(?:es)?\b/.test(normalized) ||
    /\bcurrent\s+branch\b/.test(normalized)
  );
}

export function isGitLogRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return (
    /\bgit\s+log\b/.test(normalized) ||
    /\brecent\s+commits?\b/.test(normalized) ||
    /\bshow\s+.*\bcommit\s+history\b/.test(normalized)
  );
}

export function isGitDiffRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return (
    /\bgit\s+diff\b/.test(normalized) ||
    /\bwhat\s+changed\b/.test(normalized) ||
    /\bshow\s+.*\bdiff\b/.test(normalized)
  );
}

export function isCommittedFileCountRequest(message: string): boolean {
  return /\bhow many files (?:are )?committ?ed\b/.test(message.trim().toLowerCase());
}

function latestUserMessage(contents: unknown[]): string {
  for (let index = contents.length - 1; index >= 0; index--) {
    const item = contents[index];
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).role === "user" &&
      typeof (item as Record<string, unknown>).content === "string"
    ) {
      return (item as Record<string, unknown>).content as string;
    }
  }
  return "";
}

function isGitStatusToolResult(
  item: unknown
): item is { role: "tool"; name: "git_status"; result: unknown } {
  return !!(
    item &&
    typeof item === "object" &&
    (item as Record<string, unknown>).role === "tool" &&
    (item as Record<string, unknown>).name === "git_status"
  );
}

function isGitCommittedFileCountToolResult(
  item: unknown
): item is { role: "tool"; name: "git_committed_file_count"; result: unknown } {
  return !!(
    item &&
    typeof item === "object" &&
    (item as Record<string, unknown>).role === "tool" &&
    (item as Record<string, unknown>).name === "git_committed_file_count"
  );
}

function isGitBranchToolResult(
  item: unknown
): item is { role: "tool"; name: "git_branch"; result: unknown } {
  return !!(
    item &&
    typeof item === "object" &&
    (item as Record<string, unknown>).role === "tool" &&
    (item as Record<string, unknown>).name === "git_branch"
  );
}

function isGitLogToolResult(
  item: unknown
): item is { role: "tool"; name: "git_log"; result: unknown } {
  return !!(
    item &&
    typeof item === "object" &&
    (item as Record<string, unknown>).role === "tool" &&
    (item as Record<string, unknown>).name === "git_log"
  );
}

function isGitDiffToolResult(
  item: unknown
): item is { role: "tool"; name: "git_diff"; result: unknown } {
  return !!(
    item &&
    typeof item === "object" &&
    (item as Record<string, unknown>).role === "tool" &&
    (item as Record<string, unknown>).name === "git_diff"
  );
}

function formatGitStatusResponse(
  result: unknown,
  originalQuestion = ""
): string {
  if (!result || typeof result !== "object") {
    return "Git status could not be determined.";
  }

  const response = result as Record<string, unknown>;
  if (typeof response.error === "string") return response.error;

  const summary =
    typeof response.summary === "string"
      ? response.summary
      : "Git status could not be determined.";
  const details = Array.isArray(response.details)
    ? response.details.filter((detail): detail is string => typeof detail === "string")
    : [];

  const clean = Boolean(response.clean);
  const synchronized = Boolean(response.synchronized);
  const ahead = Number(response.ahead) || 0;
  const behind = Number(response.behind) || 0;
  const staged = Number(response.staged) || 0;
  const changed = Number(response.changed) || 0;
  const untracked = Number(response.untracked) || 0;
  const totalUncommitted = changed + untracked;

  const q = originalQuestion.trim().toLowerCase();

  const isCommitQuestion =
    /\b(?:did|have) i (?:git )?commit\b/.test(q) ||
    /\b(?:did|have) i commit (?:everything|all(?: of)? (?:my )?changes)\b/.test(q) ||
    /\b(?:is|are) (?:everything|all(?: of)? (?:my )?changes) committed\b/.test(q);

  const isPushQuestion =
    /\bdid i (?:git )?push\b/.test(q) ||
    /\bcan i (?:git )?push\b/.test(q) ||
    /\b(?:am i|is it|can i).{0,40}\b(?:safe|ready|okay|ok)\b.{0,40}\b(?:to )?git push\b/.test(q);

  if (isCommitQuestion) {
    if (clean) {
      return "Yes. Your working tree is clean; all changes have been committed.";
    }
    const parts = [
      `No. You still have ${totalUncommitted} uncommitted file${totalUncommitted === 1 ? "" : "s"}.`,
    ];
    if (staged > 0) {
      parts.push(
        `${staged} file${staged === 1 ? " is" : "s are"} already staged for the next commit.`
      );
    }
    if (details.length > 0) {
      parts.push(
        "\n\nFiles:\n" + details.map((detail) => `- ${detail}`).join("\n")
      );
    }
    return parts.join(" ");
  }

  if (isPushQuestion) {
    if (synchronized && clean) {
      return "Yes. Your local branch is synchronized with the remote and the working tree is clean; there is nothing to push.";
    }
    if (ahead === 0 && clean) {
      return "Your branch is not ahead of the remote, so there is nothing to push. The working tree is clean.";
    }
    const parts: string[] = [];
    if (ahead > 0) {
      parts.push(
        `No. Your branch has ${ahead} commit${ahead === 1 ? "" : "s"} that have not been pushed.`
      );
    } else {
      parts.push("There are no local commits waiting to be pushed.");
    }
    if (behind > 0) {
      parts.push(
        `Your branch is also ${behind} commit${behind === 1 ? "" : "s"} behind the remote.`
      );
    }
    if (!clean) {
      parts.push(
        `In addition the working tree still contains ${totalUncommitted} uncommitted change${totalUncommitted === 1 ? "" : "s"}.`
      );
    }
    if (details.length > 0) {
      parts.push(
        "\n\nFiles:\n" + details.map((detail) => `- ${detail}`).join("\n")
      );
    }
    return parts.join(" ");
  }

  return details.length > 0
    ? `${summary}\n\nFiles:\n${details.map((detail) => `- ${detail}`).join("\n")}`
    : summary;
}

function formatGitBranchResponse(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Git branch could not be determined.";
  }

  const response = result as Record<string, unknown>;
  if (typeof response.error === "string") return response.error;

  const branches = typeof response.branches === "string" ? response.branches : "";
  if (!branches.trim()) {
    return "This repository has no branches.";
  }

  return branches.trim();
}

function formatGitLogResponse(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Git log could not be determined.";
  }

  const response = result as Record<string, unknown>;
  if (typeof response.error === "string") return response.error;

  const log = typeof response.log === "string" ? response.log : "";
  if (!log.trim()) {
    return "This repository has no commits.";
  }

  const note =
    typeof response.truncation_note === "string"
      ? `\n\n${response.truncation_note}`
      : "";

  return log.trim() + note;
}

function formatGitDiffResponse(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Git diff could not be determined.";
  }

  const response = result as Record<string, unknown>;
  if (typeof response.error === "string") return response.error;

  const diff = typeof response.diff === "string" ? response.diff : "";
  if (!diff.trim()) {
    return "No differences found.";
  }

  const note =
    typeof response.truncation_note === "string"
      ? `\n\n${response.truncation_note}`
      : "";

  return diff.trim() + note;
}

function formatCommittedFileCountResponse(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Git could not count files in the current commit.";
  }

  const response = result as Record<string, unknown>;
  if (typeof response.error === "string") return response.error;
  const count = response.committed_files;
  if (typeof count !== "number") return "Git could not count files in the current commit.";

  return `The current commit contains ${count} tracked file${count === 1 ? "" : "s"}.`;
}
