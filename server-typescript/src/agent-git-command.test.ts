import { describe, expect, test, vi } from "vitest";
import { Provider, ProviderResponse } from "./providers/base.ts";
import { runAgentLoop } from "./agent.ts";

class FakeProvider extends Provider {
  buildContents(msg: string, _history: unknown[]): unknown[] {
    return [{ role: "user", content: msg }];
  }

  async generate(_contents: unknown[]): Promise<ProviderResponse> {
    throw new Error("provider.generate() should not be called for explicit Git commands");
  }

  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[] {
    return [...contents, { role: "assistant", response }];
  }

  appendToolResults(
    contents: unknown[],
    results: { name: string; result: unknown }[]
  ): unknown[] {
    return [...contents, { role: "tool", results }];
  }
}

describe("explicit Git command routing", () => {
  test("routes git add directly to git_add without calling the model", async () => {
    const provider = new FakeProvider();
    const gitAdd = vi.fn(() => ({
      requires_confirmation: true,
      path: "hellov4.txt",
    }));
    const createPending = vi.fn(() => ({ action_id: "action-1" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git add hellov4.txt" }],
      toolFunctions: { git_add: gitAdd },
      createPending,
    })) {
      events.push(event);
    }

    expect(gitAdd).toHaveBeenCalledWith({
      path: "hellov4.txt",
      confirm: false,
    });
    expect(createPending).toHaveBeenCalledWith(
      "git_add",
      { path: "hellov4.txt" },
      { requires_confirmation: true, path: "hellov4.txt" }
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pending_confirmation",
        name: "git_add",
        args: { path: "hellov4.txt" },
      })
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("routes git status directly to git_status", async () => {
    const provider = new FakeProvider();
    const gitStatus = vi.fn(() => ({ branch: "main", clean: true }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git status" }],
      toolFunctions: { git_status: gitStatus },
      createPending: () => ({ action_id: "unused" }),
    })) {
      events.push(event);
    }

    expect(gitStatus).toHaveBeenCalledWith({});
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });
});
