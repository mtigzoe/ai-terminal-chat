import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { StubProvider, isGitStatusRequest, isGitBranchRequest, isGitLogRequest, isGitDiffRequest, isCommittedFileCountRequest } from "../src/providers/stub.ts";
import { getProvider, buildProviderStatus } from "../src/providers/factory.ts";
import { loadProviderEnvConfig, SUPPORTED_PROVIDERS } from "../src/providers/config.ts";
import { SYSTEM_INSTRUCTION, CHAT_ONLY_INSTRUCTION } from "../src/prompts.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";

// ---------------------------------------------------------------------------
// Env var isolation helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "PROVIDER",
  "GEMINI_MODEL",
  "GOOGLE_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_HOST",
  "OLLAMA_MODEL",
  "OLLAMA_TIMEOUT",
  "KILO_MODEL",
  "KILO_BASE_URL",
  "KILO_API_KEY",
  "KILO_TIMEOUT",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_TIMEOUT",
  "XAI_MODEL",
  "XAI_BASE_URL",
  "XAI_API_KEY",
  "XAI_TIMEOUT",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_TIMEOUT",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TIMEOUT",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider - construction
// ---------------------------------------------------------------------------

describe("OpenAICompatibleProvider construction", () => {
  it("throws when base_url is empty", () => {
    expect(() => new OpenAICompatibleProvider({ base_url: "", model: "m" })).toThrow(
      /base URL is not set/
    );
  });

  it("throws when base_url is whitespace only", () => {
    expect(() => new OpenAICompatibleProvider({ base_url: "   ", model: "m" })).toThrow(
      /base URL is not set/
    );
  });

  it("includes the display name in the missing base URL error", () => {
    expect(
      () => new OpenAICompatibleProvider({ base_url: "", model: "m", display_name: "Kilo" })
    ).toThrow(/^Kilo base URL is not set\.$/);
  });

  it("strips a single trailing slash from base_url", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://localhost:1234/", model: "m" });
    expect(provider.baseUrl).toBe("http://localhost:1234");
  });

  it("leaves a base_url without a trailing slash untouched", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://localhost:1234", model: "m" });
    expect(provider.baseUrl).toBe("http://localhost:1234");
  });

  it("defaults displayName to 'OpenAI-compatible'", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    expect(provider.displayName).toBe("OpenAI-compatible");
  });

  it("defaults timeout to 120 seconds", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    expect(provider.timeout).toBe(120);
  });

  it("defaults capabilities to tools/streaming/model_listing enabled, no key required, not local", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    expect(provider.capabilities).toEqual({
      tools: true,
      streaming: true,
      model_listing: true,
      requires_api_key: false,
      local: false,
      notes: "",
    });
  });

  it("honors requires_api_key and local overrides", () => {
    const provider = new OpenAICompatibleProvider({
      base_url: "http://x",
      model: "m",
      requires_api_key: true,
      local: true,
    });
    expect(provider.capabilities.requires_api_key).toBe(true);
    expect(provider.capabilities.local).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider - buildContents
// ---------------------------------------------------------------------------

describe("OpenAICompatibleProvider.buildContents", () => {
  it("leads with SYSTEM_INSTRUCTION when tools are supported", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.buildContents("hi", []) as { role: string; content: string }[];
    expect(contents[0]).toEqual({ role: "system", content: SYSTEM_INSTRUCTION });
  });

  it("leads with CHAT_ONLY_INSTRUCTION when tools are unsupported", () => {
    const provider = new OpenAICompatibleProvider({
      base_url: "http://x",
      model: "m",
      capabilities: { tools: false },
    });
    const contents = provider.buildContents("hi", []) as { role: string; content: string }[];
    expect(contents[0]).toEqual({ role: "system", content: CHAT_ONLY_INSTRUCTION });
  });

  it("appends the user message last", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.buildContents("hello there", []) as { role: string; content: string }[];
    expect(contents.at(-1)).toEqual({ role: "user", content: "hello there" });
  });

  it("maps Gemini-style 'model' role history entries to 'assistant'", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.buildContents("next", [
      { role: "model", parts: [{ text: "prior reply" }] },
    ]) as { role: string; content: string }[];
    expect(contents).toContainEqual({ role: "assistant", content: "prior reply" });
  });

  it("preserves the 'user' role for user history entries", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.buildContents("next", [
      { role: "user", parts: [{ text: "earlier question" }] },
    ]) as { role: string; content: string }[];
    expect(contents).toContainEqual({ role: "user", content: "earlier question" });
  });

  it("joins multiple parts into a single content string", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.buildContents("next", [
      { role: "model", parts: [{ text: "part one " }, { text: "part two" }] },
    ]) as { role: string; content: string }[];
    expect(contents).toContainEqual({ role: "assistant", content: "part one part two" });
  });

  it("skips history entries that resolve to empty text", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.buildContents("next", [
      { role: "model", parts: [] },
      { role: "model", parts: [{ text: "" }] },
    ]) as { role: string; content: string }[];
    // system + user only; both empty-text history entries dropped
    expect(contents).toHaveLength(2);
  });

  it("skips malformed history entries that are not objects", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.buildContents("next", [null, "garbage", 42]) as unknown[];
    expect(contents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider - probe
// ---------------------------------------------------------------------------

describe("OpenAICompatibleProvider.probe", () => {
  it("is available on HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [] })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.probe()).resolves.toEqual({ available: true, error: null });
  });

  it("treats HTTP 404 from /models as available (endpoint just doesn't exist)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("not found", 404)));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.probe()).resolves.toEqual({ available: true, error: null });
  });

  it("treats HTTP 405 from /models as available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("method not allowed", 405)));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.probe()).resolves.toEqual({ available: true, error: null });
  });

  it("is unavailable with a descriptive error on other HTTP error statuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("boom", 500)));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m", display_name: "Kilo" });
    const result = await provider.probe();
    expect(result.available).toBe(false);
    expect(result.error).toContain("Kilo");
    expect(result.error).toContain("HTTP 500");
  });

  it("is unavailable with an unreachable message on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m", display_name: "Ollama" });
    const result = await provider.probe();
    expect(result.available).toBe(false);
    expect(result.error).toContain("Could not reach Ollama");
  });

  it("surfaces a timeout-specific message when the request aborts", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const result = await provider.probe();
    expect(result.available).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("hits GET {base_url}/models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://localhost:9/v1", model: "m" });
    await provider.probe();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9/v1/models",
      expect.objectContaining({ method: "GET" })
    );
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider - headers
// ---------------------------------------------------------------------------

