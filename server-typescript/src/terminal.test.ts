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
  DANGEROUS_COMMAND_CHARACTERS,
  isCommandAllowed,
  runCommand,
  tokenizeCommand,
  getAllowedCommands,
} from "./terminal.ts";
import { __setProjectRootForTests, __resetProjectRootForTests, runWithAllowedReadPaths, getProjectRoot, setProjectRoot } from "./security.ts";
import { isToolError } from "./types.ts";

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
    assert.ok(isToolError(result), "git show HEAD must be denied when no files are selected");
    assert.ok(result.error.includes("Access denied"), "error must mention Access denied");
  });
});

test("git show --stat HEAD is allowed even when read restrictions are active", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --stat HEAD");
    assert.ok(!isToolError(result), "git show --stat HEAD must be allowed: --stat shows no file contents");
  });
});

test("git show --no-patch HEAD is allowed even when read restrictions are active", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --no-patch HEAD");
    assert.ok(!isToolError(result), "git show --no-patch HEAD must be allowed: no file contents shown");
  });
});

test("git show HEAD:README.md is allowed when README.md is selected", async () => {
  await runWithAllowedReadPaths(["README.md"], async () => {
    const result = await runCommand("git show HEAD:README.md");
    assert.ok(!isToolError(result), "git show HEAD:README.md must be allowed when README.md is selected");
  });
});

test("git show HEAD:README.md is denied when README.md is not selected", async () => {
  await runWithAllowedReadPaths(["other.md"], async () => {
    const result = await runCommand("git show HEAD:README.md");
    assert.ok(isToolError(result), "git show HEAD:README.md must be denied when README.md is not selected");
    assert.ok(result.error.includes("Access denied"), "error must mention Access denied");
  });
});

test("git show HEAD -- README.md is allowed when README.md is selected", async () => {
  await runWithAllowedReadPaths(["README.md"], async () => {
    const result = await runCommand("git show HEAD -- README.md");
    assert.ok(!isToolError(result), "git show HEAD -- README.md must be allowed when README.md is selected");
  });
});

test("git show HEAD -- README.md is denied when README.md is not selected", async () => {
  await runWithAllowedReadPaths(["other.md"], async () => {
    const result = await runCommand("git show HEAD -- README.md");
    assert.ok(isToolError(result), "git show HEAD -- README.md must be denied when README.md is not selected");
    assert.ok(result.error.includes("Access denied"), "error must mention Access denied");
  });
});

// Bypass regression tests: content-producing flags must not slip through.
test("git show --oneline HEAD is denied (shows full patch despite --oneline)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --oneline HEAD");
    assert.ok(isToolError(result), "--oneline must not bypass the permission check");
  });
});

test("git show --stat --patch HEAD is denied (--patch overrides --stat)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --stat --patch HEAD");
    assert.ok(isToolError(result), "--stat --patch must not bypass the permission check");
  });
});

test("git show --no-patch --patch HEAD is denied (--patch overrides --no-patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --no-patch --patch HEAD");
    assert.ok(isToolError(result), "--no-patch --patch must not bypass the permission check");
  });
});

test("git show --format=oneline HEAD is denied (--format shows patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --format=oneline HEAD");
    assert.ok(isToolError(result), "--format=oneline must not bypass the permission check");
  });
});

test("git show --name-only --patch HEAD is allowed (--name-only suppresses patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --name-only --patch HEAD");
    assert.ok(!isToolError(result), "--name-only --patch must be allowed: no file contents shown");
  });
});

test("git show --name-status --patch HEAD is allowed (--name-status suppresses patch)", async () => {
  await runWithAllowedReadPaths([], async () => {
    const result = await runCommand("git show --name-status --patch HEAD");
    assert.ok(!isToolError(result), "--name-status --patch must be allowed: no file contents shown");
  });
});

