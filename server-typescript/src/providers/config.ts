export const SUPPORTED_PROVIDERS = [
  "gemini",
  "ollama",
  "kilo",
  "openai",
  "xai",
  "openrouter",
  "anthropic",
  "nvidia",
] as const;

export type SupportedProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export interface ProviderEnvConfig {
  provider: string;
  model: string;
  base_url?: string;
  api_key?: string;
  timeout: number;
}

const DEFAULT_TIMEOUT = 120;

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_TIMEOUT;
  }

  const timeout = Number(value.trim());
  return Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT;
}

export function loadProviderEnvConfig(name: string): ProviderEnvConfig {
  const lower = (name || "").toLowerCase();

  switch (lower) {
    case "gemini":
      return {
        provider: "gemini",
        model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
        api_key: process.env.GOOGLE_API_KEY,
        timeout: DEFAULT_TIMEOUT,
      };
    case "ollama": {
      const baseUrl =
        process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://localhost:11434/v1";
      return {
        provider: "ollama",
        model: process.env.OLLAMA_MODEL || "llama3.1",
        base_url: baseUrl,
        timeout: parseTimeout(process.env.OLLAMA_TIMEOUT),
      };
    }
    case "kilo":
      return {
        provider: "kilo",
        model: process.env.KILO_MODEL || "kilocode/kilo-auto/balanced",
        base_url: process.env.KILO_BASE_URL || "https://api.kilo.ai/api/gateway",
        api_key: process.env.KILO_API_KEY,
        timeout: parseTimeout(process.env.KILO_TIMEOUT),
      };
    case "openai":
      return {
        provider: "openai",
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        base_url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        api_key: process.env.OPENAI_API_KEY,
        timeout: parseTimeout(process.env.OPENAI_TIMEOUT),
      };
    case "xai":
      return {
        provider: "xai",
        model: process.env.XAI_MODEL || "grok-4.6",
        base_url: process.env.XAI_BASE_URL || "https://api.x.ai/v1",
        api_key: process.env.XAI_API_KEY,
        timeout: parseTimeout(process.env.XAI_TIMEOUT),
      };
    case "openrouter":
      return {
        provider: "openrouter",
        model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
        base_url: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        api_key: process.env.OPENROUTER_API_KEY,
        timeout: parseTimeout(process.env.OPENROUTER_TIMEOUT),
      };
    case "nvidia":
      return {
        provider: "nvidia",
        model: process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct",
        base_url: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
        api_key: process.env.NVIDIA_API_KEY,
        timeout: parseTimeout(process.env.NVIDIA_TIMEOUT),
      };
    case "anthropic":
      return {
        provider: "anthropic",
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        base_url: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
        api_key: process.env.ANTHROPIC_API_KEY,
        timeout: parseTimeout(process.env.ANTHROPIC_TIMEOUT),
      };
    default:
      throw new Error(
        `Unknown PROVIDER '${lower}'. Expected one of: ${SUPPORTED_PROVIDERS.join(", ")}.`
      );
  }
}
