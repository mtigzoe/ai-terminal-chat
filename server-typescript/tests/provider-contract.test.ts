import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop } from "../src/agent.ts";
import { Provider, ProviderResponse } from "../src/providers/base.ts";
import { clear, createPending, getPending } from "../src/pending.ts";

class ContractProvider implements Provider {
  name = "contract";
  model = "contract-model";
  displayName = "Contract";
  providerConfig?: { provider: string; model: string };

  generateCalls = 0;
  appendedTurns: unknown[] = [];
  appendedResults: unknown[] = [];

  private responses: Iterator<ProviderResponse>;
  private failWith?: Error;

  constructor(responses: ProviderResponse[], failWith?: Error) {
    this.responses = responses[Symbol.iterator]();
    this.failWith = failWith;
  }

  buildContents(msg: string, history: unknown[]): unknown[] {
    const contents = [{ role: "user" as const, content: msg }];
    for (const item of history) {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const role = record.role as string;
        const parts = record.parts as { text?: string }[] | undefined;
        const text = parts?.map((p) => p.text || "").join("") || "";
        if (role && text) {
          contents.push({ role: role === "model" ? "assistant" : role, content: text });
        }
      }
    }
    return contents;
  }

  generate(_contents: unknown[]): ProviderResponse {
    this.generateCalls++;
    if (this.failWith) {
      throw this.failWith;
    }
    const next = this.responses.next();
    if (next.done) {
      throw new Error("ContractProvider has no more scripted responses");
    }
    return next.value;
  }

  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[] {
    const turn = {
      role: "assistant" as const,
      content: response.text || "",
      tool_calls: response.tool_calls.map((call, index) => ({
        id: call.id || `call-${index}`,
        name: call.name,
        args: { ...call.args },
      })),
    };
    this.appendedTurns.push(turn);
    return [...contents, turn];
  }

  appendToolResults(contents: unknown[], results: { name: string; result: unknown }[]): unknown[] {
    const assistant = contents[contents.length - 1] || {};
    const priorCalls = (assistant as { tool_calls?: { id?: string }[] }).tool_calls || [];
    const items = results.map((r, index) => {
      const callId = index < priorCalls.length ? priorCalls[index].id : `call-${index}`;
      return { role: "tool" as const, tool_call_id: callId, name: r.name, result: r.result };
    });
    this.appendedResults.push(...items);
    return [...contents, ...items];
  }
}

