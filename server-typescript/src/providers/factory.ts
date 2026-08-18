import { Provider, ProviderConfig, ProviderStatus } from "./base.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import { StubProvider } from "./stub.ts";
import { loadProviderEnvConfig, SUPPORTED_PROVIDERS } from "./config.ts";

export function getProvider(
  name?: string,
  overrides?: Partial<ProviderConfig>
): Provider {
  const lower = (name || process.env.PROVIDER || "gemini").toLowerCase();
  const envConfig = loadProviderEnvConfig(lower);
  const model = overrides?.model || envConfig.model;

  switch (lower) {
    case "gemini": {
      const provider = new StubProvider("gemini", model, {
        tools: true,
        streaming: true,
        model_listing: false,
        requires_api_key: true,
        local: false,
      });
      provider.displayName = "Gemini";
      provider.providerConfig = {
        provider: "gemini",
        model,
        api_key: envConfig.api_key,
        timeout: 120,
      };
      return provider;
    }
    case "ollama": {
      const provider = new OpenAICompatibleProvider({
        base_url: envConfig.base_url || "http://localhost:11434/v1",
        model,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
        local: true,
        display_name: "Ollama",
      });
      provider.name = "ollama";
      provider.providerConfig = {
        provider: "ollama",
        model,
        base_url: envConfig.base_url,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
      };
      return provider;
    }
    case "kilo": {
      const provider = new OpenAICompatibleProvider({
        base_url: envConfig.base_url || "https://api.kilo.ai/api/gateway",
        model,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
        display_name: "Kilo",
      });
      provider.name = "kilo";
      provider.providerConfig = {
        provider: "kilo",
        model,
        base_url: envConfig.base_url,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
      };
      return provider;
    }
    case "openai": {
      const provider = new OpenAICompatibleProvider({
        base_url: envConfig.base_url || "https://api.openai.com/v1",
        model,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
        requires_api_key: true,
        display_name: "OpenAI",
      });
      provider.name = "openai";
      provider.providerConfig = {
        provider: "openai",
        model,
        base_url: envConfig.base_url,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
      };
      return provider;
    }
    case "xai": {
      const provider = new OpenAICompatibleProvider({
        base_url: envConfig.base_url || "https://api.x.ai/v1",
        model,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
        display_name: "xAI",
      });
      provider.name = "xai";
      provider.providerConfig = {
        provider: "xai",
        model,
        base_url: envConfig.base_url,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
      };
      return provider;
    }
    case "openrouter": {
      const provider = new OpenAICompatibleProvider({
        base_url: envConfig.base_url || "https://openrouter.ai/api/v1",
        model,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
        display_name: "OpenRouter",
      });
      provider.name = "openrouter";
      provider.providerConfig = {
        provider: "openrouter",
        model,
        base_url: envConfig.base_url,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
      };
      return provider;
    }
    case "anthropic": {
      const provider = new StubProvider("anthropic", model, {
        tools: true,
        streaming: true,
        model_listing: false,
        requires_api_key: true,
        local: false,
      });
      provider.displayName = "Anthropic";
      provider.providerConfig = {
        provider: "anthropic",
        model,
        base_url: envConfig.base_url,
        api_key: envConfig.api_key,
        timeout: envConfig.timeout,
      };
      return provider;
    }
    default:
      throw new Error(
        `Unknown PROVIDER '${lower}'. Expected one of: ${SUPPORTED_PROVIDERS.join(", ")}.`
      );
  }
}

export async function buildProviderStatus(
  provider: Provider,
  probe = true
): Promise<ProviderStatus> {
  const config = provider.providerConfig;
  const status: ProviderStatus = {
    name: provider.name,
    model: provider.model,
    capabilities: provider.capabilities,
    base_url: config?.base_url,
  };

  if (probe) {
    if (provider.capabilities.local) {
      try {
        await provider.refreshCapabilities();
        status.capabilities = provider.capabilities;
      } catch {
        // ignore
      }
    }

    const probeResult = await provider.probe();
    status.available = probeResult.available;
    status.error = probeResult.error;
    if (!probeResult.available) {
      status.diagnostics = buildDiagnostics(provider, probeResult.error || "");
    } else if (status.capabilities.notes) {
      status.error = status.capabilities.notes;
    }
  }

  return status;
}

function buildDiagnostics(
  target: Provider,
  error: string
): Record<string, unknown> {
  const config = target.providerConfig;
  const serverUrl = config?.base_url || target.displayName || target.name;

  const causes: string[] = [
    `${target.displayName || target.name} is not running`
  ];
  const isLocal = target.capabilities.local;

  if (isLocal) {
    causes.push(
      "The host running it is unreachable from this machine",
      "The port is blocked by a firewall",
      "The configured server URL/host environment variable is incorrect"
    );
    if ((target.displayName || target.name) === "Ollama") {
      causes.push("Start the server with `ollama serve`");
    }
  } else {
    causes.push(
      "The API key is missing, revoked, or incorrect",
      "The network connection is down"
    );
  }

  return {
    provider: target.displayName || target.name,
    server: serverUrl,
    model: target.model,
    possible_causes: causes,
    detail: error,
  };
}
