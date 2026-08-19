import { Provider, ProviderCapabilities, ProviderResponse, ToolCall } from "./base.ts";
import { CHAT_ONLY_INSTRUCTION, SYSTEM_INSTRUCTION } from "../prompts.ts";
import { buildToolSchemas } from "../tools.ts";

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name?: string; response?: unknown; id?: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export class GeminiProvider extends Provider {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly timeout: number;
  readonly displayName = "Gemini";
  private readonly tools: unknown[];

  protected _capabilities: ProviderCapabilities = {
    tools: true,
    streaming: false,
    model_listing: true,
    requires_api_key: true,
    local: false,
    notes: "Native Gemini generateContent API; streaming is not implemented yet.",
  };

  constructor(config: {
    model: string;
    api_key?: string;
    base_url?: string;
    timeout?: number;
  }) {
    super();
    this.name = "gemini";
    this.model = config.model;
    this.apiKey = config.api_key;
    this.baseUrl = (config.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.timeout = config.timeout ?? 120;
    this.tools = buildToolSchemas().map((tool) => ({
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      ],
    }));
  }

  buildContents(msg: string, history: unknown[]): unknown[] {
    const contents: GeminiContent[] = [];
    for (const item of history) {
      const normalized = this.normalizeHistoryItem(item);
      if (normalized) contents.push(normalized);
    }
    contents.push({ role: "user", parts: [{ text: msg }] });
    return contents;
  }

  async generate(contents: unknown[]): Promise<ProviderResponse> {
    this.requireApiKey();
    const response = await this.request("POST", `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey!)}`, {
      body: JSON.stringify({
        contents,
        systemInstruction: {
          role: "system",
          parts: [{ text: this.capabilities.tools ? SYSTEM_INSTRUCTION : CHAT_ONLY_INSTRUCTION }],
        },
        generationConfig: {},
        tools: this.capabilities.tools ? this.tools : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(await this.apiError(response, "Gemini request failed"));
    }

    const data = (await response.json()) as Record<string, unknown>;
    const candidate = ((data.candidates as unknown[]) || [])[0] as Record<string, unknown> | undefined;
    const content = candidate?.content as { parts?: GeminiPart[]; role?: string } | undefined;
    const parts = content?.parts || [];
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (!part.functionCall?.name) continue;
      toolCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args || {},
        id: part.functionCall.id,
      });
    }

    const text = parts
      .map((part) => part.text || "")
      .filter(Boolean)
      .join("") || null;

    return { text, tool_calls: toolCalls, raw: content || null };
  }

  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[] {
    if (response.raw && typeof response.raw === "object") {
      return [...contents, response.raw];
    }
    return [...contents, { role: "model", parts: [{ text: response.text || "" }] }];
  }

  appendToolResults(
    contents: unknown[],
    results: { name: string; result: unknown }[]
  ): unknown[] {
    const previous = contents.at(-1) as GeminiContent | undefined;
    const calls = (previous?.parts || [])
      .map((part) => part.functionCall)
      .filter((call): call is NonNullable<GeminiPart["functionCall"]> => !!call?.name);

    const parts = results.map((result, index) => {
      const call = calls[index];
      if (!call) {
        throw new Error(`Gemini tool result '${result.name}' has no matching function call.`);
      }
      return {
        functionResponse: {
          name: result.name,
          response: { result: result.result },
          ...(call.id ? { id: call.id } : {}),
        },
      };
    });

    return [...contents, { role: "user", parts }];
  }

  async listModels(): Promise<unknown[]> {
    if (!this.apiKey) return [];
    try {
      const response = await this.request("GET", `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`);
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: unknown[] };
      return (data.models || [])
        .map((model) => {
          if (typeof model === "string") return { id: model.replace(/^models\//, "") };
          if (!model || typeof model !== "object") return null;
          const name = (model as Record<string, unknown>).name;
          return typeof name === "string" ? { id: name.replace(/^models\//, "") } : null;
        })
        .filter((model): model is { id: string } => model !== null);
    } catch {
      return [];
    }
  }

  async probe(): Promise<{ available: boolean; error: string | null }> {
    if (!this.apiKey) return { available: false, error: "Gemini API key is not configured (GOOGLE_API_KEY)." };
    try {
      const response = await this.request("GET", `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`);
      if (response.ok) return { available: true, error: null };
      return { available: false, error: await this.apiError(response, "Gemini probe failed") };
    } catch (exc) {
      return { available: false, error: exc instanceof Error ? exc.message : String(exc) };
    }
  }

  private normalizeHistoryItem(item: unknown): GeminiContent | null {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (record.role === "user" || record.role === "model") {
      if (Array.isArray(record.parts)) return record as unknown as GeminiContent;
      if (typeof record.content === "string" && record.content) {
        return { role: record.role, parts: [{ text: record.content }] };
      }
    }
    if (record.role === "assistant" && typeof record.content === "string" && record.content) {
      return { role: "model", parts: [{ text: record.content }] };
    }
    return null;
  }

  private requireApiKey(): void {
    if (!this.apiKey) throw new Error("Gemini API key is not configured (GOOGLE_API_KEY).");
  }

  private async request(method: string, url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);
    try {
      return await fetch(url, {
        ...options,
        method,
        headers: { "Content-Type": "application/json", ...(options.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
    } catch (exc) {
      if (exc instanceof Error && exc.name === "AbortError") {
        throw new Error("Gemini request timed out.");
      }
      throw new Error(`Could not reach Gemini: ${exc}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async apiError(response: Response, prefix: string): Promise<string> {
    const body = await response.text();
    return `${prefix} (HTTP ${response.status}): ${body}`;
  }
}
