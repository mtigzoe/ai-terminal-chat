import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      const provider = new StubProvider(providerName, model);
      if (providerName === "ollama") {
        (provider as { providerConfig?: Record<string, unknown> }).providerConfig = {
          provider: "ollama",
          model,
          base_url: process.env.OLLAMA_BASE_URL,
          timeout: 120,
        };
      }
      return provider;
    }),
    buildProviderStatus: vi.fn(
      async (provider: {
        name: string;
        model: string;
        capabilities: unknown;
        providerConfig?: { base_url?: string };
      }) => {
        return {
          name: provider.name,
          model: provider.model,
          capabilities: provider.capabilities,
          available: true,
          error: null,
          base_url: provider.providerConfig?.base_url,
          current: provider.name,
          providers: SUPPORTED_PROVIDERS,
        };
      }
    ),
  };
});

vi.mock("../src/git.ts", () => ({
  gitStatus: gitStatusMock,
  gitDiff: vi.fn(),
  gitLog: vi.fn(),
  gitBranch: vi.fn(),
}));

import {
  CONFIG_FILE,
  CONFIG_DIR,
  loadProviderSelection,
  persistProviderSelection,
  getProjectRoot,
  setProjectRoot,
} from "../src/security.ts";
import { app, restoreProviderFromConfig } from "../src/routes.ts";
import { getProvider } from "../src/providers/factory.ts";

const originalConfig = (() => {
  try {
    return fs.readFileSync(CONFIG_FILE, "utf-8");
  } catch {
    return null;
  }
})();

const originalOllamaEnv = process.env.OLLAMA_BASE_URL;
const originalRoot = getProjectRoot();

function writeConfig(payload: Record<string, unknown>) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

beforeEach(() => {
  writeConfig({});
  delete process.env.OLLAMA_BASE_URL;
  vi.mocked(getProvider).mockClear();
});

afterEach(() => {
  if (originalConfig === null) {
    try {
      fs.unlinkSync(CONFIG_FILE);
    } catch {
      // ignore
    }
  } else {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, originalConfig, "utf-8");
  }
  if (originalOllamaEnv === undefined) {
    delete process.env.OLLAMA_BASE_URL;
  } else {
    process.env.OLLAMA_BASE_URL = originalOllamaEnv;
  }
  try {
    setProjectRoot(originalRoot);
  } catch {
    // ignore
  }
});

describe("loadProviderSelection / persistProviderSelection", () => {
  it("persists provider and model", () => {
    persistProviderSelection("ollama", "llama3.1");
    expect(loadProviderSelection()).toEqual({
      provider: "ollama",
      model: "llama3.1",
    });
  });

  it("normalizes Ollama hostname without scheme", () => {
    persistProviderSelection("ollama", "llama3.1", "cyber.local:11434");
    expect(loadProviderSelection()).toEqual({
      provider: "ollama",
      model: "llama3.1",
      ollama_base_url: "http://cyber.local:11434",
    });
  });

  it("preserves Ollama URL that already has a scheme", () => {
    persistProviderSelection("ollama", "mistral", "https://ollama.example:11434");
    expect(loadProviderSelection().ollama_base_url).toBe(
      "https://ollama.example:11434"
    );
  });

  it("clears stored Ollama URL when switching to a non-Ollama provider", () => {
    persistProviderSelection("ollama", "llama3.1", "cyber.local:11434");
    persistProviderSelection("gemini", "gemini-2.0-flash", null);
    const saved = loadProviderSelection();
    expect(saved.provider).toBe("gemini");
    expect(saved.model).toBe("gemini-2.0-flash");
    expect(saved.ollama_base_url).toBeUndefined();
    expect(readConfig().ollama_base_url).toBeUndefined();
  });

  it("keeps stored Ollama URL when re-selecting ollama without a new URL", () => {
    persistProviderSelection("ollama", "llama3.1", "cyber.local:11434");
    persistProviderSelection("ollama", "mistral");
    expect(loadProviderSelection()).toEqual({
      provider: "ollama",
      model: "mistral",
      ollama_base_url: "http://cyber.local:11434",
    });
  });
});