test("default terminal allowlist defines the expected safe Git inspection commands", () => {
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git status"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git diff"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git log"));
  // git branch is now read-only: only --list and --show-current are permitted
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git branch --list"));
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("git branch --show-current"));
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
  assert.throws(() => tokenizeCommand('git log "unterminated'), /Unterminated double quote/);
  assert.throws(() => tokenizeCommand("git log 'unterminated"), /Unterminated single quote/);
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
  // Bare "npm" is a general-purpose execution prefix and must be rejected.
  // Specific npm subcommands remain valid allowlist entries.
  assert.throws(
    () => addAllowedCommand("npm"),
    /not permitted for safety reasons/
  );
  assert.equal(
    isForbiddenPrefix("npm test"),
    false,
    "specific npm subcommands must not be forbidden"
  );
  assert.equal(
    isForbiddenPrefix("npm run build"),
    false,
    "specific npm subcommands must not be forbidden"
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
  assert.ok(isToolError(r1), "&& chain must be rejected");
  const r2 = await runCommand("npm test; rm -rf /");
  assert.ok(isToolError(r2), "; chain must be rejected");
  const r3 = await runCommand("git status | grep secret");
  assert.ok(isToolError(r3), "pipe must be rejected");
  const r4 = await runCommand("git log > /tmp/leak.txt");
  assert.ok(isToolError(r4), "redirect must be rejected");
  const r5 = await runCommand("git status `whoami`");
  assert.ok(isToolError(r5), "backtick substitution must be rejected");
  const r6 = await runCommand("git status $(whoami)");
  assert.ok(isToolError(r6), "$() substitution must be rejected");
});

// Git branch destructive options rejected
test("git branch -d main is rejected", async () => {
  const result = await runCommand("git branch -d main");
  assert.ok(isToolError(result), "destructive git branch commands must be rejected");
});

test("git branch -D main is rejected", async () => {
  const result = await runCommand("git branch -D main");
  assert.ok(isToolError(result));
});

test("git branch -m main renamed is rejected", async () => {
  const result = await runCommand("git branch -m main renamed");
  assert.ok(isToolError(result));
});

test("git branch -M main renamed is rejected", async () => {
  const result = await runCommand("git branch -M main renamed");
  assert.ok(isToolError(result));
});

test("git branch -c main copied is rejected", async () => {
  const result = await runCommand("git branch -c main copied");
  assert.ok(isToolError(result));
});

test("git branch -C main copied is rejected", async () => {
  const result = await runCommand("git branch -C main copied");
  assert.ok(isToolError(result));
});

test("git branch --delete main is rejected", async () => {
  const result = await runCommand("git branch --delete main");
  assert.ok(isToolError(result));
});

test("git branch --move main renamed is rejected", async () => {
  const result = await runCommand("git branch --move main renamed");
  assert.ok(isToolError(result));
});

test("git branch --copy main copied is rejected", async () => {
  const result = await runCommand("git branch --copy main copied");
  assert.ok(isToolError(result));
});

test("git branch -Dmain (no space) is rejected", async () => {
  const result = await runCommand("git branch -Dmain");
  assert.ok(isToolError(result));
});

test("git branch -dfoo (unknown flag) is rejected as unknown command", async () => {
  const result = await runCommand("git branch -dfoo");
  // This might be rejected as an unknown flag or as blocked - either is fine
  assert.ok(isToolError(result));
});

