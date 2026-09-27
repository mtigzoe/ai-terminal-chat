import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { buildSanitizedTerminalEnv } from "./terminal.ts";

test("sanitized terminal env strips execution, config, credential, and proxy overrides", () => {
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
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
        "OPENAI_API_KEY", "PYTHONPATH", "NODE_OPTIONS", "npm_config_registry",
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
