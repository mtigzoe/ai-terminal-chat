import { describe, it, expect, beforeEach, vi } from "vitest";
import { StubProvider } from "../src/providers/stub.ts";

const gitStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../src/providers/factory.ts", () => {
  const SUPPORTED_PROVIDERS = [
    "gemini",
    "ollama",
    "kilo",
    "openai",
    "xai",
    "openrouter",
    "anthropic",
  ];

  return {
    getProvider: vi.fn((name?: string, overrides?: { model?: string }) => {
      const providerName = name || process.env.PROVIDER || "gemini";
      const model = overrides?.model || "test-model";
      return new StubProvider(providerName, model);
    }),
    buildProviderStatus: vi.fn(async (provider, probe = true) => {
      return {
        name: provider.name,
        model: provider.model,
        capabilities: provider.capabilities,
        available: true,
        error: null,
        current: provider.name,
        providers: SUPPORTED_PROVIDERS,
      };
    }),
  };
});

vi.mock("../src/git.ts", () => ({
  gitStatus: gitStatusMock,
  gitDiff: vi.fn(),
  gitLog: vi.fn(),
  gitBranch: vi.fn(),
}));

import { app } from "../src/routes.js";
import { clear as clearPending } from "../src/pending.js";
import { clear as clearCancellation } from "../src/cancellation.js";
import { setProjectRoot } from "../src/security.js";
import { reloadAllowedCommands, persistAllowedCommands, DEFAULT_ALLOWED_COMMAND_PREFIXES } from "../src/terminal.js";
function createTestApp() {
  return app;
}

beforeEach(() => {
  // Reset allowlist to defaults on disk so that mutations from other
  // test files cannot leak into these tests, then reload into memory.
  persistAllowedCommands([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  reloadAllowedCommands();
  // Ensure the allowlist starts from defaults so earlier test files
  // that modified or persisted the allowlist do not affect these tests.
});

describe("GET /providers", () => {
  it("returns provider status and supported providers list", async () => {
    const res = await createTestApp().request("http://localhost/providers");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBeDefined();
    expect(data.model).toBeDefined();
    expect(data.capabilities).toBeDefined();
    expect(data.current).toBe(data.name);
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data.providers.length).toBeGreaterThan(0);
  });

  it("skips probe when probe=0", async () => {
    const res = await createTestApp().request("http://localhost/providers?probe=0");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBeDefined();
  });
});

describe("POST /providers/select", () => {
  it("returns error for missing provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("provider is required");
  });

  it("returns error for unknown provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "unknown" }),
    });
    expect(res.status).toBe(400);
	
    const data = await res.json();
    expect(data.error).toContain("Unknown provider");
  });

  it("switches to a valid provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "ollama", model: "llama3.1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("ollama");
    expect(data.model).toBe("llama3.1");

    const current = await createTestApp().request("http://localhost/providers?probe=0");
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      name: "ollama",
      model: "llama3.1",
      current: "ollama",
    });
  });
});

describe("GET /providers/:name/models", () => {
  it("returns models for a valid provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/ollama/models");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.provider).toBe("ollama");
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.supports_listing).toBeDefined();
  });

  it("returns 404 for unknown provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/unknown/models");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("Unknown provider");
  });
});

describe("GET /project-root", () => {
  it("returns current project root", async () => {
    const res = await createTestApp().request("http://localhost/project-root");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.path).toBeDefined();
    expect(typeof data.path).toBe("string");
  });
});