describe("OpenAICompatibleProvider request headers", () => {
  it("omits Authorization when no api_key is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await provider.probe();
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("sends a Bearer Authorization header when an api_key is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m", api_key: "secret-key" });
    await provider.probe();
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer secret-key");
  });

  it("always sends a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await provider.probe();
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider - listModels
// ---------------------------------------------------------------------------

describe("OpenAICompatibleProvider.listModels", () => {
  it("parses OpenAI-style {data: [{id}]} responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([{ id: "gpt-4o-mini" }, { id: "gpt-4o" }]);
  });

  it("parses Ollama-style {models: [{name}]} responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ models: [{ name: "llama3.1" }] })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([{ id: "llama3.1" }]);
  });

  it("parses raw string entries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: ["model-a", "model-b"] })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([{ id: "model-a" }, { id: "model-b" }]);
  });

  it("falls back to a 'model' field when id/name are absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ model: "custom-model" }] })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([{ id: "custom-model" }]);
  });

  it("drops entries without any usable id field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ foo: "bar" }, { id: "keep-me" }] })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([{ id: "keep-me" }]);
  });

  it("returns an empty array on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("nope", 500)));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it("returns an empty array when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it("returns an empty array when neither data nor models keys are present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ unrelated: true })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.listModels()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider - generate / complete
// ---------------------------------------------------------------------------

describe("OpenAICompatibleProvider.generate", () => {
  it("parses a plain text response with no tool calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ choices: [{ message: { role: "assistant", content: "hello!" } }] })
      )
    );
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const result = await provider.generate([]);
    expect(result.text).toBe("hello!");
    expect(result.tool_calls).toEqual([]);
  });

  it("parses tool calls with JSON-string arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_1", function: { name: "list_files", arguments: '{"path":"."}' } },
                ],
              },
            },
          ],
        })
      )
    );
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const result = await provider.generate([]);
    expect(result.tool_calls).toEqual([{ name: "list_files", args: { path: "." }, id: "call_1" }]);
  });

  it("accepts tool call arguments that are already an object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: { path: "a.txt" } } }],
              },
            },
          ],
        })
      )
    );
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const result = await provider.generate([]);
    expect(result.tool_calls[0].args).toEqual({ path: "a.txt" });
  });

  it("falls back to empty args when the JSON string is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { tool_calls: [{ id: "call_1", function: { name: "x", arguments: "{not json" } }] } }],
        })
      )
    );
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const result = await provider.generate([]);
    expect(result.tool_calls[0].args).toEqual({});
  });

  it("leaves the tool call id undefined when the API omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "{}" } }] } }],
        })
      )
    );
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const result = await provider.generate([]);
    expect(result.tool_calls[0].id).toBeUndefined();
  });

  it("preserves the raw assistant message on the response", async () => {
    const message = { role: "assistant", content: "hi", extra_field: 123 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message }] })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const result = await provider.generate([]);
    expect(result.raw).toEqual(message);
  });

  it("includes tool schemas in the request body when tools are supported and present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await provider.generate([]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it("omits tools from the request body when the capability is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      base_url: "http://x",
      model: "m",
      capabilities: { tools: false },
    });
    await provider.generate([]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it("omits tools from the request body when setTools([]) is used", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    provider.setTools([]);
    await provider.generate([]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it("posts to {base_url}/chat/completions with the model and messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "my-model" });
    const contents = [{ role: "user", content: "hi" }];
    await provider.generate(contents);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://x/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("my-model");
    expect(body.messages).toEqual(contents);
  });

  it("throws with the HTTP status and body on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("bad request details", 400)));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m", display_name: "Kilo" });
    await expect(provider.generate([])).rejects.toThrow(/Kilo request failed \(HTTP 400\): bad request details/);
  });

  it("throws on an unexpected response shape (missing choices)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })));
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    await expect(provider.generate([])).rejects.toThrow(/Unexpected response shape/);
  });

  it("retries in chat-only mode and updates capabilities when the server rejects tool calling", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("Error: 400 this model does not support tools", 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "chat-only reply" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });

    const result = await provider.generate([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("chat-only reply");
    expect(provider.capabilities.tools).toBe(false);
    expect(provider.capabilities.notes).toMatch(/chat-only mode/);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.tools).toBeUndefined();
  });

  it("does not retry, and rethrows, when the failure is unrelated to tool support", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("internal server error", 500));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });

    await expect(provider.generate([])).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.capabilities.tools).toBe(true);
  });

  it("does not attempt a chat-only retry when tools were already disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("does not support tool calling", 400));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      base_url: "http://x",
      model: "m",
      capabilities: { tools: false },
    });

    await expect(provider.generate([])).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider - appendModelTurn / appendToolResults
