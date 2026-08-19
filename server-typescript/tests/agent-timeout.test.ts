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

async function collectEvents<T extends { type: string }>(generator: AsyncGenerator<T, void, unknown>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
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

    // Consume the initial planning event, then start the round containing
    // the hanging tool. The second next() remains pending until the tool
    // timeout fires.
    await generator.next();
    const pendingRound = generator.next();

    await vi.advanceTimersByTimeAsync(10_000);
    const firstResult = await pendingRound;

    expect(firstResult.value).toMatchObject({
      type: "progress",
      phase: "inspect",
      tool: "git_status",
    });

    const events = [firstResult.value, ...(await collectEvents(generator))];
    const timeoutResult = events.find(
      (event) => event.type === "tool_result" && event.name === "git_status"
    );

    expect(timeoutResult).toBeDefined();
    expect(timeoutResult).toMatchObject({
      type: "tool_result",
      name: "git_status",
      result: {
        error: expect.stringContaining("exceeded its 10s execution limit"),
      },
    });
    expect(events[events.length - 1]).toEqual({ type: "final", text: "timeout recovered" });
  });
});
