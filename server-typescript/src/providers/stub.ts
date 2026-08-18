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
    _results: { name: string; result: unknown }[]
  ): unknown[] {
    return contents;
  }
}
