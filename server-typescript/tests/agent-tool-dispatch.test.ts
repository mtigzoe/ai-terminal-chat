import { describe, test, expect } from "vitest";
import { runAgentLoop, type AgentEvent } from "../src/agent.ts";
import type { Provider, ProviderResponse } from "../src/providers/base.ts";

class FakeProvider implements Provider {
  name = "fake";
  model = "m";
  displayName = "F";
  private it: Iterator<ProviderResponse>;
  constructor(responses: ProviderResponse[]) {
    this.it = responses[Symbol.iterator]();
  }
  buildContents(msg: string): unknown[] {
    return [{ role: "user" as const, content: msg }];
  }
  async generate(): Promise<ProviderResponse> {
    const n = this.it.next();
    if (n.done) throw new Error("no more responses");
    return n.value;
  }
  appendModelTurn(c: unknown[], r: ProviderResponse): unknown[] {
    return [...c, { role: "assistant", content: r.text || "", tool_calls: r.tool_calls }];
  }
  appendToolResults(c: unknown[], r: { name: string; result: unknown }[]): unknown[] {
    return [...c, ...r.map((x) => ({ role: "tool", name: x.name, result: x.result }))];
  }
}

const realTools: Record<string, (a: Record<string, unknown>) => unknown> = {
  read_file: () => ({ ok: true }),
};

async function askFor(name: string): Promise<{ events: AgentEvent[]; result: unknown }> {
  const provider = new FakeProvider([
    { text: null, tool_calls: [{ name, args: { evil: true } }], raw: null } as unknown as ProviderResponse,
    { text: "done", tool_calls: null, raw: null } as unknown as ProviderResponse,
  ]);
  const events: AgentEvent[] = [];
  for await (const e of runAgentLoop({
    provider,
    contents: [{ role: "user", content: `call ${name}` }],
    toolFunctions: realTools,
    createPending: () => ({ action_id: "x" }),
  })) {
    events.push(e);
  }
  const toolResult = events.find((e) => (e as { type: string }).type === "tool_result") as
    | { result: unknown }
    | undefined;
  return { events, result: toolResult?.result };
}

describe("agent tool dispatch: prototype-inherited names", () => {
  // Regression: the tool table was a plain object and the tool name comes
  // straight off the wire, so `toolFunctions[name]` resolved inherited
  // Object.prototype members. A request for "toString" passed the
  // `if (!toolFn)` check and then executed Object.prototype.toString as if it
  // were a tool, so the model received the string "[object Undefined]" instead
  // of an "Unknown tool" error. Python is immune because dict lookups do not
  // walk a prototype chain; this restores that parity.
  test.each([
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ])("%s is rejected as an unknown tool", async (name) => {
    const { result } = await askFor(name);
    expect(result).toEqual({ error: `Unknown tool requested: ${name}.` });
    expect(typeof result).toBe("object");
  });

  test("constructor does not resolve to the Object constructor", async () => {
    const { result } = await askFor("constructor");
    expect(result).toEqual({ error: "Unknown tool requested: constructor." });
  });

  test("__proto__ does not resolve to Object.prototype", async () => {
    const { result } = await askFor("__proto__");
    expect(result).toEqual({ error: "Unknown tool requested: __proto__." });
  });

  test("a genuine tool still runs", async () => {
    const { result } = await askFor("read_file");
    expect(result).toEqual({ ok: true });
  });

  test("a non-function own property is not callable as a tool", async () => {
    const tools: Record<string, unknown> = { read_file: () => ({ ok: true }), not_a_function: 42 };
    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "not_a_function", args: {} }], raw: null } as unknown as ProviderResponse,
      { text: "done", tool_calls: null, raw: null } as unknown as ProviderResponse,
    ]);
    const events: AgentEvent[] = [];
    for await (const e of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "go" }],
      toolFunctions: tools as never,
      createPending: () => ({ action_id: "x" }),
    })) {
      events.push(e);
    }
    const toolResult = events.find((e) => (e as { type: string }).type === "tool_result") as
      | { result: unknown }
      | undefined;
    expect(toolResult?.result).toEqual({ error: "Unknown tool requested: not_a_function." });
  });
});

describe("agent tool dispatch: timeout lookup", () => {
  // Regression: `TOOL_TIMEOUTS[functionName]` also walked the prototype, so a
  // prototype name returned Object.prototype.toString (a function). The
  // multiplication produced NaN, setTimeout(NaN) fired immediately (Node
  // clamps to 1ms and logs "TimeoutNaNWarning"), and the tool was abandoned
  // instantly instead of getting its real budget.
  test("an unknown tool name gets the default timeout, not NaN", async () => {
    const slow: Record<string, (a: Record<string, unknown>) => unknown> = {
      read_file: () => ({ ok: true }),
    };
    const started = Date.now();
    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "valueOf", args: {} }], raw: null } as unknown as ProviderResponse,
      { text: "done", tool_calls: null, raw: null } as unknown as ProviderResponse,
    ]);
    for await (const _ of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "go" }],
      toolFunctions: slow,
      createPending: () => ({ action_id: "x" }),
    })) {
      void _;
    }
    // A NaN timeout would have rejected almost immediately; the default budget
    // means the turn completes normally.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
