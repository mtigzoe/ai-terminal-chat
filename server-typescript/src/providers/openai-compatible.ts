import { Provider, ProviderCapabilities, ProviderResponse, ToolCall } from "./base.ts";
import { CHAT_ONLY_INSTRUCTION, SYSTEM_INSTRUCTION } from "../prompts.ts";
import { buildToolSchemas } from "../tools.ts";

export class OpenAICompatibleProvider extends Provider {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly timeout: number;
  readonly displayName: string;
  protected _capabilities: ProviderCapabilities;
  private tools: unknown[];

  constructor(config: {
    base_url: string;
    model: string;
    api_key?: string;
    timeout?: number;
    local?: boolean;
    requires_api_key?: boolean;
    display_name?: string;
    capabilities?: Partial<ProviderCapabilities>;
  }) {
    super();
    if (!config.base_url?.trim()) {
      throw new Error(
        `${config.display_name || "Provider"} base URL is not set.`
      );
    }

    this.baseUrl = config.base_url.replace(/\/$/, "");
    this.model = config.model;
    this.apiKey = config.api_key;
    this.timeout = config.timeout ?? 120;
    this.displayName = config.display_name || "OpenAI-compatible";

    this._capabilities = {
      tools: true,
      streaming: true,
      model_listing: true,
      requires_api_key: config.requires_api_key ?? false,
      local: config.local ?? false,
      notes: "",
      ...config.capabilities,
    };

    this.tools = buildToolSchemas();
  }

