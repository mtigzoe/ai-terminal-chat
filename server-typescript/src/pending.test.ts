import { afterEach, describe, expect, it } from "vitest";
import {
  clear,
  createPending,
  popPending,
} from "./pending.ts";
import {
  __resetProjectRootForTests,
  __setProjectRootForTests,
} from "./security.ts";

describe("pending action project-root binding", () => {
  afterEach(() => {
    clear();
    __resetProjectRootForTests();
  });

  it("captures the current project root and refuses confirmation after a project switch", () => {
    const projectA = "/tmp/ai-terminal-chat-project-a";
    const projectB = "/tmp/ai-terminal-chat-project-b";
    __setProjectRootForTests(projectA);

    const action = createPending(
      "write_file",
      { path: "src/example.ts" },
      { requires_confirmation: true },
      {
        provider_fingerprint: "test:model",
        contents: [],
        round_index: 0,
        tool_results: [],
        remaining_calls: [
          { name: "write_file", args: { path: "src/example.ts" } },
        ],
        last_call_signature: null,
        consecutive_repeat_count: 1,
        consecutive_error_count: 0,
      },
    );

    expect(action.resume?.project_root).toBe(projectA);

    __setProjectRootForTests(projectB);
    expect(popPending(action.action_id)).toBeUndefined();

    __setProjectRootForTests(projectA);
    expect(popPending(action.action_id)?.action_id).toBe(action.action_id);
  });
});
