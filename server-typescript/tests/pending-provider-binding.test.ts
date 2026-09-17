import { beforeEach, describe, expect, it, vi } from "vitest";

const loadProviderSelection = vi.fn();
const getProvider = vi.fn();

vi.mock("../src/security.ts", () => ({
  loadProviderSelection,
}));

vi.mock("../src/providers/factory.ts", () => ({
  getProvider,
}));

import {
  clear,
  createPending,
  popPending,
  type ResumeState,
} from "../src/pending.ts";

const resume: ResumeState = {
  provider_fingerprint: "gemini:gemini-2.5-pro",
  contents: [],
  round_index: 1,
  tool_results: [],
  remaining_calls: [],
  last_call_signature: null,
  consecutive_repeat_count: 0,
  consecutive_error_count: 0,
};

describe("pending provider binding", () => {
  beforeEach(() => {
    clear();
    vi.clearAllMocks();
    loadProviderSelection.mockReturnValue({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    getProvider.mockReturnValue({
      name: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  it("does not consume a resumable action after the provider changes", () => {
    const action = createPending(
      "write_file",
      { path: "example.txt", contents: "new" },
      { requires_confirmation: true },
      resume,
    );

    loadProviderSelection.mockReturnValue({
      provider: "openai",
      model: "gpt-5",
    });
    getProvider.mockReturnValue({ name: "openai", model: "gpt-5" });

    expect(popPending(action.action_id)).toBeUndefined();

    // The stale action remains available only as an invalidated pending entry;
    // changing back to its original provider/model permits the normal resume
    // path to consume it.
    loadProviderSelection.mockReturnValue({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    getProvider.mockReturnValue({
      name: "gemini",
      model: "gemini-2.5-pro",
    });

    expect(popPending(action.action_id)?.action_id).toBe(action.action_id);
  });
});
