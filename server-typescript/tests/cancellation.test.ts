import { describe, it, expect, beforeEach } from "vitest";
import { clear, cancel, register, release } from "../src/cancellation.ts";

describe("cancellation", () => {
  beforeEach(() => {
    clear();
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
});