// ---------------------------------------------------------------------------

describe("OpenAICompatibleProvider.appendModelTurn", () => {
  it("preserves the raw message and forces role to assistant", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.appendModelTurn([{ role: "user", content: "hi" }], {
      text: "hello",
      tool_calls: [],
      raw: { role: "weird", content: "hello", tool_calls: [] },
    });
    expect(contents.at(-1)).toEqual({ role: "assistant", content: "hello", tool_calls: [] });
  });

  it("falls back to a plain assistant message when raw is not an object", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.appendModelTurn([], { text: "hello", tool_calls: [], raw: null });
    expect(contents.at(-1)).toEqual({ role: "assistant", content: "hello" });
  });

  it("falls back to empty content when both raw and text are absent", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = provider.appendModelTurn([], { text: null, tool_calls: [], raw: null });
    expect(contents.at(-1)).toEqual({ role: "assistant", content: "" });
  });
});

describe("OpenAICompatibleProvider.appendToolResults", () => {
  it("synthesizes call ids when the assistant turn's tool_calls lack them", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = [
      { role: "assistant", content: null, tool_calls: [{ function: { name: "list_files" } }] },
    ];
    const updated = provider.appendToolResults(contents, [{ name: "list_files", result: { files: [] } }]);
    expect(updated.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call-0",
      content: JSON.stringify({ files: [] }),
    });
  });

  it("preserves existing call ids", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = [
      { role: "assistant", tool_calls: [{ id: "abc123", function: { name: "list_files" } }] },
    ];
    const updated = provider.appendToolResults(contents, [{ name: "list_files", result: {} }]);
    expect((updated.at(-1) as { tool_call_id: string }).tool_call_id).toBe("abc123");
  });

  it("keeps result order aligned with call order across multiple tool calls", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = [
      {
        role: "assistant",
        tool_calls: [{ id: "id-a", function: { name: "a" } }, { id: "id-b", function: { name: "b" } }],
      },
    ];
    const updated = provider.appendToolResults(contents, [
      { name: "a", result: "first" },
      { name: "b", result: "second" },
    ]);
    expect(updated.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "id-a", content: JSON.stringify("first") },
      { role: "tool", tool_call_id: "id-b", content: JSON.stringify("second") },
    ]);
  });

  it("serializes a null result as JSON null", () => {
    const provider = new OpenAICompatibleProvider({ base_url: "http://x", model: "m" });
    const contents = [{ role: "assistant", tool_calls: [{ id: "id-a", function: { name: "a" } }] }];
    const updated = provider.appendToolResults(contents, [{ name: "a", result: null }]);
    expect((updated.at(-1) as { content: string }).content).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// config.loadProviderEnvConfig / SUPPORTED_PROVIDERS
// ---------------------------------------------------------------------------

describe("SUPPORTED_PROVIDERS", () => {
  it("lists exactly the seven supported provider names", () => {
    expect([...SUPPORTED_PROVIDERS]).toEqual([
      "gemini",
      "ollama",
      "kilo",
      "openai",
      "xai",
      "openrouter",
      "anthropic",
    ]);
  });
});

describe("loadProviderEnvConfig", () => {
  it("throws for an unknown provider naming the supported list", () => {
    expect(() => loadProviderEnvConfig("not-a-provider")).toThrow(/Unknown PROVIDER 'not-a-provider'/);
    expect(() => loadProviderEnvConfig("not-a-provider")).toThrow(/gemini, ollama, kilo/);
  });

  it("is case-insensitive", () => {
    expect(loadProviderEnvConfig("GEMINI").provider).toBe("gemini");
  });

  describe("gemini", () => {
    it("defaults model and reads GOOGLE_API_KEY", () => {
      process.env.GOOGLE_API_KEY = "g-key";
      const cfg = loadProviderEnvConfig("gemini");
      expect(cfg.model).toBe("gemini-3.6-flash");
      expect(cfg.api_key).toBe("g-key");
      expect(cfg.timeout).toBe(120);
    });

    it("respects GEMINI_MODEL override", () => {
      process.env.GEMINI_MODEL = "gemini-custom";
      expect(loadProviderEnvConfig("gemini").model).toBe("gemini-custom");
    });
  });

  describe("ollama", () => {
    it("defaults base_url, model, and timeout", () => {
      const cfg = loadProviderEnvConfig("ollama");
      expect(cfg.base_url).toBe("http://localhost:11434/v1");
      expect(cfg.model).toBe("llama3.1");
      expect(cfg.timeout).toBe(120);
    });

    it("prefers OLLAMA_BASE_URL over OLLAMA_HOST", () => {
      process.env.OLLAMA_BASE_URL = "http://from-base-url:11434/v1";
      process.env.OLLAMA_HOST = "http://from-host:11434/v1";
      expect(loadProviderEnvConfig("ollama").base_url).toBe("http://from-base-url:11434/v1");
    });

    it("falls back to OLLAMA_HOST when OLLAMA_BASE_URL is unset", () => {
      process.env.OLLAMA_HOST = "http://from-host:11434/v1";
      expect(loadProviderEnvConfig("ollama").base_url).toBe("http://from-host:11434/v1");
    });

    it("parses OLLAMA_TIMEOUT as an integer", () => {
      process.env.OLLAMA_TIMEOUT = "45";
      expect(loadProviderEnvConfig("ollama").timeout).toBe(45);
    });

    it("does not require an api key", () => {
      expect(loadProviderEnvConfig("ollama").api_key).toBeUndefined();
    });
  });

  describe("kilo / openai / xai / openrouter", () => {
    it.each([
      ["kilo", "KILO_MODEL", "kilocode/kilo-auto/balanced", "KILO_BASE_URL", "https://api.kilo.ai/api/gateway", "KILO_API_KEY", "KILO_TIMEOUT"],
      ["openai", "OPENAI_MODEL", "gpt-4o-mini", "OPENAI_BASE_URL", "https://api.openai.com/v1", "OPENAI_API_KEY", "OPENAI_TIMEOUT"],
      ["xai", "XAI_MODEL", "grok-4.6", "XAI_BASE_URL", "https://api.x.ai/v1", "XAI_API_KEY", "XAI_TIMEOUT"],
      ["openrouter", "OPENROUTER_MODEL", "openai/gpt-4o-mini", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", "OPENROUTER_TIMEOUT"],
    ] as const)("%s: defaults model/base_url/timeout and reads the api key", (provider, modelKey, defaultModel, baseUrlKey, defaultBaseUrl, apiKeyKey, timeoutKey) => {
      const cfg = loadProviderEnvConfig(provider);
      expect(cfg.model).toBe(defaultModel);
      expect(cfg.base_url).toBe(defaultBaseUrl);
      expect(cfg.timeout).toBe(120);
      expect(cfg.api_key).toBeUndefined();

      process.env[modelKey] = "custom-model";
      process.env[baseUrlKey] = "https://custom.example/v1";
      process.env[apiKeyKey] = "custom-key";
      process.env[timeoutKey] = "30";
      const overridden = loadProviderEnvConfig(provider);
      expect(overridden.model).toBe("custom-model");
      expect(overridden.base_url).toBe("https://custom.example/v1");
      expect(overridden.api_key).toBe("custom-key");
      expect(overridden.timeout).toBe(30);
    });
  });

  describe("anthropic", () => {
    it("defaults model, base_url, and timeout", () => {
      const cfg = loadProviderEnvConfig("anthropic");
      expect(cfg.model).toBe("claude-sonnet-4-5");
      expect(cfg.base_url).toBe("https://api.anthropic.com");
      expect(cfg.timeout).toBe(120);
    });

    it("respects ANTHROPIC_API_KEY", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      expect(loadProviderEnvConfig("anthropic").api_key).toBe("sk-ant-test");
    });
  });
});

// ---------------------------------------------------------------------------
// factory.getProvider
// ---------------------------------------------------------------------------

describe("getProvider", () => {
  it("defaults to gemini when no name or PROVIDER env var is given", () => {
    const provider = getProvider();
    expect(provider.name).toBe("gemini");
  });

  it("respects the PROVIDER env var when no explicit name is given", () => {
    process.env.PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "k";
    const provider = getProvider();
    expect(provider.name).toBe("openai");
  });

  it("an explicit name argument takes precedence over the PROVIDER env var", () => {
    process.env.PROVIDER = "openai";
    const provider = getProvider("ollama");
    expect(provider.name).toBe("ollama");
  });

  it("throws for an unknown provider name", () => {
    expect(() => getProvider("not-real")).toThrow(/Unknown PROVIDER 'not-real'/);
  });

  it("builds gemini as a native gemini provider requiring an api key, not local", () => {
    const provider = getProvider("gemini");
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.displayName).toBe("Gemini");
    expect(provider.capabilities).toMatchObject({ requires_api_key: true, local: false, tools: true });
  });

  it("builds anthropic as a native anthropic provider requiring an api key, not local", () => {
    const provider = getProvider("anthropic");
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.displayName).toBe("Anthropic");
    expect(provider.capabilities).toMatchObject({ requires_api_key: true, local: false });
  });

  it("builds ollama as a local OpenAI-compatible provider with the default base_url", () => {
    const provider = getProvider("ollama");
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe("ollama");
    expect((provider as OpenAICompatibleProvider).baseUrl).toBe("http://localhost:11434/v1");
    expect(provider.capabilities.local).toBe(true);
    expect(provider.capabilities.requires_api_key).toBe(false);
  });

  it("builds kilo, openai, xai, and openrouter as non-local OpenAI-compatible providers", () => {
    for (const name of ["kilo", "openai", "xai", "openrouter"]) {
      const provider = getProvider(name);
      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(provider.name).toBe(name);
      expect(provider.capabilities.local).toBe(false);
    }
  });

  it("marks openai as requiring an api key", () => {
    expect(getProvider("openai").capabilities.requires_api_key).toBe(true);
  });

  it("an explicit model override wins over the env-resolved model", () => {
    process.env.OPENAI_MODEL = "env-model";
    const provider = getProvider("openai", { model: "override-model" });
    expect(provider.model).toBe("override-model");
  });

  it("sets providerConfig.model/base_url/api_key from the resolved env config", () => {
    process.env.KILO_API_KEY = "kilo-secret";
    const provider = getProvider("kilo");
    expect(provider.providerConfig).toMatchObject({
      provider: "kilo",
      model: "kilocode/kilo-auto/balanced",
      base_url: "https://api.kilo.ai/api/gateway",
      api_key: "kilo-secret",
    });
  });
});