async function collectEvents<T extends { type: string }>(generator: AsyncGenerator<T, void, unknown>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("Provider contract", () => {
  beforeEach(() => {
    clear();
  });

  it("tool call id defaults to none", () => {
    const call = { name: "list_files", args: { path: "." }, id: undefined as string | undefined };
    expect(call.name).toBe("list_files");
    expect(call.args).toEqual({ path: "." });
    expect(call.id).toBeUndefined();
  });

  it("tool call id can be set", () => {
    const call = { name: "read_file", args: { path: "a.py" }, id: "call-abc" };
    expect(call.id).toBe("call-abc");
  });

  it("supports normal text response", async () => {
    const provider = new ContractProvider([{ text: "hello from contract", tool_calls: [], raw: null }]);
    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, createPending: () => ({ action_id: "" }) }));
    expect(provider.generateCalls).toBe(1);
    expect(events[events.length - 1]).toEqual({ type: "final", text: "hello from contract" });
    expect(events.some((e) => e.type === "progress" && (e as { phase: string }).phase === "complete")).toBe(true);
  });

  it("single tool call then final", async () => {
    const toolFunctions = {
      read_file: (args: Record<string, unknown>) => ({ path: args.path, contents: "data" }),
    };

    const provider = new ContractProvider([
      { text: null, tool_calls: [{ name: "read_file", args: { path: "app.py" }, id: "call-1" }], raw: null },
      { text: "file inspected", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    expect(events.some((e) => e.type === "tool_call" && (e as { name: string }).name === "read_file")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && (e as { name: string }).name === "read_file")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "final", text: "file inspected" });
    expect(provider.appendedTurns[0].tool_calls[0].id).toBe("call-1");
    expect(provider.appendedResults[0].tool_call_id).toBe("call-1");
  });

  it("multiple tool calls in one turn", async () => {
    const toolFunctions = {
      list_files: (args: Record<string, unknown>) => ({ path: args.path, entries: [] }),
      search_files: (args: Record<string, unknown>) => ({ query: args.query, matches: [] }),
    };

    const provider = new ContractProvider([
      { text: null, tool_calls: [{ name: "list_files", args: { path: "." }, id: "call-a" }, { name: "search_files", args: { query: "Provider" }, id: "call-b" }], raw: null },
      { text: "done", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    const toolCalls = events.filter((e) => e.type === "tool_call") as { name: string }[];
    expect(toolCalls.map((c) => c.name)).toEqual(["list_files", "search_files"]);
    expect(provider.appendedResults.map((r) => (r as { tool_call_id: string }).tool_call_id)).toEqual(["call-a", "call-b"]);
    expect(events[events.length - 1]).toEqual({ type: "final", text: "done" });
  });

  it("tool result round-trip preserves order", async () => {
    const toolFunctions = {
      list_files: (args: Record<string, unknown>) => ({ path: args.path }),
      read_file: (args: Record<string, unknown>) => ({ path: args.path, contents: "" }),
    };

    const provider = new ContractProvider([
      { text: null, tool_calls: [{ name: "list_files", args: { path: "src" }, id: "id-1" }, { name: "read_file", args: { path: "src/a.py" }, id: "id-2" }], raw: null },
      { text: "ok", tool_calls: [], raw: null },
    ]);

    await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    expect(provider.appendedResults.map((r) => (r as { name: string }).name)).toEqual(["list_files", "read_file"]);
    expect(provider.appendedResults.map((r) => (r as { tool_call_id: string }).tool_call_id)).toEqual(["id-1", "id-2"]);
  });

  it("tool call without id still round-trips", async () => {
    const toolFunctions = {
      list_files: (args: Record<string, unknown>) => ({ ok: true }),
    };

    const provider = new ContractProvider([
      { text: null, tool_calls: [{ name: "list_files", args: { path: "." }, id: undefined }], raw: null },
      { text: "ok", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    expect(events[events.length - 1].type).toBe("final");
    expect(provider.appendedTurns[0].tool_calls[0].id).toBe("call-0");
    expect(provider.appendedResults[0].tool_call_id).toBe("call-0");
  });

  it("final response after tool execution", async () => {
    const toolFunctions = {
      git_status: () => ({ clean: true }),
    };

    const provider = new ContractProvider([
      { text: null, tool_calls: [{ name: "git_status", args: {}, id: "gs-1" }], raw: null },
      { text: "Working tree clean.", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    const finals = events.filter((e) => e.type === "final") as { text: string }[];
    expect(finals).toEqual([{ type: "final", text: "Working tree clean." }]);
    expect(provider.generateCalls).toBe(2);
  });

  it("provider error handling", async () => {
    const provider = new ContractProvider([], new Error("upstream down"));
    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, createPending: () => ({ action_id: "" }) }));

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as { message: string }).message).toContain("upstream down");
    expect(events.some((e) => e.type === "final")).toBe(false);
  });

  it("cancellation before generate", async () => {
    const provider = new ContractProvider([{ text: "should not run", tool_calls: [], raw: null }]);
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, cancelSignal: controller.signal, createPending: () => ({ action_id: "" }) }));

    expect(provider.generateCalls).toBe(0);
    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
  });

  it("cancellation between tool calls", async () => {
    const calls: string[] = [];
    const toolFunctions = {
      fake_read: (args: Record<string, unknown>) => {
        calls.push(args.value as string);
        return { value: args.value };
      },
    };

    const cancel = new AbortController();
    const provider = new ContractProvider([
      { text: null, tool_calls: [{ name: "fake_read", args: { value: "one" }, id: "c1" }, { name: "fake_read", args: { value: "two" }, id: "c2" }], raw: null },
    ]);

    let aborted = false;
    const originalRead = toolFunctions.fake_read;
    toolFunctions.fake_read = (args: Record<string, unknown>) => {
      if (!aborted) {
        aborted = true;
        cancel.abort();
      }
      return originalRead(args);
    };

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, cancelSignal: cancel.signal, createPending: () => ({ action_id: "" }) }));

    expect(calls).toEqual(["one"]);
    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
  });

  it("confirmation required tool flow", async () => {
    const confirms: boolean[] = [];
    const toolFunctions = {
      create_file: (args: Record<string, unknown>) => {
        confirms.push(Boolean(args.confirm));
        if (!args.confirm) {
          return { requires_confirmation: true, path: args.path as string, preview: args.contents };
        }
        return { path: args.path as string, created: true, bytes_written: (args.contents as string).length };
      },
    };

    const provider = new ContractProvider([
      { text: null, tool_calls: [{ name: "create_file", args: { path: "out.txt", contents: "hi" }, id: "w1" }], raw: null },
    ]);

    const createPending = vi.fn(() => ({ action_id: "action-1" }));
    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending }));

    const pendingEvents = events.filter((e) => e.type === "pending_confirmation");
    expect(pendingEvents.length).toBe(1);
    const actionId = (pendingEvents[0] as { action_id: string }).action_id;
    const stored = getPending(actionId);
    expect(stored).not.toBeNull();
    if (stored) {
      expect(stored.tool_name).toBe("create_file");
      expect(stored.args.path).toBe("out.txt");
    }
    expect(confirms).toEqual([false]);
    expect(events.some((e) => e.type === "final")).toBe(false);
  });

  it("build_contents accepts frontend history shape", () => {
    const provider = new ContractProvider([]);
    const contents = provider.buildContents("follow up", [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi" }] },
    ]);
    expect(contents[0]).toEqual({ role: "user", content: "follow up" });
    expect(contents.some((item) => (item as { content?: string }).content === "hello")).toBe(true);
    expect(contents.some((item) => (item as { content?: string }).content === "hi")).toBe(true);
  });
});