describe("POST /project-root", () => {
  it("returns error for invalid JSON", async () => {
    const res = await createTestApp().request("http://localhost/project-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("sets project root to a valid path", async () => {
    const res = await createTestApp().request("http://localhost/project-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: process.cwd() }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.path).toBeDefined();
  });

  it("returns error for non-existent path", async () => {
    const res = await createTestApp().request("http://localhost/project-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/nonexistent/path/12345" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("GET /project/list", () => {
  it("lists files in project root", async () => {
    const res = await createTestApp().request("http://localhost/project/list?path=.");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it("returns 400 for non-existent path", async () => {
    const res = await createTestApp().request("http://localhost/project/list?path=/nonexistent");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("GET /project/read", () => {
  it("returns 400 for missing path", async () => {
    const res = await createTestApp().request("http://localhost/project/read");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 404 for non-existent file", async () => {
    const res = await createTestApp().request("http://localhost/project/read?path=nonexistent.txt");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("rejects absolute paths, including paths inside the project", async () => {
    const absolutePath = encodeURIComponent(process.cwd());
    const res = await createTestApp().request(
      `http://localhost/project/read?path=${absolutePath}`
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Absolute paths are not allowed");
  });
});

describe("GET /allowed-commands", () => {
  it("returns list of allowed commands", async () => {
    const res = await createTestApp().request("http://localhost/allowed-commands");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.commands)).toBe(true);
  });
});

describe("POST /allowed-commands", () => {
  it("returns error for invalid JSON", async () => {
    const res = await createTestApp().request("http://localhost/allowed-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("adds a new allowed command", async () => {
    const res = await createTestApp().request("http://localhost/allowed-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commands).toContain("echo");
  });
});

describe("DELETE /allowed-commands/:command", () => {
  it("removes an allowed command", async () => {
    await createTestApp().request("http://localhost/allowed-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "testcmd" }),
    });
    const res = await createTestApp().request("http://localhost/allowed-commands/testcmd", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commands).not.toContain("testcmd");
  });
});

describe("POST /terminal/run", () => {
  beforeEach(() => {
    setProjectRoot(process.cwd());
  });
  
  it("returns error for missing command", async () => {
    const res = await createTestApp().request("http://localhost/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns error for disallowed command", async () => {
    const res = await createTestApp().request("http://localhost/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "rm -rf /" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("runs an allowed command", async () => {
    const res = await createTestApp().request("http://localhost/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pwd" }),
    });
	  

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.command).toBe("pwd");
    expect(typeof data.returncode).toBe("number");
  });
});

describe("POST /chat", () => {
  beforeEach(() => {
    clearPending();
    clearCancellation();
    gitStatusMock.mockClear();
  });

  it("returns error for empty message", async () => {
    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns error for invalid JSON", async () => {
    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("processes a chat message with stub provider", async () => {
    process.env.PROVIDER = "gemini";
    await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini" }),
    });
    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "Hello", history: [] }),
    });
    expect([200, 502]).toContain(res.status);
    const data = await res.json();
    expect(data.request_id).toBeDefined();
  }, 10000);

  const dirtyStatus = {
    status:
      "## git-status-badge...origin/git-status-badge [ahead 2, behind 1]\nM  staged.ts\n M modified.ts\n?? untracked.ts\n",
    truncated: false,
  };

  it.each(["git status", "What's my Git status?"])(
    "answers generic Git-status questions with the full summary: %s",
    async (chat) => {
      gitStatusMock.mockReturnValue(dirtyStatus);
      await createTestApp().request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      const res = await createTestApp().request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat, history: [] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(gitStatusMock).toHaveBeenCalledOnce();
      expect(data.tool_activity).toContainEqual(
        expect.objectContaining({ type: "tool_call", name: "git_status" })
      );
      expect(data.text).toContain("You have 3 uncommitted files.");
      expect(data.text).toContain("1 file is staged for the next commit.");
      expect(data.text).toContain("2 commits not pushed");
      expect(data.text).toContain("1 commit behind the remote.");
      expect(data.text).toContain("staged.ts — modified, staged");
      expect(data.text).toContain("modified.ts — modified, not staged");
      expect(data.text).toContain("untracked.ts — new file, not tracked by Git");
    }
  );

  it.each(["Did I commit everything?", "Did I git commit?"])(
    "answers commit questions with an explicit yes/no: %s",
    async (chat) => {
      gitStatusMock.mockReturnValue(dirtyStatus);
      await createTestApp().request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      const res = await createTestApp().request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat, history: [] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(gitStatusMock).toHaveBeenCalledOnce();
      expect(data.tool_activity).toContainEqual(
        expect.objectContaining({ type: "tool_call", name: "git_status" })
      );
      expect(data.text).toMatch(/^No\./);
      expect(data.text).toContain("3 uncommitted file");
      expect(data.text).toContain("1 file is already staged");
      expect(data.text).toContain("staged.ts — modified, staged");
      expect(data.text).toContain("modified.ts — modified, not staged");
      expect(data.text).toContain("untracked.ts — new file, not tracked by Git");
    }
  );

  it.each(["Did I git push?", "Am I safe to git push?", "Can I git push?"])(
    "answers push questions with an explicit yes/no: %s",
    async (chat) => {
      gitStatusMock.mockReturnValue(dirtyStatus);
      await createTestApp().request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      const res = await createTestApp().request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat, history: [] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(gitStatusMock).toHaveBeenCalledOnce();
      expect(data.tool_activity).toContainEqual(
        expect.objectContaining({ type: "tool_call", name: "git_status" })
      );
      expect(data.text).toMatch(/^No\./);
      expect(data.text).toContain("2 commits that have not been pushed");
      expect(data.text).toContain("1 commit behind the remote");
      expect(data.text).toContain("3 uncommitted change");
      expect(data.text).toContain("staged.ts — modified, staged");
      expect(data.text).toContain("modified.ts — modified, not staged");
      expect(data.text).toContain("untracked.ts — new file, not tracked by Git");
    }
  );

  it("answers commit questions affirmatively when the working tree is clean", async () => {
    gitStatusMock.mockReturnValue({
      status: "## main...origin/main\n",
      truncated: false,
    });
    await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini" }),
    });

    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "Did I git commit?", history: [] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(gitStatusMock).toHaveBeenCalledOnce();
    expect(data.text).toBe(
      "Yes. Your working tree is clean; all changes have been committed."
    );
  });

  it("answers push questions affirmatively when the branch is synchronized", async () => {
    gitStatusMock.mockReturnValue({
      status: "## main...origin/main\n",
      truncated: false,
    });
    await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini" }),
    });

    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "Did I git push?", history: [] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(gitStatusMock).toHaveBeenCalledOnce();
    expect(data.text).toBe(
      "Yes. Your local branch is synchronized with the remote and the working tree is clean; there is nothing to push."
    );
  });
});

describe("POST /stream", () => {
  beforeEach(async () => {
    gitStatusMock.mockClear();
    process.env.PROVIDER = "gemini";
    await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini" }),
    });
  });

  it("uses Flask-compatible plain text when NDJSON was not requested", async () => {
    const res = await createTestApp().request("http://localhost/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "Hello", history: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("[stub] Hello from");
  });

  it("returns NDJSON events for the React client's negotiated stream", async () => {
    const res = await createTestApp().request("http://localhost/stream", {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson, text/plain",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ chat: "Hello", history: [] }),
    });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "final")).toBe(true);
  });

  it("returns a plain-language Git status instead of the stub greeting", async () => {
    gitStatusMock.mockReturnValue({
      status: "## main...origin/main\n",
      truncated: false,
    });
    const res = await createTestApp().request("http://localhost/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "What's my Git status?", history: [] }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(gitStatusMock).toHaveBeenCalledOnce();
    expect(text).toContain(
      "Your working tree is clean. Your local branch is synchronized with its remote branch."
    );
  });
});

describe("POST /cancel/:request_id", () => {
  it("returns cancelled=false for unknown request", async () => {
    const res = await createTestApp().request("http://localhost/cancel/nonexistent", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled).toBe(false);
  });
});

describe("POST /confirm", () => {
  beforeEach(() => {
    clearPending();
  });

  it("returns error for missing action_id", async () => {
    const res = await createTestApp().request("http://localhost/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 404 for unknown action_id", async () => {
    const res = await createTestApp().request("http://localhost/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_id: "nonexistent", confirmed: true }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});