  setTools(tools: unknown[]): void {
    this.tools = tools;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private unreachableMessage(exc: unknown): string {
    return `Could not reach ${this.displayName} at ${this.baseUrl}. ${exc}`;
  }

  private async request(
    method: string,
    url: string,
    options: RequestInit = {},
    timeoutSeconds?: number
  ): Promise<Response> {
    const controller = new AbortController();
    // Probes/list use a short timeout; chat completions use the full
    // configured timeout (Ollama cold starts often exceed 10s).
    const seconds = timeoutSeconds ?? Math.min(this.timeout, 10);
    const timeoutId = setTimeout(
      () => controller.abort(),
      seconds * 1000
    );

    try {
      const response = await fetch(url, {
        ...options,
        method,
        headers: {
          ...this.headers(),
          ...(options.headers as Record<string, string>),
        },
        signal: controller.signal,
      });
      return response;
    } catch (exc) {
      if (exc instanceof Error && exc.name === "AbortError") {
        throw new Error(`Request to ${this.displayName} timed out.`);
      }
      throw new Error(this.unreachableMessage(exc));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async probe(): Promise<{ available: boolean; error: string | null }> {
    try {
      const response = await this.request("GET", `${this.baseUrl}/models`);
      if (response.ok) {
        return { available: true, error: null };
      }
      if (response.status === 404 || response.status === 405) {
        return { available: true, error: null };
      }
      return {
        available: false,
        error: `${this.displayName} returned HTTP ${response.status} from ${this.baseUrl}/models.`,
      };
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      if (!message.startsWith(`Could not reach ${this.displayName}`)) {
        return { available: false, error: this.unreachableMessage(exc) };
      }
      return { available: false, error: message };
    }
  }

  async listModels(): Promise<unknown[]> {
    try {
      const response = await this.request("GET", `${this.baseUrl}/models`);
      if (!response.ok) return [];
      const data = (await response.json()) as Record<string, unknown>;
      const rawModels =
        (data.data as unknown[]) ||
        (data.models as unknown[]) ||
        [];
      const models: { id: string }[] = [];
      for (const item of rawModels) {
        if (typeof item === "string") {
          models.push({ id: item });
        } else if (item && typeof item === "object") {
          const modelId = (item as Record<string, unknown>).id || (item as Record<string, unknown>).name || (item as Record<string, unknown>).model;
          if (typeof modelId === "string" && modelId) {
            models.push({ id: modelId });
          }
        }
      }
      return models;
    } catch {
      return [];
    }
  }

  buildContents(msg: string, history: unknown[]): unknown[] {
    const contents: { role: string; content: string }[] = [
      {
        role: "system",
        content: this._capabilities.tools
          ? SYSTEM_INSTRUCTION
          : CHAT_ONLY_INSTRUCTION,
      },
    ];

    for (const item of history) {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const role = record.role as string;
        const parts = record.parts as { text?: string }[] | undefined;
        const text = parts?.map((p) => p.text || "").join("") || "";
        if (role && text) {
          contents.push({
            role: role === "model" ? "assistant" : role,
            content: text,
          });
        }
      }
    }

    contents.push({ role: "user", content: msg });
    return contents;
  }

  private async complete(
    contents: unknown[],
    useTools: boolean
  ): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: contents,
    };
    if (useTools && this.tools.length > 0) {
      body.tools = this.tools;
    }

    const response = await this.request(
      "POST",
      `${this.baseUrl}/chat/completions`,
      {
        body: JSON.stringify(body),
      },
      this.timeout
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `${this.displayName} request failed (HTTP ${response.status}): ${text}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    try {
      const choice = (data.choices as unknown[])[0] as Record<string, unknown>;
      const message = choice.message as Record<string, unknown>;
      const rawToolCalls = (message.tool_calls as unknown[]) || [];

      const toolCalls: ToolCall[] = rawToolCalls.map((call) => {
        const record = call as Record<string, unknown>;
        const fn = record.function as Record<string, unknown> | undefined;
        const rawArgs = fn?.arguments;
        let args: Record<string, unknown> = {};
        if (typeof rawArgs === "string") {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = {};
          }
        } else if (typeof rawArgs === "object" && rawArgs !== null) {
          args = rawArgs as Record<string, unknown>;
        }
        return {
          name: (fn?.name as string) || "",
          args,
          id: record.id as string | undefined,
        };
      });

      return {
        text: (message.content as string) || null,
        tool_calls: toolCalls,
        raw: message,
      };
    } catch (exc) {
      throw new Error(`Unexpected response shape: ${data}`);
    }
  }

  async generate(contents: unknown[]): Promise<ProviderResponse> {
    const useTools = this._capabilities.tools;
    try {
      return await this.complete(contents, useTools);
    } catch (exc) {
      if (useTools && this._looksLikeToolsUnsupported(exc)) {
        this._capabilities = {
          ...this._capabilities,
          tools: false,
          notes:
            "This model or server rejected tool calling. Continuing in chat-only mode.",
        };
        return await this.complete(contents, false);
      }
      throw exc;
    }
  }

  appendModelTurn(
    contents: unknown[],
    response: ProviderResponse
  ): unknown[] {
    const message: Record<string, unknown> =
      typeof response.raw === "object" && response.raw !== null
        ? { ...(response.raw as Record<string, unknown>) }
        : { role: "assistant", content: response.text || "" };
    message.role = "assistant";
    // Ollama (and some other OpenAI-compatible servers) reject
    // "content": null on assistant messages. The OpenAI spec allows
    // null content when tool_calls are present, but Ollama returns
    // HTTP 400 "invalid message content type: <nil>". Normalize to an
    // empty string so the conversation history round-trips cleanly.
    if (message.content === null || message.content === undefined) {
      message.content = "";
    }
    return [...contents, message];
  }

  appendToolResults(
    contents: unknown[],
    results: { name: string; result: unknown }[]
  ): unknown[] {
    const assistantTurn = contents[contents.length - 1] as Record<string, unknown>;
    const rawCalls = (assistantTurn.tool_calls as unknown[]) || [];
    const callIds: string[] = [];
    for (let i = 0; i < rawCalls.length; i++) {
      const call = rawCalls[i] as Record<string, unknown>;
      const callId = (call.id as string) || `call-${i}`;
      callIds.push(callId);
      if (!call.id) call.id = callId;
    }

    const newMessages = callIds.map((callId, index) => ({
      role: "tool" as const,
      tool_call_id: callId,
      content: JSON.stringify(results[index]?.result ?? null),
    }));

    return [...contents, ...newMessages];
  }

  private _looksLikeToolsUnsupported(exc: unknown): boolean {
    const markers = [
      "tool",
      "tools",
      "function",
      "functions",
      "function calling",
      "tool_choice",
      "does not support",
      "unsupported",
      "unknown field",
      "unrecognized",
      "invalid parameter",
      "not enabled",
    ];
    const text = String(exc).toLowerCase();
    return markers.some((m) => text.includes(m));
  }
}
