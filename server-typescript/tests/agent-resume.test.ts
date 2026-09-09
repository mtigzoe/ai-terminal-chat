import { describe, it, expect, beforeEach } from "vitest";
import { runAgentLoop, resumeAgentLoop, type AgentEvent, type PendingConfirmationEvent } from "../src/agent.ts";
import { Provider, ProviderResponse } from "../src/providers/base.ts";
import { clear, createPending, getPending, type PendingAction, type ResumeState } from "../src/pending.ts";

class FakeProvider implements Provider {
  name = "fake";
  model = "fake-model";
  displayName = "Fake";
  providerConfig?: { provider: string; model: string };

  private responses: Iterator<ProviderResponse>;
  generateCalls = 0;

  constructor(responses: ProviderResponse[]) {
    this.responses = responses[Symbol.iterator]();
  }

  buildContents(msg: string): unknown[] {
    return [{ role: "user" as const, content: msg }];
  }

  async generate(_contents: unknown[]): Promise<ProviderResponse> {
    this.generateCalls++;
    const next = this.responses.next();
    if (next.done) {
      throw new Error("FakeProvider has no more scripted responses");
    }
    return next.value;
  }

  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[] {
    return [...contents, { role: "assistant" as const, content: response.text || "", tool_calls: response.tool_calls }];
  }

  appendToolResults(contents: unknown[], results: { name: string; result: unknown }[]): unknown[] {
    return [...contents, ...results.map((r) => ({ role: "tool" as const, name: r.name, result: r.result }))];
  }
}

