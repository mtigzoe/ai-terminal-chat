import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
  isCommandAllowed,
  isForbiddenPrefix,
  runCommand,
} from "./terminal.ts";
import { isToolError } from "./types.ts";

test("git remote inspection is not part of the default terminal allowlist", () => {
  assert.ok(!DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git remote -v"));
  assert.equal(isCommandAllowed("git remote -v"), false);
});

test("git remote prefixes are forbidden so persisted config cannot re-enable them", () => {
  assert.equal(isForbiddenPrefix("git remote"), true);
  assert.equal(isForbiddenPrefix("git remote -v"), true);
});

test("runCommand rejects git remote -v before it can expose credential-bearing URLs", async () => {
  const result = await runCommand("git remote -v");
  assert.ok(isToolError(result));
  assert.match(result.error, /not allowed|safety/i);
});
