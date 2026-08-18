import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import {
  getConfiguredProviderName,
  getEnvInt,
  getEnvString,
  loadEnvFile,
  loadServerConfig,
  SERVER_HOST,
} from "./config.js";

// Snapshot and restore any env vars a test touches, so tests never leak
// state into each other or into the surrounding shell environment.
const TRACKED_VARS = ["PORT", "PROVIDER", "AI_TERMINAL_CHAT_TEST_VAR"];
let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const name of TRACKED_VARS) {
    snapshot[name] = process.env[name];
  }
});

afterEach(() => {
  for (const name of TRACKED_VARS) {
    const value = snapshot[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("getEnvString", () => {
  test("returns the default when unset", () => {
    delete process.env.AI_TERMINAL_CHAT_TEST_VAR;
    assert.equal(getEnvString("AI_TERMINAL_CHAT_TEST_VAR", "fallback"), "fallback");
  });

  test("returns the default when set but blank", () => {
    process.env.AI_TERMINAL_CHAT_TEST_VAR = "   ";
    assert.equal(getEnvString("AI_TERMINAL_CHAT_TEST_VAR", "fallback"), "fallback");
  });

  test("returns the set value", () => {
    process.env.AI_TERMINAL_CHAT_TEST_VAR = "custom";
    assert.equal(getEnvString("AI_TERMINAL_CHAT_TEST_VAR", "fallback"), "custom");
  });

  test("returns undefined with no default when unset", () => {
    delete process.env.AI_TERMINAL_CHAT_TEST_VAR;
    assert.equal(getEnvString("AI_TERMINAL_CHAT_TEST_VAR"), undefined);
  });
});

describe("getEnvInt", () => {
  test("returns the default when unset", () => {
    delete process.env.PORT;
    assert.equal(getEnvInt("PORT", 9000), 9000);
  });

  test("parses a valid integer", () => {
    process.env.PORT = "8080";
    assert.equal(getEnvInt("PORT", 9000), 8080);
  });

  test("falls back silently on invalid input by default", () => {
    process.env.PORT = "not-a-number";
    assert.equal(getEnvInt("PORT", 9000), 9000);
  });

  test("throws on invalid input when strict is requested", () => {
    process.env.PORT = "not-a-number";
    assert.throws(() => getEnvInt("PORT", 9000, { strict: true }), /must be an integer/);
  });
});

describe("loadServerConfig", () => {
  test("defaults PORT to 9000, matching client-react's default VITE_API_URL", () => {
    delete process.env.PORT;
    assert.deepEqual(loadServerConfig(), { port: 9000, host: SERVER_HOST });
  });

  test("honors PORT from the environment", () => {
    process.env.PORT = "4000";
    assert.deepEqual(loadServerConfig(), { port: 4000, host: SERVER_HOST });
  });

  test("host is always loopback-only, matching server-python's hardcoded bind address", () => {
    assert.equal(SERVER_HOST, "127.0.0.1");
    assert.equal(loadServerConfig().host, "127.0.0.1");
  });
});

describe("getConfiguredProviderName", () => {
  test("defaults to gemini, matching server-python's PROVIDER default", () => {
    delete process.env.PROVIDER;
    assert.equal(getConfiguredProviderName(), "gemini");
  });

  test("honors PROVIDER from the environment", () => {
    process.env.PROVIDER = "ollama";
    assert.equal(getConfiguredProviderName(), "ollama");
  });

  test("lowercases PROVIDER, matching Python's .lower() call", () => {
    process.env.PROVIDER = "OpenAI";
    assert.equal(getConfiguredProviderName(), "openai");
  });
});

describe("loadEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-terminal-chat-config-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("does nothing when the file does not exist", () => {
    assert.doesNotThrow(() => loadEnvFile(join(dir, "missing.env")));
  });

  test("loads variables from an existing file", () => {
    delete process.env.AI_TERMINAL_CHAT_TEST_VAR;
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "AI_TERMINAL_CHAT_TEST_VAR=from-file\n");

    loadEnvFile(envPath);

    assert.equal(process.env.AI_TERMINAL_CHAT_TEST_VAR, "from-file");
  });

  test("does not override a variable already set, matching python-dotenv's override=False default", () => {
    process.env.AI_TERMINAL_CHAT_TEST_VAR = "already-set";
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "AI_TERMINAL_CHAT_TEST_VAR=from-file\n");

    loadEnvFile(envPath);

    assert.equal(process.env.AI_TERMINAL_CHAT_TEST_VAR, "already-set");
  });

  after(() => {
    delete process.env.AI_TERMINAL_CHAT_TEST_VAR;
  });
});
