import { describe, it, expect, vi, afterEach } from "vitest";
import { runAgentLoop } from "../src/agent.ts";
import { Provider, ProviderResponse } from "../src/providers/base.ts";

class TimeoutProvider implements Provider {
  name = "timeout-test";
  model = "timeout-test";
  displayName = "Timeout Test";
  providerConfig?: { provider: string; model: string };

  private responses: Iterator<ProviderResponse>;

  constructor(responses: ProviderResponse[]) {
    this.responses = responses[Symbol.iterator]();
  }

  buildContents(msg: string, _history: unknown[]): unknown[] {
    return [{ role: "user", content: msg }];
  }

  generate(_contents: unknown[]): ProviderResponse {
    const next = this.responses.next();
    if (next.done) {
      throw new Error("No more scripted responses");
    }
    return next.value;
  }

  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[] {
    return [...contents, { role: "assistant", content: response.text || "", tool_calls: response.tool_calls }];
  }

  appendToolResults(contents: unknown[], results: { name: string; result: unknown }[]): unknown[] {
    return [...contents, ...results.map((result) => ({ role: "tool", ...result }))];
  }
}

describe("agent tool timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a hung tool into a tool error instead of hanging the agent loop", async () => {
    vi.useFakeTimers();

    const hungTool = () => new Promise<never>(() => undefined);
    const provider = new TimeoutProvider([
      {
        text: null,
        tool_calls: [{ name: "git_status", args: {}, id: "timeout-1" }],
        raw: null,
      },
      {
        text: "timeout recovered",
        tool_calls: [],
        raw: null,
      },
    ]);

    const generator = runAgentLoop({
      provider,
      contents: [],
      toolFunctions: { git_status: hungTool },
      createPending: () => ({ action_id: "" }),
    });

    // Advance through the events emitted before executeTool() awaits the
    // hanging function. The fourth next() is the one blocked on the tool.
    const planning = await generator.next();
    expect(planning.value).toMatchObject({ type: "progress", phase: "plan" });

    const inspect = await generator.next();
    expect(inspect.value).toMatchObject({
      type: "progress",
      phase: "inspect",
      tool: "git_status",
    });

    const toolCall = await generator.next();
    expect(toolCall.value).toEqual({
      type: "tool_call",
      name: "git_status",
      args: {},
    });

    const blockedResult = generator.next();
    await vi.advanceTimersByTimeAsync(10_000);
    const toolResult = await blockedResult;

    expect(toolResult.value).toMatchObject({
      type: "tool_result",
      name: "git_status",
      result: {
        error: expect.stringContaining("exceeded its 10s execution limit"),
      },
    });

    const nextPlan = await generator.next();
    expect(nextPlan.value).toMatchObject({ type: "progress", phase: "plan" });

    const complete = await generator.next();
    expect(complete.value).toMatchObject({
      type: "progress",
      phase: "complete",
      message: "Task completed",
      round: 2,
      max_rounds: 10,
    });

    const final = await generator.next();
    expect(final.value).toEqual({ type: "final", text: "timeout recovered" });

    const done = await generator.next();
    expect(done.done).toBe(true);
  });
});
