import { afterEach, describe, expect, it } from "vitest";
import { loadProviderEnvConfig } from "../src/providers/config";

const TIMEOUT_VARS = [
  "OLLAMA_TIMEOUT",
  "KILO_TIMEOUT",
  "OPENAI_TIMEOUT",
  "XAI_TIMEOUT",
  "OPENROUTER_TIMEOUT",
  "NVIDIA_TIMEOUT",
  "ANTHROPIC_TIMEOUT",
] as const;

afterEach(() => {
  for (const name of TIMEOUT_VARS) {
    delete process.env[name];
  }
});

describe("provider timeout configuration", () => {
  it("uses the configured positive integer timeout", () => {
    process.env.NVIDIA_TIMEOUT = "45";

    expect(loadProviderEnvConfig("nvidia").timeout).toBe(45);
  });

  it.each(["", "abc", "12seconds", "0", "-5", "1.5", "Infinity"]) (
    "falls back to the default for invalid timeout %j",
    (value) => {
      process.env.NVIDIA_TIMEOUT = value;

      expect(loadProviderEnvConfig("nvidia").timeout).toBe(120);
    },
  );

  it("applies the same validation to every provider with a timeout setting", () => {
    for (const name of [
      "ollama",
      "kilo",
      "openai",
      "xai",
      "openrouter",
      "nvidia",
      "anthropic",
    ]) {
      const envName = `${name.toUpperCase()}_TIMEOUT`;
      process.env[envName] = "not-a-number";
      expect(loadProviderEnvConfig(name).timeout).toBe(120);
      delete process.env[envName];
    }
  });
});