async function collectEvents(generator: AsyncGenerator<AgentEvent, void, unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function realCreatePending(
  toolName: string,
  args: Record<string, unknown>,
  preview: Record<string, unknown>,
  resume?: ResumeState
) {
  const action = createPending(toolName, args, preview, resume);
  return { action_id: action.action_id };
}

describe("resumeAgentLoop", () => {
  beforeEach(() => {
    clear();
  });

  it("continues a compound request after a single write tool is confirmed", async () => {
    // Simulates "create a file, then commit it": round 1 asks for
    // create_file (pauses for confirmation), round 2 (post-confirm) asks
    // for git_commit, round 3 returns final text.
    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "create_file", args: { path: "a.txt", contents: "hi" } }], raw: null },
      { text: null, tool_calls: [{ name: "git_commit", args: { message: "add a.txt" } }], raw: null },
      { text: "Done: created and committed.", tool_calls: [], raw: null },
    ]);

    const toolFunctions = {
      create_file: (args: Record<string, unknown>) =>
        args.confirm ? { created: true, path: args.path } : { requires_confirmation: true, path: args.path },
      git_commit: (args: Record<string, unknown>) =>
        args.confirm ? { committed: true, message: args.message } : { requires_confirmation: true },
    };

    const firstEvents = await collectEvents(
      runAgentLoop({
        provider,
        contents: [{ role: "user", content: "create a.txt and commit it" }],
        toolFunctions,
        createPending: realCreatePending,
      })
    );

    const pending = firstEvents.find((e) => e.type === "pending_confirmation") as PendingConfirmationEvent;
    expect(pending).toBeDefined();
    expect(pending.name).toBe("create_file");

    const action = getPending(pending.action_id) as PendingAction;
    expect(action.resume).toBeDefined();

    const resumedEvents = await collectEvents(
      resumeAgentLoop({
        provider,
        action,
        confirmed: true,
        toolFunctions,
        createPending: realCreatePending,
      })
    );

    // The confirmed create_file ran for real (not a preview).
    const createResult = resumedEvents.find(
      (e) => e.type === "tool_result" && e.name === "create_file"
    );
    expect(createResult).toMatchObject({ result: { created: true, path: "a.txt" } });

    // The loop kept going: it hit git_commit's own confirmation gate rather
    // than stopping after create_file.
    const secondPending = resumedEvents.find((e) => e.type === "pending_confirmation") as PendingConfirmationEvent;
    expect(secondPending).toBeDefined();
    expect(secondPending.name).toBe("git_commit");

    // Confirming that second pause finishes the whole compound request.
    const secondAction = getPending(secondPending.action_id) as PendingAction;
    const finalEvents = await collectEvents(
      resumeAgentLoop({
        provider,
        action: secondAction,
        confirmed: true,
        toolFunctions,
        createPending: realCreatePending,
      })
    );
    const finalEvent = finalEvents.find((e) => e.type === "final");
    expect(finalEvent).toMatchObject({ text: "Done: created and committed." });
  });

  it("records a decline and still lets the model see it and continue", async () => {
    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "delete_file", args: { path: "a.txt" } }], raw: null },
      { text: "Okay, I left a.txt alone.", tool_calls: [], raw: null },
    ]);

    const toolFunctions = {
      delete_file: (args: Record<string, unknown>) =>
        args.confirm ? { deleted: true, path: args.path } : { requires_confirmation: true, path: args.path },
    };

    const firstEvents = await collectEvents(
      runAgentLoop({
        provider,
        contents: [{ role: "user", content: "delete a.txt" }],
        toolFunctions,
        createPending: realCreatePending,
      })
    );
    const pending = firstEvents.find((e) => e.type === "pending_confirmation") as PendingConfirmationEvent;
    const action = getPending(pending.action_id) as PendingAction;

    const resumedEvents = await collectEvents(
      resumeAgentLoop({
        provider,
        action,
        confirmed: false,
        toolFunctions,
        createPending: realCreatePending,
      })
    );

    const declinedResult = resumedEvents.find((e) => e.type === "tool_result" && e.name === "delete_file");
    expect(declinedResult).toMatchObject({
      result: { cancelled: true, message: "Action declined by user." },
    });
    // The loop didn't just stop: it called the model again and produced a
    // final response acknowledging the decline.
    const finalEvent = resumedEvents.find((e) => e.type === "final");
    expect(finalEvent).toMatchObject({ text: "Okay, I left a.txt alone." });
  });

  it("finishes remaining calls queued in the same round before calling the model again", async () => {
    const provider = new FakeProvider([
      {
        text: null,
        tool_calls: [
          { name: "git_add", args: { path: "a.txt" } },
          { name: "git_add", args: { path: "b.txt" } },
        ],
        raw: null,
      },
      { text: "Both files staged.", tool_calls: [], raw: null },
    ]);

    const toolFunctions = {
      git_add: (args: Record<string, unknown>) =>
        args.confirm ? { staged: true, path: args.path } : { requires_confirmation: true, path: args.path },
    };

    const firstEvents = await collectEvents(
      runAgentLoop({
        provider,
        contents: [{ role: "user", content: "stage a.txt and b.txt" }],
        toolFunctions,
        createPending: realCreatePending,
      })
    );
    const pending = firstEvents.find((e) => e.type === "pending_confirmation") as PendingConfirmationEvent;
    expect(pending.args).toEqual({ path: "a.txt" });
    const action = getPending(pending.action_id) as PendingAction;
    expect(action.resume!.remaining_calls).toHaveLength(2);

    const resumedEvents = await collectEvents(
      resumeAgentLoop({
        provider,
        action,
        confirmed: true,
        toolFunctions,
        createPending: realCreatePending,
      })
    );

    // b.txt's git_add must also pause for its own confirmation rather than
    // being silently auto-run, even though it was queued in the same round.
    const secondPending = resumedEvents.find((e) => e.type === "pending_confirmation") as PendingConfirmationEvent;
    expect(secondPending.args).toEqual({ path: "b.txt" });

    const secondAction = getPending(secondPending.action_id) as PendingAction;
    expect(secondAction.resume!.remaining_calls).toHaveLength(1);
    expect(secondAction.resume!.tool_results).toEqual([
      { name: "git_add", result: { staged: true, path: "a.txt" } },
    ]);

    const finalEvents = await collectEvents(
      resumeAgentLoop({
        provider,
        action: secondAction,
        confirmed: true,
        toolFunctions,
        createPending: realCreatePending,
      })
    );
    expect(finalEvents.find((e) => e.type === "final")).toMatchObject({ text: "Both files staged." });
  });

  it("throws when the action has no saved resume state", async () => {
    const provider = new FakeProvider([]);
    const action: PendingAction = {
      action_id: "legacy-1",
      tool_name: "git_add",
      args: { path: "a.txt" },
      preview: { requires_confirmation: true },
    };

    await expect(async () => {
      for await (const _ of resumeAgentLoop({
        provider,
        action,
        confirmed: true,
        toolFunctions: {},
        createPending: realCreatePending,
      })) {
        // drain
      }
    }).rejects.toThrow(/no saved loop state to resume/);
  });

  it("throws when the active provider no longer matches the one that paused", async () => {
    const pausedProvider = new FakeProvider([]);
    const resumedProvider = new FakeProvider([]);
    resumedProvider.name = "different-provider";

    const action: PendingAction = {
      action_id: "mismatch-1",
      tool_name: "git_add",
      args: { path: "a.txt" },
      preview: { requires_confirmation: true },
      resume: {
        provider_fingerprint: "fake:fake-model",
        contents: [],
        round_index: 0,
        tool_results: [],
        remaining_calls: [{ name: "git_add", args: { path: "a.txt" } }],
        last_call_signature: null,
        consecutive_repeat_count: 1,
        consecutive_error_count: 0,
      },
    };

    await expect(async () => {
      for await (const _ of resumeAgentLoop({
        provider: resumedProvider,
        action,
        confirmed: true,
        toolFunctions: { git_add: () => ({ staged: true }) },
        createPending: realCreatePending,
      })) {
        // drain
      }
    }).rejects.toThrow(/provider\/model differs/);
  });

  it("pauses read_file_permission when a read is outside the allowed set, then resumes on grant", async () => {
    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "read_file", args: { path: "secret.txt" } }], raw: null },
      { text: "The file says: shh.", tool_calls: [], raw: null },
    ]);

    // Simulates security.ts's requireReadAllowed(): denied until the
    // caller (routes.ts, via runWithAllowedReadPaths) grants the path.
    let accessGranted = false;
    const toolFunctions = {
      read_file: (args: Record<string, unknown>) =>
        accessGranted
          ? { path: args.path, contents: "shh" }
          : {
              error: `Access denied: '${args.path}' is not in the set of files the user selected for the agent. Select it on the Project page first.`,
            },
    };

    const firstEvents = await collectEvents(
      runAgentLoop({
        provider,
        contents: [{ role: "user", content: "read secret.txt" }],
        toolFunctions,
        createPending: realCreatePending,
      })
    );

    const pending = firstEvents.find((e) => e.type === "pending_confirmation") as PendingConfirmationEvent;
    expect(pending).toBeDefined();
    expect(pending.name).toBe("read_file_permission");
    expect(pending.args).toEqual({ path: "secret.txt" });

    const action = getPending(pending.action_id) as PendingAction;
    expect(action.tool_name).toBe("read_file_permission");
    expect(action.resume!.remaining_calls).toEqual([{ name: "read_file", args: { path: "secret.txt" } }]);

    // The caller grants access (what routes.ts's runWithAllowedReadPaths
    // wiring does in the real server) before resuming.
    accessGranted = true;

    const resumedEvents = await collectEvents(
      resumeAgentLoop({
        provider,
        action,
        confirmed: true,
        toolFunctions,
        createPending: realCreatePending,
      })
    );

    const readResult = resumedEvents.find((e) => e.type === "tool_result" && e.name === "read_file");
    expect(readResult).toMatchObject({ result: { path: "secret.txt", contents: "shh" } });
    expect(resumedEvents.find((e) => e.type === "final")).toMatchObject({ text: "The file says: shh." });
  });

  it("records a declined read permission and lets the model continue without the file", async () => {
    const provider = new FakeProvider([
      { text: null, tool_calls: [{ name: "read_file", args: { path: "secret.txt" } }], raw: null },
      { text: "Okay, I won't read that file.", tool_calls: [], raw: null },
    ]);

    const toolFunctions = {
      read_file: (_args: Record<string, unknown>) => ({
        error: "Access denied: 'secret.txt' is not in the set of files the user selected for the agent. Select it on the Project page first.",
      }),
    };

    const firstEvents = await collectEvents(
      runAgentLoop({
        provider,
        contents: [{ role: "user", content: "please read secret.txt" }],
        toolFunctions,
        createPending: realCreatePending,
      })
    );
    const pending = firstEvents.find((e) => e.type === "pending_confirmation") as PendingConfirmationEvent;
    const action = getPending(pending.action_id) as PendingAction;

    const resumedEvents = await collectEvents(
      resumeAgentLoop({
        provider,
        action,
        confirmed: false,
        toolFunctions,
        createPending: realCreatePending,
      })
    );

    const declinedResult = resumedEvents.find((e) => e.type === "tool_result" && e.name === "read_file");
    expect(declinedResult).toMatchObject({
      result: { cancelled: true, message: "Action declined by user." },
    });
    expect(resumedEvents.find((e) => e.type === "final")).toMatchObject({
      text: "Okay, I won't read that file.",
    });
  });
});
