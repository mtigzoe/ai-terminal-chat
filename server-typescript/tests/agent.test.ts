import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop, resumeAgentLoop, MAX_TOOL_ROUNDS, MAX_CONSECUTIVE_IDENTICAL_CALLS, HARD_ABORT_CONSECUTIVE_CALLS, MAX_CONSECUTIVE_ERRORS } from "../src/agent.ts";
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

  it("reports a tool timeout even when the tool resolves from abort", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider([
        {
          text: null,
          tool_calls: [{ name: "fake_wait", args: {}, id: undefined }],
          raw: null,
        },
        { text: "after timeout", tool_calls: [], raw: null },
      ]);

      const toolFunctions = {
        fake_wait: (
          _args: Record<string, unknown>,
          signal?: AbortSignal,
        ) =>
          new Promise<Record<string, unknown>>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => resolve({ error: "aborted" }),
              { once: true },
            );
          }),
      };

      const eventsPromise = collectEvents(
        runAgentLoop({
          provider,
          contents: [],
          toolFunctions,
          createPending: () => ({ action_id: "" }),
        }),
      );

      await vi.advanceTimersByTimeAsync(15_000);
      const events = await eventsPromise;
      const toolResult = events.find((event) => event.type === "tool_result") as
        | { type: "tool_result"; result: { error?: string } }
        | undefined;

      expect(toolResult?.result.error).toContain(
        "exceeded its 15s execution limit",
      );
      expect(events.some((event) => event.type === "final")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates cancellation into an in-flight tool", async () => {
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const provider = new FakeProvider([
      {
        text: null,
        tool_calls: [{ name: "fake_wait", args: {}, id: undefined }],
        raw: null,
      },
    ]);

    const toolFunctions = {
      fake_wait: (
        _args: Record<string, unknown>,
        signal?: AbortSignal,
      ) =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveStarted();
          signal?.addEventListener(
            "abort",
            () => resolve({ error: "aborted" }),
            { once: true },
          );
        }),
    };

    const eventsPromise = collectEvents(
      runAgentLoop({
        provider,
        contents: [],
        toolFunctions,
        cancelSignal: controller.signal,
        createPending: () => ({ action_id: "" }),
      }),
    );

    await started;
    controller.abort();

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "cancelled")).toBe(true);
    expect(events.some((event) => event.type === "final")).toBe(false);
  });

  it("does not execute a resumed tool when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const provider = new FakeProvider([]);
    const action = {
      action_id: "action-already-cancelled",
      tool_name: "fake_write",
      args: {},
      preview: {},
      resume: {
        provider_fingerprint: "fake:fake-model",
        contents: [],
        round_index: 0,
        tool_results: [],
        remaining_calls: [{ name: "fake_write", args: {}, id: undefined }],
        last_call_signature: null,
        consecutive_repeat_count: 0,
        consecutive_error_count: 0,
      },
    };

    const events = await collectEvents(
      resumeAgentLoop({
        provider,
        action,
        confirmed: true,
        toolFunctions: {
          fake_write: () => {
            called = true;
            return { written: true };
          },
        },
        cancelSignal: controller.signal,
        createPending: () => ({ action_id: "" }),
      }),
    );

    expect(called).toBe(false);
    expect(events.some((event) => event.type === "tool_result")).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
  });

  it("propagates cancellation into a resumed confirmed tool", async () => {
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const toolFunctions = {
      fake_write: (
        _args: Record<string, unknown>,
        signal?: AbortSignal,
      ) =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveStarted();
          signal?.addEventListener(
            "abort",
            () => resolve({ error: "aborted" }),
            { once: true },
          );
        }),
    };

    const provider = new FakeProvider([]);
    const action = {
      action_id: "action-resume-cancel",
      tool_name: "fake_write",
      args: {},
      preview: {},
      resume: {
        provider_fingerprint: "fake:fake-model",
        contents: [],
        round_index: 0,
        tool_results: [],
        remaining_calls: [{ name: "fake_write", args: {}, id: undefined }],
        last_call_signature: null,
        consecutive_repeat_count: 0,
        consecutive_error_count: 0,
      },
    };

    const eventsPromise = collectEvents(
      resumeAgentLoop({
        provider,
        action,
        confirmed: true,
        toolFunctions,
        cancelSignal: controller.signal,
        createPending: () => ({ action_id: "" }),
      }),
    );

    await started;
    controller.abort();

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "cancelled")).toBe(true);
  });

  it("propagates cancellation into an in-flight provider request", async () => {
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const provider = new FakeProvider([]);
    provider.generate = vi.fn(
      (_contents: unknown[], signal?: AbortSignal) =>
        new Promise<ProviderResponse>((_resolve, reject) => {
          resolveStarted();
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })),
            { once: true },
          );
        }),
    );

    const eventsPromise = collectEvents(
      runAgentLoop({
        provider,
        contents: [],
        toolFunctions: {},
        cancelSignal: controller.signal,
        createPending: () => ({ action_id: "" }),
      }),
    );

    await started;
    controller.abort();

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "cancelled")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
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

  it("ignores a provider response that arrives after cancellation", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider([]);
    provider.generate = vi.fn(
      async () => {
        controller.abort();
        return { text: "late response", tool_calls: [], raw: null };
      },
    );

    const events = await collectEvents(
      runAgentLoop({
        provider,
        contents: [],
        toolFunctions: {},
        cancelSignal: controller.signal,
        createPending: () => ({ action_id: "" }),
      }),
    );

    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
    expect(events.some((event) => event.type === "final")).toBe(false);
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

  it("does not create a pending write action after cancellation during preview", async () => {
    const controller = new AbortController();
    const createPending = vi.fn(() => ({ action_id: "should-not-exist" }));

    const toolFunctions = {
      create_file: (_args: Record<string, unknown>, _signal?: AbortSignal) => {
        controller.abort();
        return {
          requires_confirmation: true,
          path: "example.txt",
          diff: "+new line",
        };
      },
    };

    const provider = new FakeProvider([
      {
        text: null,
        tool_calls: [
          { name: "create_file", args: { path: "example.txt", contents: "hello" }, id: undefined },
        ],
        raw: null,
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        provider,
        contents: [],
        toolFunctions,
        cancelSignal: controller.signal,
        createPending,
      }),
    );

    expect(createPending).not.toHaveBeenCalled();
    expect(events[events.length - 1]).toEqual({ type: "cancelled" });
    expect(events.some((event) => event.type === "pending_confirmation")).toBe(false);
  });

  it("never self-confirms write tools", async () => {
    const calls: boolean[] = [];
    const toolFunctions = {
      create_file: (args: Record<string, unknown>) => {
        calls.push(Boolean(args.confirm));