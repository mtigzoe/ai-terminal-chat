import { describe, it, expect, beforeEach } from "vitest";
import { clear, cancel, register, release } from "../src/cancellation.ts";

describe("cancellation", () => {
  beforeEach(() => {
    clear();
  });
});
  it("register returns a fresh unset signal", () => {
    const signal = register("req-1");
    expect(signal.aborted).toBe(false);
  });

  it("cancel sets the registered signal", () => {
    const signal = register("req-1");
    const result = cancel("req-1");
    expect(result).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("cancel unknown request id returns false", () => {
    expect(cancel("never-registered")).toBe(false);
  });

  it("release stops tracking a request", () => {
    register("req-1");
    release("req-1");
    expect(cancel("req-1")).toBe(false);
  });

  it("release is safe for unknown or empty id", () => {
    expect(() => release("never-registered")).not.toThrow();
    expect(() => release("")).not.toThrow();
    expect(() => release(undefined as unknown as string)).not.toThrow();
  });

  it("rejects duplicate request IDs instead of replacing the active request", () => {
    const first = register("req-1");

    expect(() => register("req-1")).toThrow(
      "Request ID is already in use: req-1"
    );

    expect(first.aborted).toBe(false);
    expect(cancel("req-1")).toBe(true);
    expect(first.aborted).toBe(true);
  });

  it("does not release a newer registration that reused an evicted request ID", () => {
    const firstSignals: AbortSignal[] = [];
    for (let i = 0; i < 200; i += 1) firstSignals.push(register(`req-${i}`));
    const first = firstSignals[0];

    // Registering the 201st request evicts and aborts req-0.
    register("req-200");
    expect(first.aborted).toBe(true);

    // The evicted request ID may now be reused by a new request.
    const newer = register("req-0");

    // Cleanup from the old request must not delete the newer registration.
    release("req-0", first);
    expect(cancel("req-0")).toBe(true);
    expect(newer.aborted).toBe(true);
  });
});
