import { afterEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  entered: undefined as Promise<void> | undefined,
  markEntered: undefined as (() => void) | undefined,
  open: undefined as (() => void) | undefined,
  opened: undefined as Promise<void> | undefined,
  abortSeen: false,
}));

vi.mock("../src/providers/factory.ts", async () => {
  const { Provider } = await import("../src/providers/base.ts");

  class GatedProvider extends Provider {
    name = "gated";
    model = "gated-model";

    buildContents(msg: string, history: unknown[]): unknown[] {
      return [...history, { role: "user", content: msg }];
    }

    async generate(_contents: unknown[], cancelSignal?: AbortSignal) {
      gate.markEntered?.();
      await gate.opened;
      gate.abortSeen = cancelSignal?.aborted ?? false;
      return { text: "late answer", tool_calls: [], raw: null };
    }

    appendModelTurn(contents: unknown[]): unknown[] {
      return contents;
    }

    appendToolResults(contents: unknown[]): unknown[] {
      return contents;
    }
  }

  return {
    getProvider: vi.fn(() => new GatedProvider()),
    buildProviderStatus: vi.fn(),
  };
});

import { app } from "../src/routes.ts";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

describe("POST /stream client disconnect", () => {
  it("does not raise an unhandled rejection when the client cancels mid-stream", async () => {
    process.on("unhandledRejection", onUnhandled);
    gate.entered = new Promise<void>((resolve) => (gate.markEntered = resolve));
    gate.opened = new Promise<void>((resolve) => (gate.open = resolve));
    gate.abortSeen = false;

    const res = await app.request("http://localhost/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "tell me something", request_id: "stream-disc-1" }),
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read(); // first progress line
    await gate.entered; // provider call is now in flight

    await reader.cancel(); // client disconnects
    gate.open!(); // provider answers after the disconnect

    // Give the producer time to finish and hit close()/enqueue().
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(unhandled).toEqual([]);
  });

  it("aborts the agent loop when the stream is cancelled", async () => {
    gate.entered = new Promise<void>((resolve) => (gate.markEntered = resolve));
    gate.opened = new Promise<void>((resolve) => (gate.open = resolve));
    gate.abortSeen = false;

    const res = await app.request("http://localhost/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "tell me something", request_id: "stream-disc-2" }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    await gate.entered;

    await reader.cancel();
    gate.open!();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(gate.abortSeen).toBe(true);
  });
});