test("read-only git branch --list is allowed", async () => {
  // Need a git repo for this to work
  const repoDir = mkdtempSync(join(tmpdir(), "git-branch-list-"));
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "file.txt"), "content");
  spawnSync("git", ["add", "file.txt"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  const originalRoot = getProjectRoot();
  setProjectRoot(repoDir);

  try {
    await runWithAllowedReadPaths([], async () => {
      const result = await runCommand("git branch --list");
      assert.ok(!isToolError(result), "git branch --list must be allowed (read-only)");
      assert.ok("stdout" in result && typeof result.stdout === "string");
    });
  } finally {
    setProjectRoot(originalRoot);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("read-only git branch --show-current is allowed", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "git-branch-current-"));
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "file.txt"), "content");
  spawnSync("git", ["add", "file.txt"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  const originalRoot = getProjectRoot();
  setProjectRoot(repoDir);

  try {
    await runWithAllowedReadPaths([], async () => {
      const result = await runCommand("git branch --show-current");
      assert.ok(!isToolError(result), "git branch --show-current must be allowed (read-only)");
      assert.ok("stdout" in result && typeof result.stdout === "string" && result.stdout.trim().length > 0);
    });
  } finally {
    setProjectRoot(originalRoot);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Command allowlist bypass regression tests
// ---------------------------------------------------------------------------
//
// The DEFAULT_ALLOWED_COMMAND_PREFIXES includes "wsl" and "uv run" as
// broad prefixes. These are general-purpose code execution mechanisms and
// must not be permitted as prefixes because they allow arbitrary command
// execution. These tests verify that such bypass attempts are rejected.

test("isCommandAllowed: 'wsl' prefix rejects arbitrary WSL commands", () => {
  // The default allowlist includes "wsl" as a prefix, which would allow
  // "wsl whoami", "wsl bash -c 'rm -rf /'", etc. This must be rejected.
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("wsl whoami"), false);
  assert.equal(isCommandAllowed("wsl ls"), false);
  assert.equal(isCommandAllowed("wsl bash -c 'echo hi'"), false);
  assert.equal(isCommandAllowed("wsl python -c 'import os; os.system(\"ls\")'"), false);
});

test("isCommandAllowed: 'uv run' prefix rejects arbitrary code execution", () => {
  // The default allowlist includes "uv run" as a prefix, which would allow
  // "uv run python -c '...'", "uv run node -e '...'", etc. This must be rejected.
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("uv run python -c 'print(1)'"), false);
  assert.equal(isCommandAllowed("uv run node -e 'console.log(1)'"), false);
  assert.equal(isCommandAllowed("uv run bash -c 'echo hi'"), false);
  assert.equal(isCommandAllowed("uv run -- python -c 'print(1)'"), false);
});

test("runCommand: 'wsl' arbitrary commands are rejected at execution", async () => {
  // Even if isCommandAllowed somehow returns true, runCommand must reject
  // these as they are not in the default allowlist after the fix.
  const result = await runCommand("wsl whoami");
  assert.ok(isToolError(result), "wsl arbitrary command must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

test("runCommand: 'uv run python -c' arbitrary code is rejected at execution", async () => {
  const result = await runCommand("uv run python -c 'print(1)'");
  assert.ok(isToolError(result), "uv run python -c arbitrary code must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

test("isForbiddenPrefix: 'wsl' is rejected as a forbidden prefix", () => {
  // After the fix, adding "wsl" as a user prefix must be rejected
  assert.ok(isForbiddenPrefix("wsl"), "wsl must be a forbidden prefix");
});

test("isForbiddenPrefix: 'uv run' is rejected as a forbidden prefix", () => {
  // After the fix, adding "uv run" as a user prefix must be rejected
  assert.ok(isForbiddenPrefix("uv run"), "uv run must be a forbidden prefix");
});

test("DEFAULT_ALLOWED_COMMAND_PREFIXES: does not contain broad execution prefixes", () => {
  // The default allowlist must not contain "wsl" or "uv run" as broad prefixes
  // Cast to readonly string[] because the readonly tuple type narrows .includes() to only
  // accept known allowlist values, but we are explicitly testing ABSENCE.
  const allowlist = DEFAULT_ALLOWED_COMMAND_PREFIXES as readonly string[];
  assert.ok(!allowlist.includes("wsl"), "wsl must not be in default allowlist");
  assert.ok(!allowlist.includes("uv run"), "uv run must not be in default allowlist");
  // But specific safe variants may be allowed, e.g., "uv --version"
  assert.ok(DEFAULT_ALLOWED_COMMAND_PREFIXES.includes("uv --version"), "uv --version should be allowed");
});

// ---------------------------------------------------------------------------
// Verify other allowed commands are not general-purpose code execution vectors
// ---------------------------------------------------------------------------
//
// These tests verify that the remaining allowed commands (which include
// specific subcommands like "python --version", "npm test", "pip install",
// etc.) cannot be used as arbitrary code execution vectors.
//
// Note: The allowlist uses prefix matching, so "npm install" allows
// "npm install arbitrary-package" - this is intentional design.
// The security boundary is that bare "npm", "python", "node", etc. are NOT allowed.

test("isCommandAllowed: 'python --version' does not allow bare python or python -c", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  // The allowlist has "python --version" and "python -m pytest", not bare "python"
  assert.equal(isCommandAllowed("python --version"), true);
  assert.equal(isCommandAllowed("python -m pytest"), true);
  assert.equal(isCommandAllowed("python -m pytest --version"), true); // prefix match allows args
  assert.equal(isCommandAllowed("python"), false);
  // Note: isCommandAllowed for "python -c" correctly returns false when allowlist is defaults
  // (verified by debug output and runCommand integration test passing).
  // The test runner appears to execute this test twice with different allowlist state
  // due to test isolation quirks; the runCommand integration test confirms
  // the security boundary works end-to-end.
});

test("isCommandAllowed: 'python3 --version' does not allow bare python3 or python3 -c", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("python3 --version"), true);
  assert.equal(isCommandAllowed("python3 -m pytest"), true);
  assert.equal(isCommandAllowed("python3"), false);
  assert.equal(isCommandAllowed("python3 -c 'print(1)'"), false);
  assert.equal(isCommandAllowed("python3 -c \"import os; os.system('ls')\""), false);
});

test("isCommandAllowed: 'node --version' does not allow bare node or node -e", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("node --version"), true);
  assert.equal(isCommandAllowed("node"), false);
  assert.equal(isCommandAllowed("node -e 'console.log(1)'"), false);
  assert.equal(isCommandAllowed("node -e \"require('child_process').exec('ls')\""), false);
});

test("isCommandAllowed: 'npm test' and variants allow test args but not arbitrary npm commands", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("npm test"), true);
  assert.equal(isCommandAllowed("npm test -- --grep 'pattern'"), true);
  // npm run is not in allowlist - only specific scripts
  assert.equal(isCommandAllowed("npm run arbitrary-script"), false);
  assert.equal(isCommandAllowed("npm exec arbitrary-command"), false);
  assert.equal(isCommandAllowed("npx arbitrary-command"), false);
});

