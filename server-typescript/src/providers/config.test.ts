import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { loadProviderEnvConfig } from "./config.js";

const TIMEOUT_VARS = [
  "GEMINI_TIMEOUT",
  "OLLAMA_TIMEOUT",
  "KILO_TIMEOUT",
  "OPENAI_TIMEOUT",
  "XAI_TIMEOUT",
  "OPENROUTER_TIMEOUT",
  "NVIDIA_TIMEOUT",
  "ANTHROPIC_TIMEOUT",
];

const originalEnv = Object.fromEntries(
  TIMEOUT_VARS.map((name) => [name, process.env[name]])
) as Record<string, string | undefined>;

afterEach(() => {
  for (const name of TIMEOUT_VARS) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("loadProviderEnvConfig timeouts", () => {
  test("honors GEMINI_TIMEOUT", () => {
    process.env.GEMINI_TIMEOUT = "37";
    assert.equal(loadProviderEnvConfig("gemini").timeout, 37);
  });

  test("falls back to the default for an invalid Gemini timeout", () => {
    process.env.GEMINI_TIMEOUT = "0";
    assert.equal(loadProviderEnvConfig("gemini").timeout, 120);
  });

  test("continues honoring provider-specific timeout settings", () => {
    process.env.OLLAMA_TIMEOUT = "41";
    process.env.KILO_TIMEOUT = "42";
    process.env.OPENAI_TIMEOUT = "43";
    process.env.XAI_TIMEOUT = "44";
    process.env.OPENROUTER_TIMEOUT = "45";
    process.env.NVIDIA_TIMEOUT = "46";
    process.env.ANTHROPIC_TIMEOUT = "47";

    assert.equal(loadProviderEnvConfig("ollama").timeout, 41);
    assert.equal(loadProviderEnvConfig("kilo").timeout, 42);
    assert.equal(loadProviderEnvConfig("openai").timeout, 43);
    assert.equal(loadProviderEnvConfig("xai").timeout, 44);
    assert.equal(loadProviderEnvConfig("openrouter").timeout, 45);
    assert.equal(loadProviderEnvConfig("nvidia").timeout, 46);
    assert.equal(loadProviderEnvConfig("anthropic").timeout, 47);
  });
});
