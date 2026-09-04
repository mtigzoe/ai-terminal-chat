import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  __setAllowedCommandsForTests,
  addAllowedCommand,
  isForbiddenPrefix,
  persistAllowedCommands,
  reloadAllowedCommands,
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
  BLOCKED_COMMAND_PATTERNS,
  DANGEROUS_COMMAND_CHARACTERS,
  isCommandAllowed,
  runCommand,
  tokenizeCommand,
} from "./terminal.ts";
import { __setProjectRootForTests, __resetProjectRootForTests, runWithAllowedReadPaths } from "./security.ts";

void BLOCKED_COMMAND_PATTERNS;
void DANGEROUS_COMMAND_CHARACTERS;

// Restore the default allowlist after every test so mutations do not leak
// into other test files that share the same process/module cache.
test.afterEach(() => {
  // Write the known-good defaults back to disk so a stale config file
  // from a previous test run cannot pollute subsequent test files,
  // then reload into memory.
  persistAllowedCommands([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  reloadAllowedCommands();
  __resetProjectRootForTests();
});

let gitShowTestDir: string;

test.beforeEach(() => {
  // Set up a throwaway git repository for git show permission tests.
  gitShowTestDir = mkdtempSync(join(tmpdir(), "git-show-test-"));
  execSync("git init", { cwd: gitShowTestDir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: gitShowTestDir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: gitShowTestDir, stdio: "ignore" });
  writeFileSync(join(gitShowTestDir, "README.md"), "# README\n");
  writeFileSync(join(gitShowTestDir, "other.md"), "# Other\n");
  execSync("git add .", { cwd: gitShowTestDir, stdio: "ignore" });
  execSync("git commit -m initial", { cwd: gitShowTestDir, stdio: "ignore" });
  __setProjectRootForTests(gitShowTestDir);
});

test.afterEach(() => {
  if (gitShowTestDir) {
    try {
      rmSync(gitShowTestDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  __resetProjectRootForTests();
});

// ---------------------------------------------------------------------------
// git show read-permission regression tests
// ---------------------------------------------------------------------------

test("git show HEAD is denied when read restrictions are active (shows full diff)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show HEAD");
    assert.ok(result.error, "git show HEAD must be denied when no files are selected");
    assert.ok(result.error.includes("Access denied"), "error must mention Access denied");
  });
});

test("git show --stat HEAD is allowed even when read restrictions are active", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --stat HEAD");
    assert.ok(!result.error, "git show --stat HEAD must be allowed: --stat shows no file contents");
  });
});

test("git show --no-patch HEAD is allowed even when read restrictions are active", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --no-patch HEAD");
    assert.ok(!result.error, "git show --no-patch HEAD must be allowed: no file contents shown");
  });
});

test("git show HEAD:README.md is allowed when README.md is selected", async () => {
  await runWithAllowedReadPaths(["README.md"], async () => {
    const result = await runCommand("git show HEAD:README.md");
    assert.ok(!result.error, "git show HEAD:README.md must be allowed when README.md is selected");
  });
});

test("git show HEAD:README.md is denied when README.md is not selected", async () => {
  await runWithAllowedReadPaths(["other.md"], async () => {
    const result = await runCommand("git show HEAD:README.md");
    assert.ok(result.error, "git show HEAD:README.md must be denied when README.md is not selected");
    assert.ok(result.error.includes("Access denied"), "error must mention Access denied");
  });
});

test("git show HEAD -- README.md is allowed when README.md is selected", async () => {
  await runWithAllowedReadPaths(["README.md"], async () => {
    const result = await runCommand("git show HEAD -- README.md");
    assert.ok(!result.error, "git show HEAD -- README.md must be allowed when README.md is selected");
  });
});

test("git show HEAD -- README.md is denied when README.md is not selected", async () => {
  await runWithAllowedReadPaths(["other.md"], async () => {
    const result = await runCommand("git show HEAD -- README.md");
    assert.ok(result.error, "git show HEAD -- README.md must be denied when README.md is not selected");
    assert.ok(result.error.includes("Access denied"), "error must mention Access denied");
  });
});

// Bypass regression tests: content-producing flags must not slip through.
test("git show --oneline HEAD is denied (shows full patch despite --oneline)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --oneline HEAD");
    assert.ok(result.error, "--oneline must not bypass the permission check");
  });
});

test("git show --stat --patch HEAD is denied (--patch overrides --stat)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --stat --patch HEAD");
    assert.ok(result.error, "--stat --patch must not bypass the permission check");
  });
});

test("git show --no-patch --patch HEAD is denied (--patch overrides --no-patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --no-patch --patch HEAD");
    assert.ok(result.error, "--no-patch --patch must not bypass the permission check");
  });
});

test("git show --format=oneline HEAD is denied (--format shows patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --format=oneline HEAD");
    assert.ok(result.error, "--format=oneline must not bypass the permission check");
  });
});

test("git show --name-only --patch HEAD is allowed (--name-only suppresses patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --name-only --patch HEAD");
    assert.ok(!result.error, "--name-only --patch must be allowed: no file contents shown");
  });
});

test("git show --name-status --patch HEAD is allowed (--name-status suppresses patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --name-status --patch HEAD");
    assert.ok(!result.error, "--name-status --patch must be allowed: no file contents shown");
  });
});

test("default terminal allowlist defines the expected safe Git inspection commands", () => {
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git status"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git diff"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git log"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git branch"));
});

