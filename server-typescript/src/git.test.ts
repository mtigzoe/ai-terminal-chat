import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { __setProjectRootForTests, getProjectRoot, runWithAllowedReadPaths } from "./security.js";
import { gitAdd, gitBranch, gitDiff, gitLog, gitStatus, runIsolatedGit } from "./git.js";

let originalProjectRoot: string;

beforeEach(() => {
  originalProjectRoot = getProjectRoot();
  __setProjectRootForTests(process.cwd());
});

afterEach(() => {
  __setProjectRootForTests(originalProjectRoot);
});

test("gitStatus returns structured status output", async () => {
  const result = await gitStatus();
  assert.equal("error" in result, false);
  if (!("error" in result)) {
    assert.equal(typeof result.status, "string");
    assert.equal(typeof result.truncated, "boolean");
  }
});

test("gitBranch returns structured branch output", async () => {
  const result = await gitBranch();
  assert.equal("error" in result, false);
  if (!("error" in result)) {
    assert.equal(typeof result.branches, "string");
    assert.equal(typeof result.truncated, "boolean");
  }
});

test("gitLog clamps the requested commit count", async () => {
  const result = await gitLog(0);
  assert.equal("error" in result, false);
  if (!("error" in result)) {
    assert.equal(typeof result.log, "string");
  }
});

test("gitDiff rejects an absolute path", async () => {
  const result = await gitDiff("C:\\Windows\\System32\\drivers\\etc\\hosts");
  assert.equal("error" in result, true);
});

test("gitAdd previews staging and does not mutate without confirmation", async () => {
  const result = await gitAdd("src/git.test.ts");
  assert.equal("requires_confirmation" in result, true);
  if ("requires_confirmation" in result) {
    assert.equal(result.requires_confirmation, true);
    assert.equal(result.path, join("src", "git.test.ts"));
  }
});

test("gitAdd rejects paths outside the allowed read selection", async () => {
  await runWithAllowedReadPaths(["src/security.ts"], async () => {
    const result = await gitAdd("src/git.test.ts");
    assert.equal("error" in result, true);
    if ("error" in result) {
      const errorMessage = String(result.error);
      assert.ok(errorMessage.toLowerCase().includes("not selected"), `unexpected error: ${errorMessage}`);
    }
  });
});


test("runIsolatedGit ignores inherited Git repository and transport environment", async () => {
  const original = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    GIT_SSH: process.env.GIT_SSH,
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    GIT_SSH_VARIANT: process.env.GIT_SSH_VARIANT,
    GIT_SSL_NO_VERIFY: process.env.GIT_SSL_NO_VERIFY,
    GIT_PROXY_COMMAND: process.env.GIT_PROXY_COMMAND,
  };
  process.env.GIT_DIR = join(process.cwd(), "definitely-not-this-repository");
  process.env.GIT_WORK_TREE = join(process.cwd(), "outside-worktree");
  process.env.GIT_INDEX_FILE = join(process.cwd(), "outside-index");
  process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=true'";
  process.env.GIT_SSH = "outside-ssh";
  process.env.GIT_SSH_COMMAND = "outside-ssh-command";
  process.env.GIT_SSH_VARIANT = "simple";
  process.env.GIT_SSL_NO_VERIFY = "1";
  process.env.GIT_PROXY_COMMAND = "outside-proxy";
  try {
    const result = await runIsolatedGit(["rev-parse", "--show-toplevel"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), resolve(process.cwd(), ".."));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});