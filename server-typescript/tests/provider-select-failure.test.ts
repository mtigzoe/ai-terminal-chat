import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StubProvider } from "../src/providers/stub.ts";

vi.mock("../src/providers/factory.ts", () => ({
  getProvider: vi.fn((name?: string, overrides?: { model?: string }) => {
    if (overrides?.model === "rejected-model") {
      throw new Error("provider rejected this configuration");
    }
    return new StubProvider(name || "gemini", overrides?.model || "test-model");
  }),
  buildProviderStatus: vi.fn(async (provider: StubProvider) => ({
    name: provider.name,
    model: provider.model,
    capabilities: provider.capabilities,
    available: true,
    error: null,
  })),
}));

import { getConfigFile, setConfigFileForTests, setProjectRoot, getProjectRoot } from "../src/security.ts";
import { app } from "../src/routes.ts";

const trackedEnv = ["OPENAI_API_KEY", "OLLAMA_BASE_URL"] as const;
const originalEnv = Object.fromEntries(trackedEnv.map((n) => [n, process.env[n]]));
const originalRoot = getProjectRoot();

let tempDir: string;

async function select(body: Record<string, unknown>) {
  return app.request("http://localhost/providers/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
  } catch {
    return {};
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-term-select-"));
  setConfigFileForTests(path.join(tempDir, "config.json"));
  fs.writeFileSync(getConfigFile(), "{}\n", "utf-8");
});

afterEach(() => {
  setConfigFileForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const name of trackedEnv) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    setProjectRoot(originalRoot);
  } catch {
    // ignore
  }
});

describe("POST /providers/select failure", () => {
  it("restores an overwritten API key when the provider rejects the selection", async () => {
    process.env.OPENAI_API_KEY = "working-key";

    const res = await select({ provider: "openai", model: "rejected-model", api_key: "typo-key" });

    expect(res.status).toBe(400);
    expect(process.env.OPENAI_API_KEY).toBe("working-key");
  });

  it("does not wipe the API key when a failed selection sent an empty api_key", async () => {
    process.env.OPENAI_API_KEY = "working-key";

    const res = await select({ provider: "openai", model: "rejected-model", api_key: "" });

    expect(res.status).toBe(400);
    expect(process.env.OPENAI_API_KEY).toBe("working-key");
  });

  it("restores OLLAMA_BASE_URL when an Ollama selection fails", async () => {
    process.env.OLLAMA_BASE_URL = "http://previous.local:11434/v1";

    const res = await select({
      provider: "ollama",
      model: "rejected-model",
      ollama_base_url: "http://new.local:11434",
    });

    expect(res.status).toBe(400);
    expect(process.env.OLLAMA_BASE_URL).toBe("http://previous.local:11434/v1");
  });

  it("unsets a variable that did not exist before the failed selection", async () => {
    delete process.env.OPENAI_API_KEY;

    const res = await select({ provider: "openai", model: "rejected-model", api_key: "new-key" });

    expect(res.status).toBe(400);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps the previously active provider and persisted config after a failure", async () => {
    const ok = await select({ provider: "openai", model: "good-model", api_key: "good-key" });
    expect(ok.status).toBe(200);
    const persisted = readConfig();

    const failed = await select({ provider: "openai", model: "rejected-model", api_key: "bad-key" });
    expect(failed.status).toBe(400);

    expect(readConfig()).toEqual(persisted);
    expect(process.env.OPENAI_API_KEY).toBe("good-key");
    const status = await app.request("http://localhost/providers?probe=0");
    expect((await status.json()).current).toBe("openai");
  });

  it("still applies the new key and provider on success", async () => {
    process.env.OPENAI_API_KEY = "old-key";

    const res = await select({ provider: "openai", model: "good-model", api_key: "new-key" });

    expect(res.status).toBe(200);
    expect(process.env.OPENAI_API_KEY).toBe("new-key");
    expect(readConfig().provider).toBe("openai");
  });
});
