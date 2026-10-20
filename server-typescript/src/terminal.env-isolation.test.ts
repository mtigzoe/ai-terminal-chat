import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { buildSanitizedTerminalEnv } from "./terminal.ts";

test("sanitized terminal env strips execution, config, credential, and proxy overrides", () => {
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_TERMINAL_CHAT_CONFIG_DIR: process.env.AI_TERMINAL_CHAT_CONFIG_DIR,
    PYTHONPATH: process.env.PYTHONPATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    npm_config_registry: process.env.npm_config_registry,
    PIP_INDEX_URL: process.env.PIP_INDEX_URL,
    PYTEST_ADDOPTS: process.env.PYTEST_ADDOPTS,
    RUFF_CACHE_DIR: process.env.RUFF_CACHE_DIR,
    HTTP_PROXY: process.env.HTTP_PROXY,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    KEEP_ME: process.env.KEEP_ME,
  };
  Object.assign(process.env, {
    OPENAI_API_KEY: "sentinel",
    AI_TERMINAL_CHAT_CONFIG_DIR: "/private/application-profile/backend-config",
    PYTHONPATH: "/tmp/evil",
    NODE_OPTIONS: "--require=/tmp/evil.js",
    npm_config_registry: "http://evil.invalid/",
    PIP_INDEX_URL: "http://evil.invalid/simple",
    PYTEST_ADDOPTS: "-p evil",
    RUFF_CACHE_DIR: "/tmp/evil",
    HTTP_PROXY: "http://evil.invalid:8080",
    SSL_CERT_FILE: "/tmp/evil.pem",
    KEEP_ME: "yes",
  });
  try {
    const { env, cleanup } = buildSanitizedTerminalEnv();
    try {
      for (const key of [
        "OPENAI_API_KEY", "AI_TERMINAL_CHAT_CONFIG_DIR", "PYTHONPATH", "NODE_OPTIONS", "npm_config_registry",
        "PIP_INDEX_URL", "PYTEST_ADDOPTS", "RUFF_CACHE_DIR", "HTTP_PROXY",
        "SSL_CERT_FILE",
      ]) assert.equal(env[key], undefined, key);
      assert.equal(env.KEEP_ME, "yes");
    } finally {
      cleanup();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("application config directory overrides are stripped regardless of casing", () => {
  const name = "AI_TERMINAL_CHAT_CONFIG_DIR";
  const previous = Object.entries(process.env).filter(([key]) => key.toUpperCase() === name);
  try {
    for (const variant of ["ai_terminal_chat_config_dir", "Ai_Terminal_Chat_Config_Dir"]) {
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === name) delete process.env[key];
      }
      process.env[variant] = "/private/application-profile/backend-config";
      const { env, cleanup } = buildSanitizedTerminalEnv();
      try {
        assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase() === name), []);
      } finally {
        cleanup();
      }
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === name) delete process.env[key];
    }
    for (const [key, value] of previous) process.env[key] = value;
  }
});

test("sanitized terminal env isolates HOME and cleans it up", () => {
  const { env, cleanup } = buildSanitizedTerminalEnv();
  const home = env.HOME!;
  try {
    assert.notEqual(home, process.env.HOME);
    assert.equal(env.USERPROFILE, home);
    assert.ok(env.XDG_CONFIG_HOME?.startsWith(home));
    assert.ok(existsSync(home));
  } finally {
    cleanup();
  }
  assert.equal(existsSync(home), false);
});
