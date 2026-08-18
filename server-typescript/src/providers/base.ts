export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  model_listing: boolean;
  requires_api_key: boolean;
  local: boolean;
  notes: string;
}

export interface ProviderResponse {
  text: string | null;
  tool_calls: ToolCall[];
  raw: unknown;
}

export interface ProviderConfig {
  provider: string;
  model: string;
  base_url?: string;
  api_key?: string;
  timeout: number;
}

export interface ProviderStatus {
  name: string;
  model: string;
  capabilities: ProviderCapabilities;
  base_url?: string;
  available?: boolean;
  error?: string | null;
  diagnostics?: Record<string, unknown>;
  current?: string;
  providers?: string[];
}

export abstract class Provider {
  name: string = "";
  model: string = "";
  displayName: string = "";
  providerConfig?: ProviderConfig;

  protected _capabilities: ProviderCapabilities = {
    tools: true,
    streaming: true,
    model_listing: false,
    requires_api_key: false,
    local: false,
    notes: "",
  };

  get capabilities(): ProviderCapabilities {
    return this._capabilities;
  }

  set capabilities(value: ProviderCapabilities) {
    this._capabilities = value;
  }

  abstract buildContents(msg: string, history: unknown[]): unknown[];

  abstract generate(contents: unknown[]): Promise<ProviderResponse>;

  abstract appendModelTurn(
    contents: unknown[],
    response: ProviderResponse
  ): unknown[];

  abstract appendToolResults(
    contents: unknown[],
    results: { name: string; result: unknown }[]
  ): unknown[];

  async listModels(): Promise<unknown[]> {
    return [];
  }

  async probe(): Promise<{ available: boolean; error: string | null }> {
    return { available: true, error: null };
  }

  async refreshCapabilities(): Promise<ProviderCapabilities> {
    return this._capabilities;
  }
}
