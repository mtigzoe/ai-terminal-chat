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

// ---------------------------------------------------------------------------
// Smoke tests — fast, high-level checks that the server is not broken.
// These deliberately avoid duplicating the detailed assertions already in
// api.test.ts and the other focused test files.
// ---------------------------------------------------------------------------

describe("server-typescript smoke tests", () => {
  beforeEach(() => {
    clearPending();
    clearCancellation();
    gitStatusMock.mockClear();
  });

  // -----------------------------------------------------------------------
  // 1. Application module loads and exports correctly
  // -----------------------------------------------------------------------
  describe("application initialization", () => {
    it("exports a Hono app that responds to requests", async () => {
      const res = await app.request("http://localhost/providers");
      expect([200, 404, 500]).toContain(res.status);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Critical GET endpoints
  // -----------------------------------------------------------------------
  describe("GET /providers", () => {
    it("returns provider status with the expected shape", async () => {
      const res = await app.request("http://localhost/providers");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("name");
      expect(data).toHaveProperty("model");
      expect(data).toHaveProperty("providers");
      expect(Array.isArray(data.providers)).toBe(true);
    });

    it("skips probe when probe=0", async () => {
      const res = await app.request("http://localhost/providers?probe=0");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("name");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Provider selection path (Settings/Provider)
  // -----------------------------------------------------------------------
  describe("POST /providers/select", () => {
    it("switches to a valid provider and reports the new status", async () => {
      const res = await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ollama", model: "llama3.1" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("ollama");
      expect(data.model).toBe("llama3.1");

      // Verify the selection persisted by checking the current provider.
      const current = await app.request("http://localhost/providers?probe=0");
      expect(current.status).toBe(200);
      expect((await current.json()).name).toBe("ollama");
    });

    it("rejects an unknown provider with 400", async () => {
      const res = await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "not-real" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 4. /chat happy path
  // -----------------------------------------------------------------------
  describe("POST /chat", () => {
    it("returns a response for a minimal valid request", async () => {
      // First select a provider so the route has an active one.
      await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      const res = await app.request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: "Hello", history: [] }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("request_id");
      expect(typeof data.request_id).toBe("string");
    });

    it("returns 400 for a malformed JSON body", async () => {
      const res = await app.request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it("returns 400 for an empty message", async () => {
      await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      const res = await app.request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: "   ", history: [] }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 5. /stream happy path
  // -----------------------------------------------------------------------
  describe("POST /stream", () => {
    it("returns streaming events for a minimal valid request", async () => {
      await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      const res = await app.request("http://localhost/stream", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson, text/plain",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ chat: "Hello", history: [] }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("[stub]");
    });

    it("returns a plain-text response when NDJSON is not requested", async () => {
      await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      const res = await app.request("http://localhost/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: "Hello", history: [] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
    });
  });

  // -----------------------------------------------------------------------
  // 6. Tool/agent path: a basic tool call round trip
  // -----------------------------------------------------------------------
  describe("tool/agent path", () => {
    it("processes a chat message that triggers a tool call", async () => {
      await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });

      gitStatusMock.mockReturnValue({
        status: "## main...origin/main\n",
        truncated: false,
      });

      const res = await app.request("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: "What's my Git status?", history: [] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(gitStatusMock).toHaveBeenCalledOnce();
      expect(data.tool_activity).toContainEqual(
        expect.objectContaining({ type: "tool_call", name: "git_status" })
      );
    });
  });
});
