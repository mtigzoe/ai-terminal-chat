import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
  isCommandAllowed,
  isForbiddenPrefix,
  runCommand,
  sanitizeGitRemoteOutput,
} from "./terminal.ts";
import { isToolError } from "./types.ts";

test("git remote -v is allowed by default for read-only remote inspection", () => {
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git remote -v"));
  assert.equal(isCommandAllowed("git remote -v"), true);
  assert.equal(isForbiddenPrefix("git remote -v"), false);
});

test("bare 'git remote' and mutating remote subcommands stay forbidden", () => {
  assert.equal(isForbiddenPrefix("git remote"), true);
  for (const mutating of [
    "git remote add",
    "git remote set-url",
    "git remote remove",
    "git remote rename",
    "git remote set-head",
  ]) {
    assert.equal(isForbiddenPrefix(mutating), true, mutating);
  }
});

test("runCommand rejects mutating git remote subcommands before they can rewrite remote config", async () => {
  const result = await runCommand(
    "git remote add evil https://evil.example/repo.git",
  );
  assert.ok(isToolError(result));
  assert.match(result.error, /not allowed|safety/i);
});

test("git remote output is sanitized so credential-bearing URLs never reach the model", () => {
  const output = "origin\thttps://user:token@example.com/owner/repo.git (fetch)";
  const sanitized = sanitizeGitRemoteOutput(output);
  assert.equal(sanitized, "origin\thttps://example.com/owner/repo.git (fetch)");
  assert.ok(!sanitized.includes("token"));
});