describe("POST /providers/select ollama_base_url", () => {
  it("accepts hostname cyber.local:11434 and applies env with /v1 once", async () => {
    const res = await app.request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "ollama",
        model: "llama3.1",
        ollama_base_url: "cyber.local:11434",
      }),
    });
    expect(res.status).toBe(200);
    expect(process.env.OLLAMA_BASE_URL).toBe("http://cyber.local:11434/v1");
    expect(loadProviderSelection()).toEqual({
      provider: "ollama",
      model: "llama3.1",
      ollama_base_url: "http://cyber.local:11434",
    });
    const data = await res.json();
    expect(data.name).toBe("ollama");
    expect(data.model).toBe("llama3.1");
  });

  it("does not produce /v1/v1 when URL already ends with /v1", async () => {
    const res = await app.request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "ollama",
        model: "llama3.1",
        ollama_base_url: "http://localhost:11434/v1",
      }),
    });
    expect(res.status).toBe(200);
    expect(process.env.OLLAMA_BASE_URL).toBe("http://localhost:11434/v1");
    expect(loadProviderSelection().ollama_base_url).toBe(
      "http://localhost:11434/v1"
    );
  });

  it("rejects blank Ollama hostname", async () => {
    const res = await app.request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "ollama",
        ollama_base_url: "   ",
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Ollama hostname is required/i);
  });

  it("clears stored Ollama URL when selecting a non-Ollama provider", async () => {
    persistProviderSelection("ollama", "llama3.1", "cyber.local:11434");
    const res = await app.request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini", model: "gemini-2.0-flash" }),
    });
    expect(res.status).toBe(200);
    expect(loadProviderSelection().ollama_base_url).toBeUndefined();
  });
});

describe("provider/model persistence and startup restore", () => {
  it("persists provider and model on successful select", async () => {
    const res = await app.request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "kilo",
        model: "kilocode/kilo-auto/balanced",
      }),
    });
    expect(res.status).toBe(200);
    expect(loadProviderSelection()).toEqual({
      provider: "kilo",
      model: "kilocode/kilo-auto/balanced",
    });
  });

  it("restoreProviderFromConfig loads provider and model but not ollama host", () => {
    persistProviderSelection("ollama", "mistral", "cyber.local:11434");
    delete process.env.OLLAMA_BASE_URL;
    vi.mocked(getProvider).mockClear();

    restoreProviderFromConfig();

    expect(getProvider).toHaveBeenCalledWith("ollama", { model: "mistral" });
    // Startup must not re-apply ollama_base_url (Python parity).
    expect(process.env.OLLAMA_BASE_URL).toBeUndefined();
  });
});

describe("POST /providers/select project_path", () => {
  it("applies a valid project_path after successful provider construction", async () => {
    const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-term-root-"));
    const before = getProjectRoot();
    try {
      const res = await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gemini",
          model: "gemini-2.0-flash",
          project_path: newRoot,
        }),
      });
      expect(res.status).toBe(200);
      expect(getProjectRoot()).toBe(path.resolve(newRoot));
    } finally {
      setProjectRoot(before);
      fs.rmSync(newRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid project_path without changing the project root", async () => {
    const before = getProjectRoot();
    const res = await app.request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "gemini",
        project_path: "/does/not/exist/anywhere-xyz",
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/does not exist|Could not switch/i);
    expect(getProjectRoot()).toBe(before);
  });

  it("rejects blank project_path without changing the project root", async () => {
    const before = getProjectRoot();
    const res = await app.request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "gemini",
        project_path: "   ",
      }),
    });
    expect(res.status).toBe(400);
    expect(getProjectRoot()).toBe(before);
  });

  it("does not change project root when provider construction fails", async () => {
    const before = getProjectRoot();
    const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-term-root-"));
    vi.mocked(getProvider).mockImplementationOnce(() => {
      throw new Error("provider boom");
    });
    try {
      const res = await app.request("http://localhost/providers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gemini",
          project_path: newRoot,
        }),
      });
      expect(res.status).toBe(400);
      expect(getProjectRoot()).toBe(before);
      // Failed select must not persist provider selection either.
      expect(loadProviderSelection().provider).toBeUndefined();
    } finally {
      fs.rmSync(newRoot, { recursive: true, force: true });
    }
  });
});