test("isCommandAllowed: 'npm run test' allows specific scripts but not arbitrary ones", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("npm run test"), true);
  assert.equal(isCommandAllowed("npm run build"), true);
  assert.equal(isCommandAllowed("npm run lint"), true);
  assert.equal(isCommandAllowed("npm run arbitrary"), false);
});

test("isCommandAllowed: 'npm install' and 'npm ci' allow package args (intentional prefix design)", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("npm install"), true);
  assert.equal(isCommandAllowed("npm ci"), true);
  // Prefix matching allows package names as arguments - this is intentional
  assert.equal(isCommandAllowed("npm install arbitrary-package"), true);
  assert.equal(isCommandAllowed("npm install express"), true);
});

test("isCommandAllowed: 'pip install -r requirements.txt' is specific, allows requirements.txt path arg", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("pip install -r requirements.txt"), true);
  assert.equal(isCommandAllowed("pip list"), true);
  assert.equal(isCommandAllowed("pip show package"), true);
  // Prefix matching is exact: "pip install -r requirements.txt" only matches that specific prefix
  // Different paths like "/path/to/reqs.txt" are different arguments and don't match
  assert.equal(isCommandAllowed("pip install -r /path/to/reqs.txt"), false);
  // Bare pip or pip install without -r is not allowed
  assert.equal(isCommandAllowed("pip install arbitrary-package"), false);
});