// ---------------------------------------------------------------------------
// factory.buildProviderStatus
// ---------------------------------------------------------------------------

describe("buildProviderStatus", () => {
  it("skips probing entirely when probe=false", async () => {
    const provider = getProvider("ollama");
    const status = await buildProviderStatus(provider, false);
    expect(status.available).toBeUndefined();
    expect(status.error).toBeUndefined();
    expect(status.diagnostics).toBeUndefined();
  });

  it("marks a reachable provider as available with no diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [] })));
    const provider = getProvider("openai", { model: "m" });
    const status = await buildProviderStatus(provider, true);
    expect(status.available).toBe(true);
    expect(status.diagnostics).toBeUndefined();
  });

  it("builds local-flavored diagnostics (including the ollama serve hint) for an unreachable local provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const provider = getProvider("ollama");
    const status = await buildProviderStatus(provider, true);
    expect(status.available).toBe(false);
    expect(status.diagnostics).toBeDefined();
    const causes = status.diagnostics!.possible_causes as string[];
    expect(causes.some((c) => c.includes("not running"))).toBe(true);
    expect(causes.some((c) => c.includes("ollama serve"))).toBe(true);
    expect(status.diagnostics!.provider).toBe("Ollama");
  });

  it("builds remote-flavored diagnostics (api key / network) for an unreachable non-local provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const provider = getProvider("openai");
    const status = await buildProviderStatus(provider, true);
    expect(status.available).toBe(false);
    const causes = status.diagnostics!.possible_causes as string[];
    expect(causes.some((c) => c.includes("API key"))).toBe(true);
    expect(causes.some((c) => c.includes("ollama serve"))).toBe(false);
  });

  it("surfaces capability notes as the status error when the provider is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(textResponse("tool calling not supported here", 400))
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }))
        .mockResolvedValue(jsonResponse({ data: [] }))
    );
    const provider = getProvider("openai");
    await provider.generate([]); // triggers the tools-unsupported fallback and sets notes
    const status = await buildProviderStatus(provider, true);
    expect(status.available).toBe(true);
    expect(status.error).toMatch(/chat-only mode/);
  });

  it("includes base_url from the provider config", async () => {
    const provider = getProvider("kilo");
    const status = await buildProviderStatus(provider, false);
    expect(status.base_url).toBe("https://api.kilo.ai/api/gateway");
  });
});

