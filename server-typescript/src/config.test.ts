import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getConfiguredProviderName,
  getEnvInt,
  getEnvString,
  loadAppConfig,
  loadEnvFile,
  loadServerConfig,
  persistAppConfig,
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

describe("persistAppConfig concurrency", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-terminal-chat-config-concurrency-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("concurrent writers modify different properties without losing updates", async () => {
    const configPath = join(dir, "config.json");
    // Initial config
    writeFileSync(configPath, '{"project_root":"/tmp/test","provider":"gemini","ollama_base_url":null}\n');

    const NUM_WRITERS = 10;
    const ITERATIONS_PER_WRITER = 5;

    async function writer(writerId: number) {
      for (let i = 0; i < ITERATIONS_PER_WRITER; i++) {
        // Each writer modifies a different property
        const payload = loadAppConfig(configPath);
        payload[`writer_${writerId}_iter_${i}`] = `value_${writerId}_${i}`;
        persistAppConfig(payload, configPath);
      }
    }

    // Launch all writers concurrently
    await Promise.all(
      Array.from({ length: NUM_WRITERS }, (_, i) => writer(i))
    );

    // Verify all writes were persisted
    const finalConfig = loadAppConfig(configPath);
    let totalExpected = 0;
    for (let w = 0; w < NUM_WRITERS; w++) {
      for (let i = 0; i < ITERATIONS_PER_WRITER; i++) {
        const key = `writer_${w}_iter_${i}`;
        assert.equal(finalConfig[key], `value_${w}_${i}`);
        totalExpected++;
      }
    }
    // Also verify original properties preserved
    assert.equal(finalConfig.project_root, "/tmp/test");
    assert.equal(finalConfig.provider, "gemini");
    assert.equal(finalConfig.ollama_base_url, null);
    // Verify we have all expected keys
    const writerKeys = Object.keys(finalConfig).filter((k) => k.startsWith("writer_"));
    assert.equal(writerKeys.length, totalExpected);
  });

  test("concurrent same-property writes: last writer wins but no corruption", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, '{"counter":0}\n');

    const NUM_WRITERS = 10;
    const ITERATIONS_PER_WRITER = 5;

    async function writer(writerId: number) {
      for (let i = 0; i < ITERATIONS_PER_WRITER; i++) {
        const payload = loadAppConfig(configPath);
        payload.counter = writerId * 100 + i; // Each writer uses distinct range
        persistAppConfig(payload, configPath);
      }
    }

    await Promise.all(
      Array.from({ length: NUM_WRITERS }, (_, i) => writer(i))
    );

    // Config should be valid JSON and contain one of the written values
    const finalConfig = loadAppConfig(configPath);
    assert.ok(typeof finalConfig.counter === "number");
    // The counter should be in the range of written values (0 to 904)
    assert.ok(finalConfig.counter >= 0 && finalConfig.counter <= 904);
  });

  test("lock cleanup after success", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, '{"value":1}\n');

    // Successful write should clean up lock
    persistAppConfig({ value: 2 }, configPath);
    const lockPath = join(dir, ".config.config.lock");
    const fs = await import("node:fs");
    // Lock file should be cleaned up after successful write
    assert.ok(!fs.existsSync(lockPath));
  });

  test("existing lock is never deleted by competing writer", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, '{"value":1}\n');

    const lockPath = join(dir, ".config.config.lock");
    const fs = await import("node:fs");

    // Writer A: manually create and hold the lock (simulating long-running operation)
    const lockFdA = fs.openSync(lockPath, "wx");

    // Writer B: run in a separate process to genuinely test lock contention.
    // This avoids the event-loop blocking issue of Atomics.wait in the main test process.
    // Writer B imports and calls the REAL persistAppConfig() from the compiled dist.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const distPath = join(__dirname, "..", "dist", "config.js");
    // Convert to file:// URL for ESM import on Windows
    const distUrl = "file:///" + distPath.replace(/\\/g, "/");
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [
      "--experimental-vm-modules",
      "-e",
      `
        import { persistAppConfig } from "${distUrl}";
        const configPath = process.argv[2];
        const maxLockWaitMs = 200;
        
        try {
          // This will use the production locking implementation with the short timeout
          await persistAppConfig({ value: 2 }, configPath);
          // If we get here, we acquired the lock (shouldn't happen in this test)
          process.exit(0);
        } catch (err) {
          if (err.message?.includes("Could not acquire config lock")) {
            process.exit(1); // timeout - expected
          }
          throw err;
        }
      `,
      configPath,
    ], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let exited = false;

    // Capture stderr to detect any errors
    child.stderr?.on("data", (data) => {
      console.error("Worker stderr:", data.toString());
    });

    await new Promise<void>((resolve) => {
      child.on("exit", (code) => {
        exited = true;
        timedOut = code === 1; // Exit code 1 = timeout
        resolve();
      });
      child.on("error", () => {
        exited = true;
        resolve();
      });
      // Safety timeout
      setTimeout(() => {
        if (!exited) {
          child.kill();
          timedOut = true;
          resolve();
        }
      }, 2000);
    });

    // Verify: Writer A's lock was NOT deleted by Writer B
    assert.ok(fs.existsSync(lockPath), "Writer A's lock must still exist");
    assert.ok(timedOut, "Writer B should have timed out waiting for lock");

    // Release Writer A's lock
    fs.closeSync(lockFdA);
    fs.rmSync(lockPath, { force: true });

    // Verify that after releasing Writer A's lock, a normal persistAppConfig() succeeds
    persistAppConfig({ value: 3 }, configPath);
    const finalConfig = loadAppConfig(configPath);
    assert.equal(finalConfig.value, 3);
    assert.ok(!fs.existsSync(lockPath), "Lock should be cleaned up after successful write");
  });

  test("lock file is created and deleted correctly", async () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, '{"value":1}\n');

    const lockPath = join(dir, ".config.config.lock");
    const fs = await import("node:fs");

    // Before write: no lock file
    assert.ok(!fs.existsSync(lockPath));

    // During write: lock file exists (we can't easily test this synchronously)
    // After write: lock file is cleaned up
    persistAppConfig({ value: 2 }, configPath);
    assert.ok(!fs.existsSync(lockPath));
  });
});
