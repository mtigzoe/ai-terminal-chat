import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop, MAX_TOOL_ROUNDS, MAX_CONSECUTIVE_IDENTICAL_CALLS, HARD_ABORT_CONSECUTIVE_CALLS, MAX_CONSECUTIVE_ERRORS } from "../src/agent.ts";
import { Provider, ProviderResponse } from "../src/providers/base.ts";
import { clear, createPending, getPending, popPending } from "../src/pending.ts";

class FakeProvider implements Provider {
  name = "fake";
  model = "fake-model";
  displayName = "Fake";
  providerConfig?: { provider: string; model: string };

  private responses: Iterator<ProviderResponse>;
  generateCalls = 0;
  appendedTurns: unknown[] = [];
  appendedResults: unknown[] = [];

  constructor(responses: ProviderResponse[]) {
    this.responses = responses[Symbol.iterator]();
  }

  buildContents(msg: string, history: unknown[]): unknown[] {
    return [{ role: "user" as const, content: msg }];
  }

  generate(_contents: unknown[]): ProviderResponse {
    this.generateCalls++;
    const next = this.responses.next();
    if (next.done) {
      throw new Error("FakeProvider has no more scripted responses");
    }
    return next.value;
  }

  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[] {
    const turn = {
      role: "assistant" as const,
      content: response.text || "",
      tool_calls: response.tool_calls,
    };
    this.appendedTurns.push(turn);
    return [...contents, turn];
  }

  appendToolResults(contents: unknown[], results: { name: string; result: unknown }[]): unknown[] {
    const items = results.map((r) => ({ role: "tool" as const, name: r.name, result: r.result }));
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

describe("runAgentLoop", () => {
  beforeEach(() => {
    clear();
  });

  it("returns final text without tools", async () => {
    const provider = new FakeProvider([{ text: "hello", tool_calls: [], raw: null }]);
    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, createPending: () => ({ action_id: "" }) }));
    expect(events[0]).toMatchObject({ type: "progress", phase: "plan" });
    expect(events[events.length - 1]).toEqual({ type: "final", text: "hello" });
  });

