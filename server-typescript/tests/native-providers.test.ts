import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { getProvider } from "../src/providers/factory.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GeminiProvider", () => {
  it("builds Gemini-native contents and preserves conversation roles", () => {
    const provider = new GeminiProvider({ model: "gemini-test", api_key: "key" });
    expect(provider.buildContents("new question", [
      { role: "user", parts: [{ text: "old question" }] },
      { role: "model", parts: [{ text: "old answer" }] },
    ])).toEqual([
      { role: "user", parts: [{ text: "old question" }] },
      { role: "model", parts: [{ text: "old answer" }] },
      { role: "user", parts: [{ text: "new question" }] },
    ]);
  });

  it("parses text and function calls from a native Gemini response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text: "I will inspect that." },
            { functionCall: { name: "read_file", args: { path: "README.md" }, id: "gem-1" } },
          ],
        },
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider({ model: "gemini-test", api_key: "key" });
    const response = await provider.generate(provider.buildContents("read README", []));

    expect(response.text).toBe("I will inspect that.");
    expect(response.tool_calls).toEqual([
      { name: "read_file", args: { path: "README.md" }, id: "gem-1" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/models/gemini-test:generateContent");
  });

  it("round-trips a Gemini function result using the model call id", () => {
    const provider = new GeminiProvider({ model: "gemini-test", api_key: "key" });
    const response = {
      text: null,
      tool_calls: [{ name: "read_file", args: { path: "README.md" }, id: "gem-1" }],
      raw: {
        role: "model",
        parts: [{ functionCall: { name: "read_file", args: { path: "README.md" }, id: "gem-1" } }],
      },
    };
    const withModel = provider.appendModelTurn([], response);
    const withResult = provider.appendToolResults(withModel, [
      { name: "read_file", result: { contents: "hello" } },
    ]);

    expect(withResult.at(-1)).toEqual({
      role: "user",
      parts: [{
        functionResponse: {
          name: "read_file",
          response: { result: { contents: "hello" } },
          id: "gem-1",
        },
      }],
    });
  });

  it("reports a missing API key without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GeminiProvider({ model: "gemini-test" });

    await expect(provider.generate([])).rejects.toThrow(/GOOGLE_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(provider.probe()).resolves.toEqual({
      available: false,
      error: "Gemini API key is not configured (GOOGLE_API_KEY).",
    });
  });
});

describe("AnthropicProvider", () => {
  it("builds Anthropic-native user and assistant messages", () => {
    const provider = new AnthropicProvider({ model: "claude-test", api_key: "key" });
    expect(provider.buildContents("new question", [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ])).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ]);
  });

  it("parses text and tool_use blocks from a native Anthropic response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: "msg_1",
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect that." },
        { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
      ],
      stop_reason: "tool_use",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicProvider({ model: "claude-test", api_key: "key" });
    const response = await provider.generate(provider.buildContents("read README", []));

    expect(response.text).toBe("I will inspect that.");
    expect(response.tool_calls).toEqual([
      { name: "read_file", args: { path: "README.md" }, id: "tool-1" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      "x-api-key": "key",
      "anthropic-version": "2023-06-01",
    });
  });

  it("round-trips an Anthropic tool result using the tool_use id", () => {
    const provider = new AnthropicProvider({ model: "claude-test", api_key: "key" });
    const response = {
      text: null,
      tool_calls: [{ name: "read_file", args: { path: "README.md" }, id: "tool-1" }],
      raw: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } }],
    };
    const withModel = provider.appendModelTurn([], response);
    const withResult = provider.appendToolResults(withModel, [
      { name: "read_file", result: { contents: "hello" } },
    ]);

    expect(withResult.at(-1)).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: JSON.stringify({ contents: "hello" }),
      }],
    });
  });

  it("reports a missing API key without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({ model: "claude-test" });

    await expect(provider.generate([])).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(provider.probe()).resolves.toEqual({
      available: false,
      error: "Anthropic API key is not configured (ANTHROPIC_API_KEY).",
    });
  });
});

describe("provider factory", () => {
  it("uses native providers instead of StubProvider", () => {
    const gemini = getProvider("gemini");
    const anthropic = getProvider("anthropic");
    expect(gemini).toBeInstanceOf(GeminiProvider);
    expect(anthropic).toBeInstanceOf(AnthropicProvider);
  });
});
