import { afterEach, describe, expect, it } from "vitest";
import { clear, register } from "./cancellation.ts";

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
});
