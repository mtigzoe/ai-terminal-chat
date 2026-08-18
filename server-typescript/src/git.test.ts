import { test } from "node:test";
import assert from "node:assert/strict";

import { gitAdd, gitBranch, gitDiff, gitLog, gitStatus } from "./git.js";

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
  const result = await gitAdd("git.test.ts");
  assert.equal("requires_confirmation" in result, true);
  if ("requires_confirmation" in result) {
    assert.equal(result.requires_confirmation, true);
    assert.equal(result.path, "git.test.ts");
  }
});