// ---------------------------------------------------------------------------
// StubProvider - request intent detection helpers
// ---------------------------------------------------------------------------

describe("isGitStatusRequest", () => {
  it.each([
    "what's my git status",
    "git status",
    "did I commit everything?",
    "am I safe to git push?",
    "is everything committed?",
  ])("recognizes %s", (message) => {
    expect(isGitStatusRequest(message)).toBe(true);
  });

  it("rejects unrelated messages", () => {
    expect(isGitStatusRequest("what's the weather like")).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(isGitStatusRequest("   ")).toBe(false);
  });
});

describe("isGitBranchRequest", () => {
  it.each(["git branch", "what branch am I on", "list branches", "current branch"])(
    "recognizes %s",
    (message) => {
      expect(isGitBranchRequest(message)).toBe(true);
    }
  );

  it("rejects unrelated messages", () => {
    expect(isGitBranchRequest("read the readme")).toBe(false);
  });
});

describe("isGitLogRequest", () => {
  it.each(["git log", "recent commits", "show me the commit history"])(
    "recognizes %s",
    (message) => {
      expect(isGitLogRequest(message)).toBe(true);
    }
  );

  it("rejects unrelated messages", () => {
    expect(isGitLogRequest("list files")).toBe(false);
  });
});

describe("isGitDiffRequest", () => {
  it.each(["git diff", "what changed", "show the diff"])("recognizes %s", (message) => {
    expect(isGitDiffRequest(message)).toBe(true);
  });

  it("rejects unrelated messages", () => {
    expect(isGitDiffRequest("run the tests")).toBe(false);
  });
});

