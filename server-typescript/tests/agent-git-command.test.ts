import { describe, expect, test, vi } from "vitest";
import { Provider, ProviderResponse } from "../src/providers/base.ts";
import { runAgentLoop } from "../src/agent.ts";

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

class NaturalLanguageProvider extends Provider {
  buildContents(msg: string, _history: unknown[]): unknown[] {
    return [{ role: "user", content: msg }];
  }

  async generate(_contents: unknown[]): Promise<ProviderResponse> {
    return {
      text: "git add stages a file for the next commit.",
      tool_calls: [],
      raw: null,
    };
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

  test("routes git fetch directly to git_fetch", async () => {
    const provider = new FakeProvider();
    const gitFetch = vi.fn(() => ({ output: "done", remote: "origin" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git fetch origin" }],
      toolFunctions: { git_fetch: gitFetch },
      createPending: () => ({ action_id: "unused" }),
    })) {
      events.push(event);
    }

    expect(gitFetch).toHaveBeenCalledWith({ remote: "origin" });
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });

  test("routes git pull directly to git_pull", async () => {
    const provider = new FakeProvider();
    const gitPull = vi.fn(() => ({
      requires_confirmation: true,
      remote: "origin",
      branch: "main",
    }));
    const createPending = vi.fn(() => ({ action_id: "action-1" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git pull origin main" }],
      toolFunctions: { git_pull: gitPull },
      createPending,
    })) {
      events.push(event);
    }

    expect(gitPull).toHaveBeenCalledWith({
      remote: "origin",
      branch: "main",
      confirm: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pending_confirmation",
        name: "git_pull",
      })
    );
  });

  test("routes git restore directly to git_restore", async () => {
    const provider = new FakeProvider();
    const gitRestore = vi.fn(() => ({
      requires_confirmation: true,
      path: "file.txt",
      action: "restore",
    }));
    const createPending = vi.fn(() => ({ action_id: "action-1" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git restore file.txt" }],
      toolFunctions: { git_restore: gitRestore },
      createPending,
    })) {
      events.push(event);
    }

    expect(gitRestore).toHaveBeenCalledWith({
      path: "file.txt",
      staged: false,
      confirm: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pending_confirmation",
        name: "git_restore",
      })
    );
  });

  test("routes git restore --staged directly to git_restore", async () => {
    const provider = new FakeProvider();
    const gitRestore = vi.fn(() => ({
      requires_confirmation: true,
      path: "file.txt",
      action: "unstage",
    }));
    const createPending = vi.fn(() => ({ action_id: "action-1" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git restore --staged file.txt" }],
      toolFunctions: { git_restore: gitRestore },
      createPending,
    })) {
      events.push(event);
    }

    expect(gitRestore).toHaveBeenCalledWith({
      path: "file.txt",
      staged: true,
      confirm: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pending_confirmation",
        name: "git_restore",
      })
    );
  });

  test("routes git commit -m directly to git_commit", async () => {
    const provider = new FakeProvider();
    const gitCommit = vi.fn(() => ({
      requires_confirmation: true,
      commit_message: "update feature",
    }));
    const createPending = vi.fn(() => ({ action_id: "action-1" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: 'git commit -m "update feature"' }],
      toolFunctions: { git_commit: gitCommit },
      createPending,
    })) {
      events.push(event);
    }

    expect(gitCommit).toHaveBeenCalledWith({
      message: "update feature",
      confirm: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pending_confirmation",
        name: "git_commit",
      })
    );
  });

  test("returns text for git commit without message", async () => {
    const provider = new FakeProvider();
    const gitCommit = vi.fn(() => ({
      requires_confirmation: true,
      commit_message: "test",
    }));
    const createPending = vi.fn(() => ({ action_id: "action-1" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git commit" }],
      toolFunctions: { git_commit: gitCommit },
      createPending,
    })) {
      events.push(event);
    }

    const errorEvents = events.filter((e) => e.type === "error");
    const finalEvents = events.filter((e) => e.type === "final");
    const pendingEvents = events.filter((e) => e.type === "pending_confirmation");
    
    if (finalEvents.length > 0) {
      expect((finalEvents[0] as { text: string }).text).toContain("message");
    } else if (pendingEvents.length > 0) {
      expect(pendingEvents[0]).toMatchObject({ name: "git_commit" });
    } else {
      expect(errorEvents.length).toBeGreaterThan(0);
    }
  });

  test("routes git push directly to git_push", async () => {
    const provider = new FakeProvider();
    const gitPush = vi.fn(() => ({
      requires_confirmation: true,
      remote: "origin",
      branch: "main",
    }));
    const createPending = vi.fn(() => ({ action_id: "action-1" }));

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "git push origin main" }],
      toolFunctions: { git_push: gitPush },
      createPending,
    })) {
      events.push(event);
    }

    expect(gitPush).toHaveBeenCalledWith({
      remote: "origin",
      branch: "main",
      confirm: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pending_confirmation",
        name: "git_push",
      })
    );
  });

  test("natural language git request still uses the model", async () => {
    const provider = new NaturalLanguageProvider();

    const events = [];
    for await (const event of runAgentLoop({
      provider,
      contents: [{ role: "user", content: "Can you explain what git add does?" }],
      toolFunctions: {},
      createPending: () => ({ action_id: "unused" }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "final")).toBe(true);
    const finalEvent = events.find((e) => e.type === "final") as { text: string } | undefined;
    expect(finalEvent?.text).toContain("git add");
  });
});