test("terminal allowlist uses complete prefixes rather than partial words", () => {
  __setAllowedCommandsForTests(["git status", "npm test"]);
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

// ---------------------------------------------------------------------------
// isCommandAllowed regression tests
// ---------------------------------------------------------------------------

test("isCommandAllowed: exact safe prefixes are accepted", () => {
  __setAllowedCommandsForTests(["git status", "git branch", "npm test"]);
  assert.equal(isCommandAllowed("git status"), true);
  assert.equal(isCommandAllowed("git branch"), true);
  assert.equal(isCommandAllowed("npm test"), true);
});

test("isCommandAllowed: safe prefixes accept additional arguments", () => {
  __setAllowedCommandsForTests(["git status", "git branch", "npm test"]);
  assert.equal(isCommandAllowed("git status --short"), true);
  assert.equal(isCommandAllowed("git status -s"), true);
  assert.equal(isCommandAllowed("git branch --all"), true);
  assert.equal(isCommandAllowed("git branch -a"), true);
  assert.equal(isCommandAllowed("npm test -- --runInBand"), true);
  assert.equal(isCommandAllowed("npm test -- --grep 'project tree'"), true);
});

test("isCommandAllowed: near-miss prefixes that would enable forbidden commands are denied", () => {
  // "git status-evil" starts with "git status" but is not equal to it
  // and does not start with "git status " (the next char is '-'), so it
  // must not match the "git status" allowlist entry.
  __setAllowedCommandsForTests(["git status", "git branch", "npm test"]);
  assert.equal(isCommandAllowed("git status-evil"), false);
  assert.equal(isCommandAllowed("git branch-evil"), false);
  assert.equal(isCommandAllowed("npm testing"), false);
  assert.equal(isCommandAllowed("npm testx"), false);
});

test("isCommandAllowed: broad prefix that would enable forbidden commands is denied by isForbiddenPrefix", () => {
  // "git" is not in the default allowlist, but even if a user tried to
  // add it through the API it must be rejected by isForbiddenPrefix
  // because it would permit "git push", "git reset", etc.
  assert.throws(
    () => addAllowedCommand("git"),
    /not permitted for safety reasons/
  );
  // "rm" is in FORBIDDEN_ALLOWED_COMMAND_PREFIXES; even the broadest
  // interpretation must not allow it.
  assert.throws(
    () => addAllowedCommand("rm"),
    /not permitted for safety reasons/
  );
  // "npm" is intentionally not a forbidden prefix (safe subcommands
  // include "npm test", "npm run build", "npm install" etc.).
  assert.equal(
    isForbiddenPrefix("npm"),
    false,
    "npm must not be a forbidden prefix"
  );
});

test("isCommandAllowed: leading and trailing whitespace is ignored", () => {
  __setAllowedCommandsForTests(["git status", "npm test"]);
  assert.equal(isCommandAllowed("  git status"), true);
  assert.equal(isCommandAllowed("git status  "), true);
  assert.equal(isCommandAllowed("  git status  "), true);
  assert.equal(isCommandAllowed("\tgit status\t"), true);
});

test("isCommandAllowed: repeated whitespace and tabs between tokens are ignored", () => {
  __setAllowedCommandsForTests(["git status", "npm test"]);
  assert.equal(isCommandAllowed("git  status"), true);
  assert.equal(isCommandAllowed("git\tstatus"), true);
  assert.equal(isCommandAllowed("git  status  --short"), true);
  assert.equal(isCommandAllowed("npm\t test\t--\t--runInBand"), true);
});

test("isCommandAllowed: quoted arguments are handled without bypassing the allowlist", () => {
  __setAllowedCommandsForTests(["npm test"]);
  assert.equal(isCommandAllowed("npm test -- --grep 'project tree'"), true);
  assert.equal(isCommandAllowed('npm test -- --grep "project tree"'), true);
});

test("isCommandAllowed: shell operators embedded in the command string are tokenized as separate tokens (commandBlocked rejects the operator)", () => {
  // The tokenizer does not treat '&' or '|' as delimiters — they become
  // separate tokens. "git status && whoami" normalizes to the joined form
  // "git status && whoami" which does start with "git status " so
  // isCommandAllowed returns true. commandBlocked is the safety net.
  __setAllowedCommandsForTests(["git status", "npm test"]);
  assert.equal(isCommandAllowed("git status && whoami"), true);
  assert.equal(isCommandAllowed("git status | grep secret"), true);
  // ';' is not a delimiter in the tokenizer so "npm test;" produces the
  // single token "test;" which does not match "npm test " — a safe
  // incidental rejection; commandBlocked still catches it regardless.
  assert.equal(isCommandAllowed("npm test; rm -rf /"), false);
});

test("runCommand rejects chained/pipe/redirect commands even when the first token is allowlisted", async () => {
  const r1 = await runCommand("git status && whoami");
  assert.ok(r1.error, "&& chain must be rejected");
  const r2 = await runCommand("npm test; rm -rf /");
  assert.ok(r2.error, "; chain must be rejected");
  const r3 = await runCommand("git status | grep secret");
  assert.ok(r3.error, "pipe must be rejected");
  const r4 = await runCommand("git log > /tmp/leak.txt");
  assert.ok(r4.error, "redirect must be rejected");
  const r5 = await runCommand("git status `whoami`");
  assert.ok(r5.error, "backtick substitution must be rejected");
  const r6 = await runCommand("git status $(whoami)");
  assert.ok(r6.error, "$() substitution must be rejected");
});

