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

  buildContents(msg: string, _history: unknown[]): unknown[] {
    return [{ role: "user", content: msg }];
  }

  async generate(_contents: unknown[]): Promise<ProviderResponse> {
    const toolResult = _contents.at(-1);
    if (isGitStatusToolResult(toolResult)) {
      return {
        text: formatGitStatusResponse(toolResult.result),
        tool_calls: [],
        raw: null,
      };
    }

    const message = latestUserMessage(_contents);
    if (isGitStatusRequest(message)) {
      return {
        text: null,
        tool_calls: [{ name: "git_status", args: {} }],
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

/**
 * The stub has no model to decide when to call a tool. Keep its small amount
 * of routing explicit so Git-status questions exercise the same agent/tool
 * path as a tool-capable provider.
 */
export function isGitStatusRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return (
    /\bgit\s+status\b/.test(normalized) ||
    /\b(?:what(?:'s| is)|show|check|tell me|can you tell me).{0,80}\b(?:git|repository|repo|working tree)\b.{0,80}\b(?:status|state)\b/.test(normalized) ||
    /\b(?:did|have) i commit (?:everything|all(?: of)? (?:my )?changes)\b/.test(normalized) ||
    /\b(?:is|are) (?:everything|all(?: of)? (?:my )?changes) committed\b/.test(normalized)
  );
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

function formatGitStatusResponse(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Git status could not be determined.";
  }

  const response = result as Record<string, unknown>;
  if (typeof response.error === "string") return response.error;

  const summary = typeof response.summary === "string" ? response.summary : "Git status could not be determined.";
  const details = Array.isArray(response.details)
    ? response.details.filter((detail): detail is string => typeof detail === "string")
    : [];

  return details.length > 0
    ? `${summary}\n\nFiles:\n${details.map((detail) => `- ${detail}`).join("\n")}`
    : summary;
}
