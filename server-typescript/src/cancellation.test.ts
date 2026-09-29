import { afterEach, describe, expect, it } from "vitest";
import {
  bindRequestCancellation,
  cancel,
  clear,
  register,
  release,
} from "./cancellation.ts";

describe("cancellation request tracking", () => {
  afterEach(() => {
    clear();
  });

  it("aborts the oldest active request when the tracking limit is reached", () => {
    const signals: AbortSignal[] = [];
    for (let index = 0; index < 200; index += 1) {
      signals.push(register(`request-${index}`));
    }

    expect(signals[0]?.aborted).toBe(false);
    expect(signals[199]?.aborted).toBe(false);

    register("request-200");

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[199]?.aborted).toBe(false);
  });

  it("aborts tracked requests when clearing the registry", () => {
    const first = register("first");
    const second = register("second");

    clear();

    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
  });

  it("honors a cancel that arrives before the request registers", () => {
    expect(cancel("early")).toBe(true);

    const signal = register("early");

    expect(signal.aborted).toBe(true);
  });

  it("does not release a newer request that reused an evicted request id", () => {
    const evicted = register("shared");
    for (let index = 0; index < 200; index += 1) register(`filler-${index}`);
    const reused = register("shared");

    release("shared", evicted);

    expect(cancel("shared")).toBe(true);
    expect(reused.aborted).toBe(true);
  });

  it("ignores an aborted request signal whose registry entry was evicted", () => {
    const requestController = new AbortController();
    const evicted = register("reused");
    bindRequestCancellation(requestController.signal, "reused", evicted);

    for (let index = 0; index < 200; index += 1) register(`evict-${index}`);
    const reused = register("reused");

    requestController.abort();

    expect(reused.aborted).toBe(false);
  });
});
