import { describe, it, expect, beforeEach, vi } from "vitest";
import { StubProvider } from "../src/providers/stub.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const gitStatusMock = vi.hoisted(() => vi.fn());
const ollamaCliInstalledMock = vi.hoisted(() => vi.fn());

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

vi.mock("../src/ollama-cli.ts", () => ({
  isOllamaCliInstalled: () => ollamaCliInstalledMock(),
  launchOllamaRun: vi.fn(async (model: string) => {
    const trimmedModel = (model || "").trim();
    if (!trimmedModel) {
      return { error: "A model name is required." };
    }
    const SAFE_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
    if (!SAFE_MODEL_NAME.test(trimmedModel)) {
      return { error: `'${trimmedModel}' is not a valid Ollama model name.` };
    }
    return {
      error: "The `ollama` command was not found on PATH. Install Ollama first, then try again.",
    };
  }),
}));

import { app } from "../src/routes.js";
import { clear as clearPending, createPending } from "../src/pending.js";
import { providerFingerprint } from "../src/agent.js";
import { getProvider } from "../src/providers/factory.js";
import { clear as clearCancellation } from "../src/cancellation.js";
import { setProjectRoot, getProjectRoot } from "../src/security.js";
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

describe("GET /health", () => {
  it("returns 404 when health token is not configured", async () => {
    const res = await createTestApp().request("http://localhost/health");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("Health check not configured");
  });

  it("returns 401 when Authorization header is missing", async () => {
    process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN = "test-token";
    try {
      const res = await createTestApp().request("http://localhost/health");
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Authorization header");
    } finally {
      delete process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN;
    }
  });

  it("returns 401 when Authorization header has invalid format", async () => {
    process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN = "test-token";
    try {
      const res = await createTestApp().request("http://localhost/health", {
        headers: { Authorization: "InvalidFormat" },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Authorization header");
    } finally {
      delete process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN;
    }
  });

  it("returns 401 when health token is invalid", async () => {
    process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN = "test-token";
    try {
      const res = await createTestApp().request("http://localhost/health", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Invalid health token");
    } finally {
      delete process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN;
    }
  });

  it("returns ok when health token is valid", async () => {
    const token = "test-health-token";
    process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN = token;
    try {
      const res = await createTestApp().request("http://localhost/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
      expect(data.app).toBe("ai-terminal-chat");
      expect(data.version).toBe("1.0.0");
    } finally {
      delete process.env.AI_TERMINAL_CHAT_HEALTH_TOKEN;
    }
  });
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

describe("GET /providers/ollama/status", () => {
  beforeEach(() => {
    ollamaCliInstalledMock.mockReturnValue(false);
  });

  it("reports whether the ollama CLI is on PATH", async () => {
    const res = await createTestApp().request("http://localhost/providers/ollama/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ installed: false });
  });
});

describe("POST /providers/ollama/run", () => {
  beforeEach(() => {
    ollamaCliInstalledMock.mockReturnValue(false);
  });

  it("returns an error when no model is given", async () => {
    const res = await createTestApp().request("http://localhost/providers/ollama/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("A model name is required.");
  });

  it("returns an error when the model name is invalid", async () => {
    const res = await createTestApp().request("http://localhost/providers/ollama/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "--help" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("not a valid Ollama model name");
  });

  it("returns an error when ollama is not installed", async () => {
    const res = await createTestApp().request("http://localhost/providers/ollama/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3.1" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("was not found on PATH");
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

  it("resumes the agent loop end-to-end after a real /chat confirmation", async () => {
    // Regression test for the /confirm handler running the confirmed tool
    // in isolation and stopping, instead of letting the model take another
    // turn afterward. "git add <path>" is routed straight to git_add by
    // agent.ts's directGitCommand() shortcut, so this needs no scripted
    // provider tool call to set up the pending confirmation.
    const originalRoot = getProjectRoot();
    const root = path.join(os.tmpdir(), `confirm-resume-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    execSync("git init -q", { cwd: root, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: root, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: root, stdio: "ignore" });
    fs.writeFileSync(path.join(root, "hello.txt"), "hi");
    setProjectRoot(root);

    try {
      const chatRes = await createTestApp().request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: "git add hello.txt", history: [] }),
      });
      expect(chatRes.status).toBe(200);
      const chatData = await chatRes.json();
      const pending = chatData.tool_activity.find(
        (event: { type: string }) => event.type === "pending_confirmation"
      );
      expect(pending).toBeDefined();
      expect(pending.name).toBe("git_add");

      const confirmRes = await createTestApp().request("http://localhost/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_id: pending.action_id, confirmed: true }),
      });
      expect(confirmRes.status).toBe(200);
      const confirmData = await confirmRes.json();

      // The confirmed git_add actually ran...
      expect(confirmData.result).toMatchObject({ staged: true });
      const staged = execSync("git diff --cached --name-only", { cwd: root }).toString();
      expect(staged.trim()).toBe("hello.txt");

      // ...and the loop kept going afterward instead of stopping: the
      // (stubbed) model got a follow-up turn and produced final text.
      expect(confirmData.text).toContain("[stub] Hello from");
      expect(confirmData.pending_confirmation).toBeUndefined();
      expect(confirmData.cancelled).toBeUndefined();
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("grants read access end-to-end and resumes with the real file contents", async () => {
    // Regression test for the read-permission gate: security.ts's
    // allowedReadPaths scoping existed but nothing in routes.ts ever called
    // runWithAllowedReadPaths(), so a granted read_file_permission had no
    // way to actually unblock the retried read. Seeds the pending action
    // directly (agent.ts has no "read <path>" shortcut the way it does for
    // git commands, so there's no scriptable way to make the stub provider
    // request the read on its own) to isolate the /confirm-side wiring.
    const originalRoot = getProjectRoot();
    const root = path.join(os.tmpdir(), `confirm-read-permission-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "notes.txt"), "shh");
    setProjectRoot(root);

    try {
      const provider = getProvider();
      const action = createPending(
        "read_file_permission",
        { path: "notes.txt" },
        { message: "The assistant wants to read 'notes.txt'.", permission_request: true },
        {
          provider_fingerprint: providerFingerprint(provider),
          contents: [],
          round_index: 0,
          tool_results: [],
          remaining_calls: [{ name: "read_file", args: { path: "notes.txt" } }],
          last_call_signature: null,
          consecutive_repeat_count: 1,
          consecutive_error_count: 0,
        }
      );

      const confirmRes = await createTestApp().request("http://localhost/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_id: action.action_id, confirmed: true }),
      });
      expect(confirmRes.status).toBe(200);
      const confirmData = await confirmRes.json();

      expect(confirmData.permission_granted).toBe(true);
      expect(confirmData.path).toBe("notes.txt");
      // The retried read actually succeeded against the real filesystem,
      // proving the granted path was threaded through
      // runWithAllowedReadPaths() into security.ts's allowed-paths store.
      expect(confirmData.result).toMatchObject({ path: "notes.txt", contents: "shh" });
      // And the loop kept going afterward rather than stopping.
      expect(confirmData.text).toContain("[stub] Hello from");
      expect(confirmData.pending_confirmation).toBeUndefined();
      expect(confirmData.cancelled).toBeUndefined();
    } finally {
      setProjectRoot(originalRoot);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
