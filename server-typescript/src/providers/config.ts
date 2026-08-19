export const SUPPORTED_PROVIDERS = [
  "gemini",
  "ollama",
  "kilo",
  "openai",
  "xai",
  "openrouter",
  "anthropic",
] as const;

export type SupportedProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export interface ProviderEnvConfig {
  provider: string;
  model: string;
  base_url?: string;
  api_key?: string;
  timeout: number;
}

export function loadProviderEnvConfig(name: string): ProviderEnvConfig {
  const lower = (name || "").toLowerCase();

  switch (lower) {
    case "gemini":
    return {
      provider: "gemini",
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      api_key: process.env.GOOGLE_API_KEY,
      timeout: 120,
    };
    case "ollama": {
      const baseUrl =
        process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://localhost:11434/v1";
      return {
        provider: "ollama",
        model: process.env.OLLAMA_MODEL || "llama3.1",
        base_url: baseUrl,
        timeout: parseInt(process.env.OLLAMA_TIMEOUT || "120", 10),
      };
    }
    case "kilo":
      return {
        provider: "kilo",
        model: process.env.KILO_MODEL || "kilocode/kilo-auto/balanced",
        base_url: process.env.KILO_BASE_URL || "https://api.kilo.ai/api/gateway",
        api_key: process.env.KILO_API_KEY,
        timeout: parseInt(process.env.KILO_TIMEOUT || "120", 10),
      };
    case "openai":
      return {
        provider: "openai",
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        base_url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        api_key: process.env.OPENAI_API_KEY,
        timeout: parseInt(process.env.OPENAI_TIMEOUT || "120", 10),
      };
    case "xai":
      return {
        provider: "xai",
        model: process.env.XAI_MODEL || "grok-4.6",
        base_url: process.env.XAI_BASE_URL || "https://api.x.ai/v1",
        api_key: process.env.XAI_API_KEY,
        timeout: parseInt(process.env.XAI_TIMEOUT || "120", 10),
      };
    case "openrouter":
      return {
        provider: "openrouter",
        model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
        base_url: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        api_key: process.env.OPENROUTER_API_KEY,
        timeout: parseInt(process.env.OPENROUTER_TIMEOUT || "120", 10),
      };
    case "anthropic":
      return {
        provider: "anthropic",
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        base_url: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
        api_key: process.env.ANTHROPIC_API_KEY,
        timeout: parseInt(process.env.ANTHROPIC_TIMEOUT || "120", 10),
      };
    default:
      throw new Error(
        `Unknown PROVIDER '${lower}'. Expected one of: ${SUPPORTED_PROVIDERS.join(", ")}.`
      );
  }
}