describe("isCommittedFileCountRequest", () => {
  it("recognizes 'how many files are committed'", () => {
    expect(isCommittedFileCountRequest("how many files are committed?")).toBe(true);
  });

  it("recognizes the contracted 'committed' spelling", () => {
    expect(isCommittedFileCountRequest("how many files committed")).toBe(true);
  });

  it("rejects unrelated messages", () => {
    expect(isCommittedFileCountRequest("how many branches do I have")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StubProvider - generate()
// ---------------------------------------------------------------------------

function userMsg(content: string) {
  return { role: "user", content };
}

describe("StubProvider.generate default behavior", () => {
  it("returns a generic hello message for unrelated input, with no tool calls", async () => {
    const provider = new StubProvider("gemini", "gemini-3.6-flash");
    const result = await provider.generate([userMsg("tell me a joke")]);
    expect(result.text).toBe("[stub] Hello from gemini-3.6-flash");
    expect(result.tool_calls).toEqual([]);
  });
});

describe("StubProvider.generate git-status intent -> tool call", () => {
  it("requests git_status when asked about status with no prior tool result", async () => {
    const provider = new StubProvider("gemini", "m");
    const result = await provider.generate([userMsg("what's my git status?")]);
    expect(result.tool_calls).toEqual([{ name: "git_status", args: {} }]);
    expect(result.text).toBeNull();
  });

  it("requests git_branch for branch questions", async () => {
    const provider = new StubProvider("gemini", "m");
    const result = await provider.generate([userMsg("what branch am I on?")]);
    expect(result.tool_calls).toEqual([{ name: "git_branch", args: {} }]);
  });

  it("requests git_log for recent-commits questions", async () => {
    const provider = new StubProvider("gemini", "m");
    const result = await provider.generate([userMsg("show me recent commits")]);
    expect(result.tool_calls).toEqual([{ name: "git_log", args: {} }]);
  });

  it("requests git_diff for what-changed questions", async () => {
    const provider = new StubProvider("gemini", "m");
    const result = await provider.generate([userMsg("what changed?")]);
    expect(result.tool_calls).toEqual([{ name: "git_diff", args: {} }]);
  });

  it("requests git_committed_file_count for file-count questions", async () => {
    const provider = new StubProvider("gemini", "m");
    const result = await provider.generate([userMsg("how many files are committed?")]);
    expect(result.tool_calls).toEqual([{ name: "git_committed_file_count", args: {} }]);
  });
});

describe("StubProvider.generate formats git_status tool results", () => {
  it("answers a clean commit question affirmatively", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("did I commit everything?"),
      {
        role: "tool",
        name: "git_status",
        result: { clean: true, synchronized: true, ahead: 0, behind: 0, staged: 0, changed: 0, untracked: 0, details: [] },
      },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("Yes. Your working tree is clean; all changes have been committed.");
  });

  it("answers a dirty commit question with counts and staged files", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("have I commit all of my changes"),
      {
        role: "tool",
        name: "git_status",
        result: {
          clean: false,
          staged: 1,
          changed: 2,
          untracked: 1,
          details: ["M file.txt", "?? new.txt"],
        },
      },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toContain("No. You still have 3 uncommitted files.");
    expect(result.text).toContain("1 file is already staged");
    expect(result.text).toContain("- M file.txt");
  });

  it("answers a push-readiness question when synced and clean", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("am I safe to git push?"),
      { role: "tool", name: "git_status", result: { clean: true, synchronized: true, ahead: 0, behind: 0 } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toContain("synchronized with the remote");
  });

  it("answers a push-readiness question with unpushed commits", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("did I push?"),
      { role: "tool", name: "git_status", result: { clean: true, synchronized: false, ahead: 2, behind: 0 } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toContain("2 commits that have not been pushed");
  });

  it("mentions being behind the remote when applicable", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("can I git push?"),
      { role: "tool", name: "git_status", result: { clean: true, synchronized: false, ahead: 1, behind: 3 } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toContain("3 commits behind the remote");
  });

  it("falls back to the plain summary and file list for a non-question status check", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("show my git status"),
      { role: "tool", name: "git_status", result: { summary: "1 file changed", details: ["M a.txt"] } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("1 file changed\n\nFiles:\n- M a.txt");
  });

  it("returns the raw error string when the tool result contains an error", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("git status"),
      { role: "tool", name: "git_status", result: { error: "git is not installed or not on PATH." } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("git is not installed or not on PATH.");
  });
});

describe("StubProvider.generate formats other git tool results", () => {
  it("formats git_branch results, trimmed", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("what branches do I have"),
      { role: "tool", name: "git_branch", result: { branches: "  * main\n  dev\n" } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("* main\n  dev");
  });

  it("reports no branches when the branch list is empty", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [userMsg("branches"), { role: "tool", name: "git_branch", result: { branches: "" } }];
    const result = await provider.generate(contents);
    expect(result.text).toBe("This repository has no branches.");
  });

  it("formats git_log results with a truncation note when present", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("git log"),
      { role: "tool", name: "git_log", result: { log: "abc123 Initial commit", truncation_note: "Log output was truncated." } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("abc123 Initial commit\n\nLog output was truncated.");
  });

  it("reports no commits when the log is empty", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [userMsg("git log"), { role: "tool", name: "git_log", result: { log: "" } }];
    const result = await provider.generate(contents);
    expect(result.text).toBe("This repository has no commits.");
  });

  it("formats git_diff results with a truncation note when present", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("what changed"),
      { role: "tool", name: "git_diff", result: { diff: "+added line", truncation_note: "Diff was truncated." } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("+added line\n\nDiff was truncated.");
  });

  it("reports no differences when the diff is empty", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [userMsg("diff"), { role: "tool", name: "git_diff", result: { diff: "" } }];
    const result = await provider.generate(contents);
    expect(result.text).toBe("No differences found.");
  });

  it("formats a plural committed file count", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("how many files are committed"),
      { role: "tool", name: "git_committed_file_count", result: { committed_files: 5 } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("The current commit contains 5 tracked files.");
  });

  it("formats a singular committed file count", async () => {
    const provider = new StubProvider("gemini", "m");
    const contents = [
      userMsg("how many files are committed"),
      { role: "tool", name: "git_committed_file_count", result: { committed_files: 1 } },
    ];
    const result = await provider.generate(contents);
    expect(result.text).toBe("The current commit contains 1 tracked file.");
  });

  it("surfaces tool-result errors verbatim for branch/log/diff/count", async () => {
    const provider = new StubProvider("gemini", "m");
    for (const name of ["git_branch", "git_log", "git_diff", "git_committed_file_count"]) {
      const contents = [userMsg("go"), { role: "tool", name, result: { error: `${name} failed` } }];
      const result = await provider.generate(contents);
      expect(result.text).toBe(`${name} failed`);
    }
  });
});

describe("StubProvider.appendModelTurn / appendToolResults", () => {
  it("appends an assistant turn with the response text", () => {
    const provider = new StubProvider("gemini", "m");
    const contents = provider.appendModelTurn([userMsg("hi")], { text: "hello!", tool_calls: [], raw: null });
    expect(contents.at(-1)).toEqual({ role: "assistant", content: "hello!" });
  });

  it("appends tool results tagged with role 'tool'", () => {
    const provider = new StubProvider("gemini", "m");
    const contents = provider.appendToolResults([], [{ name: "git_status", result: { clean: true } }]);
    expect(contents.at(-1)).toEqual({ role: "tool", name: "git_status", result: { clean: true } });
  });
});

describe("StubProvider.buildContents", () => {
  it("appends the user message to history unchanged", () => {
    const provider = new StubProvider("gemini", "m");
    const history = [userMsg("first")];
    const contents = provider.buildContents("second", history);
    expect(contents).toEqual([userMsg("first"), userMsg("second")]);
  });
});