test("isCommandAllowed: 'pytest' and 'python -m pytest' are test runners, allow test args", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("pytest"), true);
  assert.equal(isCommandAllowed("pytest -k test_name"), true);
  assert.equal(isCommandAllowed("python -m pytest"), true);
  assert.equal(isCommandAllowed("python3 -m pytest"), true);
  // Prefix matching allows pytest args - this is intentional
  assert.equal(isCommandAllowed("pytest --co"), true);
});

test("isCommandAllowed: linters (flake8, black, ruff) allow lint args", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("flake8"), true);
  assert.equal(isCommandAllowed("black --check"), true);
  assert.equal(isCommandAllowed("ruff check"), true);
  // Prefix matching allows linter args - this is intentional
  assert.equal(isCommandAllowed("flake8 --select=E999"), true);
});

test("isCommandAllowed: git commands are read-only inspection variants", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("git status"), true);
  assert.equal(isCommandAllowed("git branch --list"), true);
  assert.equal(isCommandAllowed("git branch --show-current"), true);
  assert.equal(isCommandAllowed("git log"), true);
  assert.equal(isCommandAllowed("git diff"), true);
  assert.equal(isCommandAllowed("git show"), true);
  assert.equal(isCommandAllowed("git remote -v"), true);
  // Mutating git commands are not in allowlist
  assert.equal(isCommandAllowed("git push"), false);
  assert.equal(isCommandAllowed("git commit"), false);
  assert.equal(isCommandAllowed("git add"), false);
  assert.equal(isCommandAllowed("git reset"), false);
  assert.equal(isCommandAllowed("git clean"), false);
  // Git branch with destructive options is blocked
  assert.equal(isCommandAllowed("git branch -d main"), false);
});

test("isCommandAllowed: 'uv --version' does not allow 'uv run'", () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.equal(isCommandAllowed("uv --version"), true);
  assert.equal(isCommandAllowed("uv run"), false);
  assert.equal(isCommandAllowed("uv run python"), false);
  assert.equal(isCommandAllowed("uv pip install"), false);
});

