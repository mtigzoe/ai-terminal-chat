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
    expect(contents[0].role).toBe("system");
    expect(contents[0].content).toContain("You are a local coding/project agent");
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
      { role: "system", content: expect.stringContaining("You are a local coding/project agent") },
      { role: "user", content: "Hello" },
    ]);
  });

  // Regression: the prefix used an over-escaped "\\n" inside a template
  // literal, so the two characters "\" and "n" were sent to the provider
  // instead of a line break. The instructions were glued onto the end of the
  // prefix sentence, losing the block framing the wording promises. The
  // existing assertions above use stringContaining(instruction) and cannot
  // see this, so assert the separator directly.
  const PREFIX =
    "Additional user instructions for this chat (follow only when consistent with the assistant's system instructions):";

  it("separates the instructions from the prefix with a real newline", () => {
    const openai = new OpenAICompatibleProvider({
      base_url: "http://localhost:11434/v1",
      model: "test-model",
    });
    const gemini = new GeminiProvider({ model: "test-model" });
    const anthropic = new AnthropicProvider({ model: "test-model" });

    const texts = [
      (openai.buildContents("Hello", [], instruction) as { content?: string }[])[1]?.content,
      (gemini.buildContents("Hello", [], instruction) as { parts?: { text?: string }[] }[])[0]?.parts?.[0]?.text,
      (anthropic.buildContents("Hello", [], instruction) as { content?: string }[])[0]?.content,
    ];

    for (const text of texts) {
      expect(typeof text).toBe("string");
      expect(text).toBe(`${PREFIX}\n${instruction}`);
      expect(text).not.toContain("\\n");
    }
  });
});
