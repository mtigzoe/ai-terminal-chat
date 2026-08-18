import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKED_COMMAND_PATTERNS,
  DANGEROUS_COMMAND_CHARACTERS,
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
  isCommandAllowed,
  tokenizeCommand,
} from "./terminal.js";

void BLOCKED_COMMAND_PATTERNS;
void DANGEROUS_COMMAND_CHARACTERS;

test("default terminal allowlist includes safe Git inspection commands", () => {
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git status"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git diff"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git log"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git branch"));
  assert.equal(isCommandAllowed("git status --short"), true);
  assert.equal(isCommandAllowed("git status && whoami"), false);
});

test("terminal allowlist uses complete prefixes rather than partial words", () => {
  assert.equal(isCommandAllowed("git status --short"), true);
  assert.equal(isCommandAllowed("git statusx"), false);
  assert.equal(isCommandAllowed("npm test -- --run"), true);
  assert.equal(isCommandAllowed("npm testing"), false);
});

test("tokenizeCommand handles quoted arguments without invoking a shell", () => {
  assert.deepEqual(tokenizeCommand('git diff -- "client file.ts"'), [
    "git",
    "diff",
    "--",
    "client file.ts",
  ]);
  assert.deepEqual(tokenizeCommand("npm test -- --grep 'project tree'"), [
    "npm",
    "test",
    "--",
    "--grep",
    "project tree",
  ]);
});

test("tokenizeCommand rejects unterminated quotes", () => {
  assert.throws(() => tokenizeCommand('git log "unterminated'), /Unterminated quote/);
});