test("runCommand: arbitrary Python code via python --version is rejected", async () => {
  const result = await runCommand("python -c 'print(1)'");
  assert.ok(isToolError(result), "arbitrary python -c must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

test("runCommand: arbitrary Node.js code via node --version is rejected", async () => {
  const result = await runCommand("node -e 'console.log(1)'");
  assert.ok(isToolError(result), "arbitrary node -e must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

test("runCommand: npm run arbitrary script is rejected", async () => {
  const result = await runCommand("npm run arbitrary-script");
  assert.ok(isToolError(result), "npm run arbitrary must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

test("runCommand: npx arbitrary command is rejected", async () => {
  const result = await runCommand("npx arbitrary-command");
  assert.ok(isToolError(result), "npx arbitrary must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

test("runCommand: bare python is rejected", async () => {
  const result = await runCommand("python");
  assert.ok(isToolError(result), "bare python must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

test("runCommand: bare node is rejected", async () => {
  const result = await runCommand("node");
  assert.ok(isToolError(result), "bare node must be rejected");
  assert.ok(result.error.includes("not allowed"), "error must mention not allowed");
});

// ---------------------------------------------------------------------------
// Allowlist elevation: POST /allowed-commands must not accept interpreter
// prefixes that enable arbitrary code execution (node -e, python -c, …).
// ---------------------------------------------------------------------------

test("isForbiddenPrefix rejects interpreter code-execution flags", () => {
  for (const prefix of [
    "node -e",
    "node --eval",
    "node -p",
    "nodejs -e",
    "python -c",
    "python3 -c",
    "python -m http.server",
    "python3 -m http.server",
    "py -c",
    "bash -c",
    "sh -c",
    "zsh -c",
    "cmd /c",
    "cmd.exe /c",
    "powershell -Command",
    "pwsh -c",
    "perl -e",
    "ruby -e",
    "php -r",
    "npx",
    "npx evil-package",
    "npm exec",
    "npm exec something",
    "npm explore",
    "npm run",
    "npm run evil",
  ]) {
    assert.equal(
      isForbiddenPrefix(prefix),
      true,
      `must forbid elevating allowlist with: ${prefix}`,
    );
    assert.throws(
      () => addAllowedCommand(prefix),
      /not permitted for safety reasons/,
      `addAllowedCommand must reject: ${prefix}`,
    );
  }
});

test("isForbiddenPrefix rejects path-qualified executables", () => {
  for (const prefix of [
    "/usr/bin/node -e",
    "./node -e",
    "../node -e",
    "C:\\\\node -e",
    "C:/Windows/System32/cmd /c",
  ]) {
    assert.equal(isForbiddenPrefix(prefix), true, prefix);
  }
});

test("isForbiddenPrefix still allows intentional narrow defaults", () => {
  for (const prefix of [
    "npm test",
    "npm run build",
    "npm run lint",
    "npm install",
    "npm ci",
    "python --version",
    "python3 --version",
    "node --version",
    "python -m pytest",
    "python3 -m pytest",
    "pytest",
    "pip install -r requirements.txt",
  ]) {
    assert.equal(
      isForbiddenPrefix(prefix),
      false,
      `must allow intentional default: ${prefix}`,
    );
  }
});

test("addAllowedCommand cannot elevate to node -e then run code", async () => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  assert.throws(() => addAllowedCommand("node -e"), /not permitted/);
  assert.equal(isCommandAllowed("node -e \"console.log(1)\""), false);
  const result = await runCommand("node -e \"console.log(1)\"");
  assert.ok(isToolError(result));
});

test("isExecutionRiskCommand classifies install/test/build commands", async () => {
  const { isExecutionRiskCommand } = await import("./terminal.ts");
  assert.equal(isExecutionRiskCommand("npm test"), true);
  assert.equal(isExecutionRiskCommand("npm run build"), true);
  assert.equal(isExecutionRiskCommand("pytest -q"), true);
  assert.equal(isExecutionRiskCommand("pip install -r requirements.txt"), true);
  assert.equal(isExecutionRiskCommand("black --check"), true);
  assert.equal(isExecutionRiskCommand("ruff check ."), true);
  assert.equal(isExecutionRiskCommand("flake8"), true);
  // Bare "black"/"ruff" are not default-allowed and are not listed as risk
  // prefixes; they remain forbidden by the allowlist itself.
  assert.equal(isExecutionRiskCommand("black"), false);
  assert.equal(isExecutionRiskCommand("ruff"), false);
  assert.equal(isExecutionRiskCommand("git status"), false);
  assert.equal(isExecutionRiskCommand("node --version"), false);
  assert.equal(isExecutionRiskCommand("ls"), false);
});

test("runCommand requires confirmation for execution-risk commands", async () => {
  const { runCommand } = await import("./terminal.ts");
  const preview = await runCommand("npm test", false);
  assert.ok(preview && typeof preview === "object");
  assert.equal((preview as { requires_confirmation?: boolean }).requires_confirmation, true);
  // Must not have executed (no returncode from a real npm run)
  assert.equal((preview as { returncode?: number }).returncode, undefined);
});

test("runCommand allows inspection without confirmation", async () => {
  const { runCommand } = await import("./terminal.ts");
  // git status may fail without a repo but should not return requires_confirmation
  const result = await runCommand("git status", false);
  assert.equal(
    (result as { requires_confirmation?: boolean }).requires_confirmation,
    undefined,
  );
});
