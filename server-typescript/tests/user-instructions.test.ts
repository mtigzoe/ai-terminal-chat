import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";

const instruction = "Prefer TypeScript and explain changes briefly.";

describe("saved user instructions", () => {
  it("includes instructions in Gemini contents", () => {
    const provider = new GeminiProvider({ model: "test-model" });
    const contents = provider.buildContents("Hello", [], instruction);
    expect(contents[0]).toEqual({
      role: "user",
      parts: [{ text: expect.stringContaining(instruction) }],
    });
    expect(contents.at(-1)).toEqual({
      role: "user",
      parts: [{ text: "Hello" }],
    });
  });

  it("includes instructions in OpenAI-compatible contents", () => {
    const provider = new OpenAICompatibleProvider({
      base_url: "http://localhost:11434/v1",
      model: "test-model",
    });
    const contents = provider.buildContents("Hello", [], instruction);
    expect(contents[0]).toEqual({
      role: "system",
      content: expect.stringContaining("system instructions"),
    });
    expect(contents[1]).toEqual({
      role: "user",
      content: expect.stringContaining(instruction),
    });
    expect(contents.at(-1)).toEqual({ role: "user", content: "Hello" });
  });

  it("includes instructions in Anthropic contents", () => {
    const provider = new AnthropicProvider({ model: "test-model" });
    const contents = provider.buildContents("Hello", [], instruction);
    expect(contents[0]).toEqual({
      role: "user",
      content: expect.stringContaining(instruction),
    });
    expect(contents.at(-1)).toEqual({ role: "user", content: "Hello" });
  });

  it("omits empty instructions", () => {
    const provider = new OpenAICompatibleProvider({
      base_url: "http://localhost:11434/v1",
      model: "test-model",
    });
    expect(provider.buildContents("Hello", [], "   ")).toEqual([
      { role: "system", content: expect.stringContaining("system instructions") },
      { role: "user", content: "Hello" },
    ]);
  });
});
