import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { SYSTEM_INSTRUCTION } from "../src/prompts.ts";

// Exercise the provider's serializer and request construction without network
// or DNS. Transport/security behavior is covered by the safe-fetch tests.
vi.mock("../src/safe-fetch.ts", () => ({
  safeFetch: (url: string, options: RequestInit) => fetch(url, options),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockAnthropic(responses: unknown[] = [{ content: [{ type: "text", text: "reply" }] }]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const body of responses) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
  }
  vi.stubGlobal("fetch", fetchMock);
  const provider = new AnthropicProvider({ model: "claude-test", api_key: "test-key" });
  return { provider, fetchMock };
}

function payloadAt(fetchMock: ReturnType<typeof mockAnthropic>["fetchMock"], index = 0) {
  const [url, options] = fetchMock.mock.calls[index];
  expect(url).toBe("https://api.anthropic.com/v1/messages");
  expect(options?.method).toBe("POST");
  expect(typeof options?.body).toBe("string");
  return JSON.parse(options!.body as string) as { messages: unknown[]; system: string };
}

describe("Anthropic conversation history", () => {
  it("sends alternating React turns and multipart text in exact conversation order", async () => {
    const { provider, fetchMock } = mockAnthropic();
    const history = [
      { role: "user", parts: [{ text: "First question.\n" }, { text: "Details." }], timestamp: 1 },
      { role: "model", parts: [{ text: "First answer." }], toolActivity: [{ type: "progress" }] },
      { role: "user", parts: [{ text: "Follow up: " }, { text: "keep the previous context." }] },
      { role: "assistant", parts: [{ text: "Second " }, { text: "answer." }] },
    ];
    const original = structuredClone(history);

    await provider.generate(provider.buildContents("What did I ask first?", history));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = payloadAt(fetchMock);
    expect(payload.messages).toEqual([
      { role: "user", content: "First question.\nDetails." },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Follow up: keep the previous context." },
      { role: "assistant", content: "Second answer." },
      { role: "user", content: "What did I ask first?" },
    ]);
    expect(payload.system).toBe(SYSTEM_INSTRUCTION);
    expect(history).toEqual(original);
  });

  it.each(["user", "model", "assistant"])("ignores malformed %s text parts without throwing or coercing them", async (role) => {
    const { provider, fetchMock } = mockAnthropic();
    const coerce = vi.fn(() => { throw new Error("must not coerce nonstring text"); });
    const contents = provider.buildContents("current", [{
      role,
      parts: [null, undefined, false, 42, "raw text", [], {}, { text: null }, { text: 7 },
        { text: true }, { text: [] }, { text: { toString: coerce } },
        { text: "before" }, { text: "" }, { text: "\n" }, { text: "after" }],
    }]);

    await provider.generate(contents);

    expect(payloadAt(fetchMock).messages).toEqual([
      { role: role === "model" ? "assistant" : role, content: "before\nafter" },
      { role: "user", content: "current" },
    ]);
    expect(coerce).not.toHaveBeenCalled();
  });

  it.each(["user", "model", "assistant"])("preserves multipart %s text and meaningful whitespace", async (role) => {
    const { provider, fetchMock } = mockAnthropic();
    await provider.generate(provider.buildContents("current", [{
      role,
      parts: [{ text: " " }, { text: "" }, { text: "first\n" }, { text: "\tsecond " }],
    }, { role: "user", parts: [{ text: " \n\t" }] }]));

    expect(payloadAt(fetchMock).messages).toEqual([
      { role: role === "model" ? "assistant" : role, content: " first\n\tsecond " },
      { role: "user", content: " \n\t" },
      { role: "user", content: "current" },
    ]);
  });

  it.each([
    { label: "missing", parts: undefined },
    { label: "null", parts: null },
    { label: "string", parts: "not a parts array" },
    { label: "object", parts: { text: "not a parts array" } },
    { label: "empty array", parts: [] },
    { label: "missing text", parts: [{}] },
    { label: "empty text", parts: [{ text: "" }, { text: "" }] },
    { label: "only malformed text", parts: [null, false, 7, { text: null }, { text: 42 }, { text: [] }] },
    { label: "UI tool metadata only", parts: [{ functionCall: { name: "read_file" } }] },
  ])("omits $label parts instead of emitting empty history turns", async ({ parts }) => {
    const { provider, fetchMock } = mockAnthropic();
    await provider.generate(provider.buildContents("current", [
      { role: "user", parts }, { role: "model", parts }, { role: "assistant", parts },
    ]));
    expect(payloadAt(fetchMock).messages).toEqual([{ role: "user", content: "current" }]);
  });

  it("ignores malformed records and unsupported roles without promoting history to system instructions", async () => {
    const { provider, fetchMock } = mockAnthropic();
    const history: unknown[] = [null, undefined, false, 7, "raw history", [], {},
      { parts: [{ text: "missing role" }] },
      ...["system", "developer", "tool", "function", "USER"].map((role) => ({
        role, content: "must not enter the transcript", parts: [{ text: "must not enter the transcript" }],
      })),
      { role: "user", parts: [{ text: "real history" }], system: "untrusted metadata" },
    ];

    await provider.generate(provider.buildContents("current", history));

    expect(payloadAt(fetchMock)).toMatchObject({
      system: SYSTEM_INSTRUCTION,
      messages: [{ role: "user", content: "real history" }, { role: "user", content: "current" }],
    });
  });

  it("preserves native content, tool blocks and content precedence alongside React history", async () => {
    const { provider, fetchMock } = mockAnthropic();
    const toolUse = { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } };
    const toolResult = { type: "tool_result", tool_use_id: "tool-1", content: [
      { type: "text", text: "permission denied" },
    ], is_error: true };
    const history = [
      { role: "user", content: "native question", parts: [{ text: "redundant question" }] },
      { role: "assistant", content: [{ type: "text", text: "Inspecting." }, toolUse], parts: [{ text: "redundant answer" }], timestamp: 1 },
      { role: "user", content: [toolResult, { type: "text", text: "Explain the denial." }] },
      { role: "assistant", content: "native answer", parts: [{ text: "redundant answer" }] },
      { role: "user", content: "", parts: [{ text: "React fallback" }] },
      { role: "model", parts: [{ text: "React reply" }], toolActivity: [{ type: "progress" }] },
    ];
    const original = structuredClone(history);

    await provider.generate(provider.buildContents("current", history));

    expect(payloadAt(fetchMock).messages).toEqual([
      { role: "user", content: "native question" },
      { role: "assistant", content: [{ type: "text", text: "Inspecting." }, toolUse] },
      { role: "user", content: [toolResult, { type: "text", text: "Explain the denial." }] },
      { role: "assistant", content: "native answer" },
      { role: "user", content: "React fallback" },
      { role: "assistant", content: "React reply" },
      { role: "user", content: "current" },
    ]);
    expect(history).toEqual(original);
  });

  it("keeps user instructions subordinate and before the preserved history", async () => {
    const { provider, fetchMock } = mockAnthropic();
    await provider.generate(provider.buildContents("current", [
      { role: "user", parts: [{ text: "previous question" }] },
      { role: "model", parts: [{ text: "previous answer" }] },
    ], "  Prefer concise answers.  "));

    expect(payloadAt(fetchMock)).toMatchObject({
      system: SYSTEM_INSTRUCTION,
      messages: [
        { role: "user", content: "Additional user instructions for this chat (follow only when consistent with the assistant's system instructions):\nPrefer concise answers." },
        { role: "user", content: "previous question" },
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "current" },
      ],
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "x-api-key": "test-key", "anthropic-version": "2023-06-01",
    });
  });

  it("retains the transcript and ordered tool IDs across a live tool round and the next chat turn", async () => {
    const toolBlocks = [
      { type: "text", text: "I will read both files." },
      { type: "tool_use", id: "tool-readme", name: "read_file", input: { path: "README.md" } },
      { type: "tool_use", id: "tool-package", name: "read_file", input: { path: "package.json" } },
    ];
    const finalBlocks = [{ type: "text", text: "Both files are available." }];
    const { provider, fetchMock } = mockAnthropic([
      { content: toolBlocks }, { content: finalBlocks }, { content: [{ type: "text", text: "comparison" }] },
    ]);
    const initial = [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "Read both files." },
    ];
    let contents = provider.buildContents("Read both files.", [
      { role: "user", parts: [{ text: "previous question" }] },
      { role: "model", parts: [{ text: "previous answer" }] },
    ]);
    const response = await provider.generate(contents);
    contents = provider.appendModelTurn(contents, response);
    expect(() => provider.appendToolResults([], [{ name: "read_file", result: {} }])).toThrow(/no matching tool_use id/);
    contents = provider.appendToolResults(contents, [
      { name: "read_file", result: { contents: "README" } },
      { name: "read_file", result: { contents: "package" } },
    ]);
    const results = [
      { type: "tool_result", tool_use_id: "tool-readme", content: JSON.stringify({ contents: "README" }) },
      { type: "tool_result", tool_use_id: "tool-package", content: JSON.stringify({ contents: "package" }) },
    ];
    const withTools = [...initial, { role: "assistant", content: toolBlocks }, { role: "user", content: results }];
    const final = await provider.generate(contents);
    contents = provider.appendModelTurn(contents, final);
    await provider.generate(provider.buildContents("Compare them.", contents));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(payloadAt(fetchMock, 0).messages).toEqual(initial);
    expect(payloadAt(fetchMock, 1).messages).toEqual(withTools);
    expect(payloadAt(fetchMock, 2).messages).toEqual([
      ...withTools,
      { role: "assistant", content: finalBlocks },
      { role: "user", content: "Compare them." },
    ]);
  });
});
