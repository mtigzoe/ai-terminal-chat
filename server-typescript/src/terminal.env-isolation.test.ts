/**
 * Prove that non-Git terminal commands (npm/pip/pytest/Ruff/Black/Flake8)
 * never inherit provider credentials, interpreter/runtime override
 * variables, npm/pip/pytest/Ruff configuration namespaces, or proxy/TLS
 * variables from the server process - and that a *confirmed* execution-risk
 * command gets the same sanitized environment as an unconfirmed one would
 * (confirmation gates whether a command runs, not what environment it runs
 * with).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSanitizedTerminalEnv, runCommand } from "./terminal.ts";
import {
  __setProjectRootForTests,
  __resetProjectRootForTests,
} from "./security.ts";

/** Set env vars for the duration of `fn`, restoring the previous values
 * (or absence) afterward, even if `fn` throws/rejects. */
async function withEnv<T>(
  overrides: Record<string, string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("strips known provider/service credential variables", async () => {
  await withEnv(
    {
      OPENAI_API_KEY: "sk-sentinel",
      ANTHROPIC_API_KEY: "sk-sentinel",
      GITHUB_TOKEN: "ghp-sentinel",
      AWS_SECRET_ACCESS_KEY: "sentinel",
    },
    () => {
      const { env, cleanup } = buildSanitizedTerminalEnv();
      try {
        assert.equal(env.OPENAI_API_KEY, undefined);
        assert.equal(env.ANTHROPIC_API_KEY, undefined);
        assert.equal(env.GITHUB_TOKEN, undefined);
        assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      } finally {
        cleanup();
      }
    },
  );
});

test("strips generic *_API_KEY/*_SECRET/*_TOKEN/*PASSWORD* variables", async () => {
  await withEnv(
    {
      SOME_SERVICE_API_KEY: "sentinel",
      MY_APP_SECRET: "sentinel",
      SESSION_TOKEN: "sentinel",
      DB_PASSWORD: "sentinel",
      db_password: "sentinel", // case-insensitive sweep
    },
    () => {
      const { env, cleanup } = buildSanitizedTerminalEnv();
      try {
        assert.equal(env.SOME_SERVICE_API_KEY, undefined);
        assert.equal(env.MY_APP_SECRET, undefined);
        assert.equal(env.SESSION_TOKEN, undefined);
        assert.equal(env.DB_PASSWORD, undefined);
        assert.equal(env.db_password, undefined);
      } finally {
        cleanup();
      }
    },
  );
});

test("strips Python interpreter/module-loading variables", async () => {
  await withEnv(
    {
      PYTHONPATH: "/tmp/evil",
      PYTHONHOME: "/tmp/evil",
      PYTHONSTARTUP: "/tmp/evil.py",
      PYTHONUSERBASE: "/tmp/evil",
      PYTHONBREAKPOINT: "evil.breakpoint",
      PYTHONPYCACHEPREFIX: "/tmp/evil",
      PYTHONPRESITE: "evil_presite",
    },
    () => {
      const { env, cleanup } = buildSanitizedTerminalEnv();
      try {
        for (
          const name of [
            "PYTHONPATH",
            "PYTHONHOME",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "PYTHONBREAKPOINT",
            "PYTHONPYCACHEPREFIX",
            "PYTHONPRESITE",
          ]
        ) {
          assert.equal(env[name], undefined, `${name} must be stripped`);
        }
      } finally {
        cleanup();
      }
    },
  );
});

test("strips Node runtime/module-loading variables", async () => {
  await withEnv(
    {
      NODE_OPTIONS: "--require=/tmp/evil.js",
      NODE_PATH: "/tmp/evil",
      NODE_EXTRA_CA_CERTS: "/tmp/evil.pem",
      NODE_V8_COVERAGE: "/tmp/evil",
      NODE_ICU_DATA: "/tmp/evil",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    () => {
      const { env, cleanup } = buildSanitizedTerminalEnv();
      try {
        for (
          const name of [
            "NODE_OPTIONS",
            "NODE_PATH",
            "NODE_EXTRA_CA_CERTS",
            "NODE_V8_COVERAGE",
            "NODE_ICU_DATA",
            "NODE_TLS_REJECT_UNAUTHORIZED",
          ]
        ) {
          assert.equal(env[name], undefined, `${name} must be stripped`);
        }
      } finally {
        cleanup();
      }
    },
  );
});

test("strips npm/pip/pytest/Ruff configuration namespaces but preserves npm lifecycle vars", async () => {
  await withEnv(
    {
      npm_config_registry: "http://evil.example/",
      NPM_CONFIG_USERCONFIG: "/tmp/evil/.npmrc",
      PIP_INDEX_URL: "http://evil.example/simple",
      PIP_CONFIG_FILE: "/tmp/evil/pip.conf",
      PYTEST_ADDOPTS: "-p evil_plugin",
      PYTEST_PLUGINS: "evil_plugin",
      RUFF_CACHE_DIR: "/tmp/evil",
      // npm's own lifecycle metadata (created by npm itself, not a
      // configuration override) - must survive.
      npm_package_name: "sentinel-project",
      npm_lifecycle_event: "test",
    },
    () => {
      const { env, cleanup } = buildSanitizedTerminalEnv();
      try {
        for (
          const name of [
            "npm_config_registry",
            "NPM_CONFIG_USERCONFIG",
            "PIP_INDEX_URL",
            "PIP_CONFIG_FILE",
            "PYTEST_ADDOPTS",
            "PYTEST_PLUGINS",
            "RUFF_CACHE_DIR",
          ]
        ) {
          assert.equal(env[name], undefined, `${name} must be stripped`);
        }
        assert.equal(env.npm_package_name, "sentinel-project");
        assert.equal(env.npm_lifecycle_event, "test");
      } finally {
        cleanup();
      }
    },
  );
});

test("strips proxy/TLS variables", async () => {
  await withEnv(
    {
      HTTP_PROXY: "http://evil.example:8080",
      HTTPS_PROXY: "http://evil.example:8080",
      ALL_PROXY: "http://evil.example:8080",
      NO_PROXY: "evil.example",
      http_proxy: "http://evil.example:8080",
      https_proxy: "http://evil.example:8080",
      SSL_CERT_FILE: "/tmp/evil.pem",
      SSL_CERT_DIR: "/tmp/evil",
      REQUESTS_CA_BUNDLE: "/tmp/evil.pem",
      CURL_CA_BUNDLE: "/tmp/evil.pem",
    },
    () => {
      const { env, cleanup } = buildSanitizedTerminalEnv();
      try {
        for (
          const name of [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "REQUESTS_CA_BUNDLE",
            "CURL_CA_BUNDLE",
          ]
        ) {
          assert.equal(env[name], undefined, `${name} must be stripped`);
        }
      } finally {
        cleanup();
      }
    },
  );
});


test("blocks npm global/config/cache overrides and pip external targets", async () => {
  const npmGlobal = await runCommand("npm install --global example", true);
  assert.match(String(npmGlobal.error), /not permitted/i);

  const npmConfig = await runCommand("npm install --userconfig /tmp/evil.npmrc example", true);
  assert.match(String(npmConfig.error), /not permitted/i);

  const pipTarget = await runCommand("pip install --target /tmp/evil example", true);
  assert.match(String(pipTarget.error), /outside the project|execution boundary/i);

  const pipUser = await runCommand("pip install --user example", true);
  assert.match(String(pipUser.error), /not permitted/i);
});


test("isolates HOME/USERPROFILE/XDG_CONFIG_HOME to a fresh empty directory and cleans up", () => {
  const { env, cleanup } = buildSanitizedTerminalEnv();
  const home = env.HOME;
  try {
    assert.ok(home, "HOME must be set");
    assert.notEqual(home, process.env.HOME);
    assert.equal(env.USERPROFILE, home);
    assert.ok(existsSync(home!), "isolated HOME must exist on disk");
    assert.ok(env.XDG_CONFIG_HOME!.startsWith(home!));
    assert.ok(existsSync(env.XDG_CONFIG_HOME!));
    assert.equal(env.XDG_CONFIG_DIRS, undefined);
  } finally {
    cleanup();
  }
  assert.equal(existsSync(home!), false, "cleanup must remove the isolated HOME");
});

test("each invocation gets its own isolated HOME directory", () => {
  const first = buildSanitizedTerminalEnv();
  const second = buildSanitizedTerminalEnv();
  try {
    assert.notEqual(first.env.HOME, second.env.HOME);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("leaves unrelated variables untouched", async () => {
  await withEnv({ MY_APP_SETTING: "keep-me" }, () => {
    const { env, cleanup } = buildSanitizedTerminalEnv();
    try {
      assert.equal(env.MY_APP_SETTING, "keep-me");
      assert.ok(env.PATH, "PATH must be preserved");
    } finally {
      cleanup();
    }
  });
});

// --- End-to-end: prove runCommand() actually wires the sanitized
// --- environment through to the real spawned subprocess tree, and that a
// --- CONFIRMED execution-risk command is not exempt from it.

test("npm test does not leak sensitive/config env vars into the real subprocess, even when confirmed", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "terminal-env-isolation-"));
  const marker = join(projectRoot, "env-dump.json");

  writeFileSync(
    join(projectRoot, "package.json"),
    JSON.stringify({
      name: "env-isolation-probe",
      version: "1.0.0",
      scripts: { test: "node dump-env.js" },
    }),
  );
  writeFileSync(
    join(projectRoot, "dump-env.js"),
    [
      'const fs = require("fs");',
      "fs.writeFileSync(",
      `  ${JSON.stringify(marker)},`,
      "  JSON.stringify({",
      "    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,",
      "    PYTHONPATH: process.env.PYTHONPATH ?? null,",
      "    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,",
      "    HTTP_PROXY: process.env.HTTP_PROXY ?? null,",
      "    npm_config_registry: process.env.npm_config_registry ?? null,",
      "    KEEP_ME: process.env.KEEP_ME ?? null,",
      "  }),",
      ");",
      "",
    ].join("\n"),
  );

  __setProjectRootForTests(projectRoot);

  try {
    await withEnv(
      {
        OPENAI_API_KEY: "sk-sentinel-should-not-leak",
        PYTHONPATH: "/tmp/evil",
        NODE_OPTIONS: "--require=/tmp/evil.js",
        HTTP_PROXY: "http://evil.example:8080",
        npm_config_registry: "http://evil.example/",
        KEEP_ME: "still-here",
      },
      async () => {
        // "npm test" is an execution-risk prefix: pass confirm=true to
        // prove the sanitized environment applies on the confirmed path
        // too, not only to the pre-confirmation preview.
        const result = await runCommand("npm test", true);
        assert.ok(result, "runCommand must return a result");
        if (result && "error" in result && result.error) {
          assert.fail(`npm test failed unexpectedly: ${result.error}`);
        }
      },
    );

    assert.ok(
      existsSync(marker),
      "dump-env.js must have run and written the marker",
    );
    const dumped = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(dumped.OPENAI_API_KEY, null);
    assert.equal(dumped.PYTHONPATH, null);
    assert.equal(dumped.NODE_OPTIONS, null);
    assert.equal(dumped.HTTP_PROXY, null);
    assert.equal(dumped.npm_config_registry, null);
    assert.equal(dumped.KEEP_ME, "still-here");
  } finally {
    __resetProjectRootForTests();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
