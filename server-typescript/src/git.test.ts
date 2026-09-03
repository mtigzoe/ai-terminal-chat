import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { __setProjectRootForTests, getProjectRoot, runWithAllowedReadPaths } from "./security.js";
import { gitAdd, gitBranch, gitDiff, gitLog, gitStatus } from "./git.js";

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
