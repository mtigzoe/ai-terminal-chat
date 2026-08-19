import { Provider, ProviderCapabilities, ProviderResponse, ToolCall } from "./base.ts";
import { CHAT_ONLY_INSTRUCTION, SYSTEM_INSTRUCTION } from "../prompts.ts";
import { buildToolSchemas } from "../tools.ts";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export class AnthropicProvider extends Provider {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly timeout: number;
  readonly displayName = "Anthropic";
  private readonly tools: unknown[];

  protected _capabilities: ProviderCapabilities = {
    tools: true,
    streaming: false,
    model_listing: true,
    requires_api_key: true,
    local: false,
    notes: "Native Anthropic messages API; streaming is not implemented yet.",
  };

  constructor(config: {
    model: string;
    api_key?: string;
    base_url?: string;
    timeout?: number;
  }) {
    super();
    this.name = "anthropic";
    this.model = config.model;
    this.apiKey = config.api_key;
    this.baseUrl = (config.base_url || "https://api.anthropic.com").replace(/\/$/, "");
    this.timeout = config.timeout ?? 120;
    this.tools = buildToolSchemas().map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  buildContents(msg: string, history: unknown[]): unknown[] {
    const messages: AnthropicMessage[] = [];
    for (const item of history) {
      const normalized = this.normalizeHistoryItem(item);
      if (normalized) messages.push(normalized);
    }
    messages.push({ role: "user", content: msg });
    return messages;
  }

  async generate(contents: unknown[]): Promise<ProviderResponse> {
    this.requireApiKey();
    const response = await this.request("POST", `${this.baseUrl}/v1/messages`, {
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: this.capabilities.tools ? SYSTEM_INSTRUCTION : CHAT_ONLY_INSTRUCTION,
        messages: contents,
        tools: this.capabilities.tools ? this.tools : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(await this.apiError(response, "Anthropic request failed"));
    }

    const data = (await response.json()) as Record<string, unknown>;
    const blocks = Array.isArray(data.content) ? data.content as AnthropicContentBlock[] : [];
    const toolCalls: ToolCall[] = blocks
      .filter((block) => block.type === "tool_use" && typeof block.name === "string")
      .map((block) => ({
        name: block.name!,
        args: block.input || {},
        id: block.id,
      }));
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text || "")
      .join("") || null;

    return { text, tool_calls: toolCalls, raw: blocks };
  }

  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[] {
    const content = Array.isArray(response.raw)
      ? response.raw
      : [{ type: "text", text: response.text || "" }];
    return [...contents, { role: "assistant", content }];
  }

  appendToolResults(
    contents: unknown[],
    results: { name: string; result: unknown }[]
  ): unknown[] {
    const previous = contents.at(-1) as AnthropicMessage | undefined;
    const blocks = Array.isArray(previous?.content) ? previous.content : [];
    const toolUses = blocks.filter(
      (block): block is AnthropicContentBlock =>
        block.type === "tool_use" && typeof block.id === "string"
    );

    const content = results.map((result, index) => {
      const toolUse = toolUses[index];
      if (!toolUse?.id) {
        throw new Error(
          `Anthropic tool result '${result.name}' has no matching tool_use id.`
        );
      }
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result.result),
      };
    });

    return [...contents, { role: "user", content }];
  }

  async listModels(): Promise<unknown[]> {
    if (!this.apiKey) return [];
    try {
      const response = await this.request("GET", `${this.baseUrl}/v1/models`);
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: unknown[] };
      return (data.data || [])
        .map((model) => {
          if (typeof model === "string") return { id: model };
          if (!model || typeof model !== "object") return null;
          const id = (model as Record<string, unknown>).id;
          return typeof id === "string" ? { id } : null;
        })
        .filter((model): model is { id: string } => model !== null);
    } catch {
      return [];
    }
  }

  async probe(): Promise<{ available: boolean; error: string | null }> {
    if (!this.apiKey) return { available: false, error: "Anthropic API key is not configured (ANTHROPIC_API_KEY)." };
    try {
      const response = await this.request("GET", `${this.baseUrl}/v1/models`);
      if (response.ok) return { available: true, error: null };
      return { available: false, error: await this.apiError(response, "Anthropic probe failed") };
    } catch (exc) {
      return { available: false, error: exc instanceof Error ? exc.message : String(exc) };
    }
  }

  private normalizeHistoryItem(item: unknown): AnthropicMessage | null {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (record.role === "user" || record.role === "assistant") {
      if (typeof record.content === "string" && record.content) {
        return { role: record.role, content: record.content };
      }
      if (Array.isArray(record.content)) {
        return { role: record.role, content: record.content as AnthropicContentBlock[] };
      }
    }
    if ((record.role === "model" || record.role === "assistant") && Array.isArray(record.parts)) {
      const text = (record.parts as { text?: string }[]).map((part) => part.text || "").join("");
      if (text) return { role: "assistant", content: text };
    }
    return null;
  }

  private requireApiKey(): void {
    if (!this.apiKey) throw new Error("Anthropic API key is not configured (ANTHROPIC_API_KEY).");
  }

  private async request(method: string, url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);
    try {
      return await fetch(url, {
        ...options,
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey || "",
          "anthropic-version": "2023-06-01",
          ...(options.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
    } catch (exc) {
      if (exc instanceof Error && exc.name === "AbortError") {
        throw new Error("Anthropic request timed out.");
      }
      throw new Error(`Could not reach Anthropic: ${exc}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async apiError(response: Response, prefix: string): Promise<string> {
    const body = await response.text();
    return `${prefix} (HTTP ${response.status}): ${body}`;
  }
}