  it("executes a read-only tool and continues", async () => {
    const calls: string[] = [];
    const toolFunctions = {
      fake_read: (args: Record<string, unknown>) => {
        calls.push(String(args.value));
        return { value: args.value };
      },
    };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "fake_read", args: { value: "worked" }, id: undefined }], raw: null },
      { text: "done", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    expect(calls).toEqual(["worked"]);
    const progressEvents = events.filter((e) => e.type === "progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "tool_call" && (e as { name: string }).name === "fake_read")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && (e as { name: string }).name === "fake_read")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "final", text: "done" });
    expect(progressEvents.some((e) => e.phase === "complete")).toBe(true);
  });

  it("executes multi-step tool execution", async () => {
    const order: string[] = [];
    const toolFunctions = {
      list_files: (args: Record<string, unknown>) => {
        order.push(`list ${args.path}`);
        return { path: args.path, entries: [] };
      },
      run_command: (args: Record<string, unknown>) => {
        order.push(`run ${args.command}`);
        return { command: args.command, returncode: 0, stdout: "ok", stderr: "" };
      },
    };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "list_files", args: { path: "." }, id: undefined }], raw: null },
      { text: null, tool_calls: [{ name: "run_command", args: { command: "pytest" }, id: undefined }], raw: null },
      { text: "tests passed", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    expect(order).toEqual(["list .", "run pytest"]);
    const phases = events.filter((e) => e.type === "progress").map((e) => (e as { phase: string }).phase);
    expect(phases).toContain("plan");
    expect(phases).toContain("inspect");
    expect(phases).toContain("execute");
    expect(phases).toContain("complete");
    expect(events[events.length - 1]).toEqual({ type: "final", text: "tests passed" });
  });

  it("stops before any provider call when cancelled before start", async () => {
    const provider = new FakeProvider([{ text: "should not run", tool_calls: [], raw: null }]);
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, cancelSignal: controller.signal, createPending: () => ({ action_id: "" }) }));

    expect(provider.generateCalls).toBe(0);
    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
    expect(events.some((e) => e.type === "progress" && (e as { phase: string }).phase === "cancelled")).toBe(true);
  });

  it("stops between rounds when cancelled mid-loop", async () => {
    const toolFunctions = {
      fake_read: (_args: Record<string, unknown>) => ({ value: "ok" }),
    };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "fake_read", args: {}, id: undefined }], raw: null },
      { text: "should never be reached", tool_calls: [], raw: null },
    ]);

    const controller = new AbortController();
    let cancelled = false;
    const originalAppendToolResults = provider.appendToolResults.bind(provider);
    provider.appendToolResults = (_contents: unknown[], _results: { name: string; result: unknown }[]) => {
      if (!cancelled) {
        cancelled = true;
        controller.abort();
      }
      return originalAppendToolResults(_contents, _results);
    };

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, cancelSignal: controller.signal, createPending: () => ({ action_id: "" }) }));

    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
    expect(events).not.toContainEqual({ type: "final", text: "should never be reached" });
  });

  it("checks cancellation before each tool call", async () => {
    const calls: string[] = [];
    const toolFunctions = {
      fake_read: (args: Record<string, unknown>) => {
        calls.push("first");
        return { value: "first" };
      },
    };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "fake_read", args: {}, id: undefined }, { name: "fake_read", args: {}, id: undefined }], raw: null },
    ]);

    const controller = new AbortController();
    let aborted = false;
    const originalRead = toolFunctions.fake_read;
    toolFunctions.fake_read = (args: Record<string, unknown>) => {
      if (!aborted) {
        aborted = true;
        controller.abort();
      }
      return originalRead(args);
    };

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, cancelSignal: controller.signal, createPending: () => ({ action_id: "" }) }));

    expect(calls).toEqual(["first"]);
    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
  });

  it("never self-confirms write tools", async () => {
    const calls: boolean[] = [];
    const toolFunctions = {
      create_file: (args: Record<string, unknown>) => {
        calls.push(Boolean(args.confirm));
        if (!args.confirm) {
          return { requires_confirmation: true, path: args.path, diff: "+new line" };
        }
        return { created: true, path: args.path, bytes_written: 5 };
      },
    };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "create_file", args: { path: "example.txt", contents: "hello" }, id: undefined }], raw: null },
    ]);

    const createPending = vi.fn(() => ({ action_id: "action-1" }));
    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending }));

    expect(calls).toEqual([false]);
    const pendingEvent = events.find((e) => e.type === "pending_confirmation");
    expect(pendingEvent).toBeDefined();
    const stored = getPending((pendingEvent as { action_id: string }).action_id);
    expect(stored).not.toBeNull();
    if (stored) {
      expect(stored.tool_name).toBe("create_file");
      expect(stored.args).toEqual({ path: "example.txt", contents: "hello" });
    }
    expect((pendingEvent as { preview: { requires_confirmation: boolean } }).preview.requires_confirmation).toBe(true);
    const confirmProgress = events.filter((e) => e.type === "progress" && (e as { phase: string }).phase === "confirm");
    expect(confirmProgress.length).toBeGreaterThan(0);
  });

  it("stores exact requested operation in pending", async () => {
    const toolFunctions = {
      write_file: (args: Record<string, unknown>) => {
        if (!args.confirm) {
          return { requires_confirmation: true, path: args.path, preview: args.contents };
        }
        return { path: args.path, overwritten: true, bytes_written: (args.contents as string).length };
      },
    };

    const requested = { path: "src/main.py", contents: "print(1)\n", confirm: true };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "write_file", args: requested, id: undefined }], raw: null },
    ]);

    const createPending = vi.fn(() => ({ action_id: "action-2" }));
    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending }));

    const pendingEvent = events.find((e) => e.type === "pending_confirmation");
    expect(pendingEvent).toBeDefined();
    const stored = getPending((pendingEvent as { action_id: string }).action_id);
    expect(stored).not.toBeNull();
    if (stored) {
      expect(stored.args.path).toBe("src/main.py");
      expect(stored.args.contents).toBe("print(1)\n");
    }
  });

  it("emits recovery hint after consecutive errors", async () => {
    const toolFunctions = {
      fake_fail: (_args: Record<string, unknown>) => ({ error: "simulated failure" }),
    };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "fake_fail", args: { n: 1 }, id: undefined }, { name: "fake_fail", args: { n: 2 }, id: undefined }, { name: "fake_fail", args: { n: 3 }, id: undefined }], raw: null },
      { text: "stopped after failures", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    const toolResults = events.filter((e) => e.type === "tool_result") as { result: { error?: string; recovery_hint?: string } }[];
    expect(toolResults.length).toBe(3);
    expect(toolResults[0].result.recovery_hint).toBeUndefined();
    expect(toolResults[1].result.recovery_hint).toBeUndefined();
    expect(toolResults[2].result.recovery_hint).toBeDefined();
    expect(events.some((e) => e.type === "progress" && (e as { phase: string }).phase === "recover")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "final", text: "stopped after failures" });
  });

  it("soft blocks repeated identical calls", async () => {
    const toolFunctions = {
      read_file: (_args: Record<string, unknown>) => ({ path: "x", contents: "data" }),
    };

    const n = MAX_CONSECUTIVE_IDENTICAL_CALLS + 1;
    if (MAX_CONSECUTIVE_IDENTICAL_CALLS !== 3) {
      throw new Error(`Expected MAX_CONSECUTIVE_IDENTICAL_CALLS=3, got ${MAX_CONSECUTIVE_IDENTICAL_CALLS}`);
    }
    const calls = Array.from({ length: n }, () => ({ name: "read_file", args: { path: "a.py" }, id: undefined }));
    const provider = new FakeProvider([
      { text: null, tool_calls: calls as { name: string; args: Record<string, unknown>; id: string | undefined }[], raw: null },
      { text: "recovered", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    const toolResults = events.filter((e) => e.type === "tool_result") as { result: { error?: string } }[];
    const errorResults = toolResults.filter((r) => r.result.error);
    expect(errorResults.length).toBeGreaterThan(0);
    expect(errorResults[0].result.error).toContain("already been called");
    expect(events[events.length - 1]).toEqual({ type: "final", text: "recovered" });
  });

  it("normalizes path args for identical-call detection", async () => {
    const calls: string[] = [];
    const toolFunctions = {
      read_file: (args: Record<string, unknown>) => {
        calls.push(String(args.path));
        return { path: args.path, contents: "data" };
      },
    };

    const n = MAX_CONSECUTIVE_IDENTICAL_CALLS + 1;
    const toolCalls: { name: string; args: Record<string, unknown>; id: string | undefined }[] = [];
    for (let i = 0; i < n; i++) {
      toolCalls.push({ name: "read_file", args: { path: i % 2 === 0 ? "./a.py" : "a.py" }, id: undefined });
    }
    const provider = new FakeProvider([
      { text: null, tool_calls: toolCalls, raw: null },
      { text: "done", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    const toolResults = events.filter((e) => e.type === "tool_result") as { result: { error?: string } }[];
    expect(toolResults.some((r) => (r.result.error || "").includes("already been called"))).toBe(true);
  });

  it("reports provider failure", async () => {
    const provider = new FakeProvider([{ text: "should not run", tool_calls: [], raw: null }]);
    provider.generate = () => {
      throw new Error("provider offline");
    };

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, createPending: () => ({ action_id: "" }) }));

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[errors.length - 1] as { message: string }).message).toContain("provider offline");
    expect(events.some((e) => e.type === "progress" && (e as { phase: string }).phase === "error")).toBe(true);
  });

  it("handles unknown tools gracefully", async () => {
    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "does_not_exist", args: { x: 1 }, id: undefined }], raw: null },
      { text: "handled unknown tool", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, createPending: () => ({ action_id: "" }) }));

    const toolResults = events.filter((e) => e.type === "tool_result") as { result: { error?: string } }[];
    expect(toolResults[0].result.error).toContain("Unknown tool");
    expect(events[events.length - 1]).toEqual({ type: "final", text: "handled unknown tool" });
  });

  it("stops after max tool rounds", async () => {
    const toolFunctions = {
      fake_read: (args: Record<string, unknown>) => ({ n: args.n ?? 0 }),
    };

    const responses = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => ({
      text: null,
      tool_calls: [{ name: "fake_read", args: { n: i }, id: `call-${i}` }],
      raw: null,
    }));
    const provider = new FakeProvider(responses);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[errors.length - 1] as { message: string }).message).toContain("maximum number of tool-calling rounds");
    expect(events.some((e) => e.type === "final")).toBe(false);
  });

  it("emits verification hint after successful write result", async () => {
    const toolFunctions = {
      create_file: (args: Record<string, unknown>) => ({
        path: args.path as string,
        created: true,
        bytes_written: (args.contents as string).length,
      }),
    };

    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "create_file", args: { path: "new.txt", contents: "hi" }, id: undefined }], raw: null },
      { text: "verified", tool_calls: [], raw: null },
    ]);

    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions, createPending: () => ({ action_id: "" }) }));

    const verifyEvents = events.filter((e) => e.type === "progress" && (e as { phase: string }).phase === "verify");
    expect(verifyEvents.length).toBeGreaterThan(0);
    const toolResults = events.filter((e) => e.type === "tool_result") as { result: { verification_hint?: string } }[];
    expect(toolResults[0].result.verification_hint).toBeDefined();
  });

  it("emits completion progress", async () => {
    const provider = new FakeProvider([{ text: "all done", tool_calls: [], raw: null }]);
    const events = await collectEvents(runAgentLoop({ provider, contents: [], toolFunctions: {}, createPending: () => ({ action_id: "" }) }));
    expect(events.some((e) => e.type === "progress" && (e as { phase: string }).phase === "complete")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "final", text: "all done" });
  });
});
