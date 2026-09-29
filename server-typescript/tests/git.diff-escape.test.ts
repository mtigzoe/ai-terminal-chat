import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runCommand, addAllowedCommand } from "../src/terminal.ts";
import { GIT_CONFIG_OVERRIDES, gitDiff } from "../src/git.ts";
import { __setProjectRootForTests, __resetProjectRootForTests } from "../src/security.ts";

const MARKER = "PERSONAL_FINANCIAL_DATA_LEAK";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "diff-escape-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  for (const c of [["config", "user.email", "t@e.com"], ["config", "user.name", "T"]]) {
    execFileSync("git", c, { cwd: root, stdio: "ignore" });
  }
  writeFileSync(join(root, "a.txt"), "one\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("git diff: external diff drivers are neutralized, not broken", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n", "utf8");
    __setProjectRootForTests(root);
    addAllowedCommand("git diff");
  });

  afterEach(() => {
    __resetProjectRootForTests();
    rmSync(root, { recursive: true, force: true });
  });

  // Regression: GIT_CONFIG_OVERRIDES contained "-c", "diff.external=".
  // Git treats the empty value as the *name of a program to execute*, so every
  // `git diff` that rendered patch content died with
  //   "error: cannot spawn : No such file or directory
  //    fatal: external diff died"
  // and exited 128 with no output. `git diff` is a default-allowlisted
  // command, so the diffing workflow was simply dead in this backend while the
  // Python backend (whose run_command does not route through these overrides)
  // kept working -- a cross-backend divergence.
  test("git diff produces real output instead of 'external diff died'", async () => {
    const result = (await runCommand("git diff", true)) as Record<string, unknown>;

    expect(String(result.error ?? "")).not.toMatch(/external diff died/i);
    expect(String(result.stderr ?? "")).not.toMatch(/external diff died/i);
    expect(result.returncode).toBe(0);
    expect(String(result.stdout ?? "")).toContain("diff --git");
    expect(String(result.stdout ?? "")).toContain("+two");
  });

  test.each([
    ["git log -p", "patch from log"],
    ["git show", "patch from show"],
  ])("%s still renders diff content", async (command) => {
    addAllowedCommand(command);
    const result = (await runCommand(command, true)) as Record<string, unknown>;
    expect(String(result.error ?? "")).not.toMatch(/external diff died/i);
    expect(String(result.stdout ?? "")).toContain("diff --git");
  });

  test("git diff --staged still renders diff content", async () => {
    writeFileSync(join(root, "a.txt"), "one\ntwo\n", "utf8");
    execFileSync("git", ["add", "a.txt"], { cwd: root, stdio: "ignore" });
    const result = (await runCommand("git diff --staged", true)) as Record<string, unknown>;
    expect(String(result.error ?? "")).not.toMatch(/external diff died/i);
    expect(String(result.stdout ?? "")).toContain("diff --git");
    expect(String(result.stdout ?? "")).toContain("+two");
  });

  // --no-ext-diff must be appended *after* the caller's arguments: git honours
  // the last of --ext-diff/--no-ext-diff, so prepending would let a caller
  // re-enable a repo-controlled `diff.external` command.
  test("--no-ext-diff is appended so a caller cannot re-enable an external diff", async () => {
    const result = (await runCommand("git diff --ext-diff", true)) as Record<string, unknown>;
    expect(String(result.error ?? "")).not.toMatch(/external diff died/i);
    expect(String(result.stdout ?? "")).toContain("diff --git");
  });

  test("the harmful diff.external= override is gone", () => {
    expect(GIT_CONFIG_OVERRIDES).not.toContain("diff.external=");
  });

  test("non-diff subcommands are not given the diff-only flag", async () => {
    addAllowedCommand("git status");
    const result = (await runCommand("git status", true)) as Record<string, unknown>;
    // `git status --no-ext-diff` fails with "unknown option".
    expect(String(result.stderr ?? "")).not.toMatch(/unknown option/i);
    expect(String(result.stdout ?? "")).toContain("branch");
  });

  test("a repo-configured diff.external cannot break or hijack the diff", async () => {
    // Write a driver into the repo config, the way a hostile repository would.
    const evil = join(root, "evil-diff.sh");
    writeFileSync(evil, `#!/bin/sh\necho ${MARKER} > diff-ran\n`, "utf8");
    execFileSync("git", ["config", "diff.external", evil], { cwd: root, stdio: "ignore" });

    const result = (await runCommand("git diff", true)) as Record<string, unknown>;

    expect(String(result.stdout ?? "")).not.toContain(MARKER);
    expect(String(result.stdout ?? "")).toContain("diff --git");
    expect(existsSync(join(root, "diff-ran"))).toBe(false);
  });

  test("gitDiff() tool is unaffected", async () => {
    writeFileSync(join(root, "a.txt"), "one\ntwo\n", "utf8");
    const result = await gitDiff();
    expect(result.error).toBeUndefined();
    expect(String(result.diff)).toContain("diff --git");
  });
});

describe("git diff --no-index cannot read outside the project", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "noindex-"));
    root = join(base, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });
    writeFileSync(join(root, "src", "notes.txt"), "project notes\n", "utf8");
    outside = join(base, "salary_data.txt");
    writeFileSync(outside, `${MARKER}\n`, "utf8");
    __setProjectRootForTests(root);
    addAllowedCommand("git diff");
  });

  afterEach(() => {
    __resetProjectRootForTests();
    rmSync(base, { recursive: true, force: true });
  });

  // Regression (security): `git diff --no-index <A> <B>` compares two
  // arbitrary paths while ignoring the repository and prints the full contents
  // of both. Nothing caught it: the directory guard only covers ls/dir/pwd, and
  // the read-permission check only runs when files are selected on the Project
  // page. This returned out-of-project files verbatim to the model.
  // (In the TypeScript backend this was additionally hidden by the
  // diff.external= bug above, which made every git diff fail.)
  test.each([
    ["absolute paths", (a: string, b: string) => `git diff --no-index ${a} ${b}`],
    ["relative traversal", () => "git diff --no-index ../salary_data.txt src/notes.txt"],
    ["repeated flag", () => "git diff --no-index --no-index ../salary_data.txt src/notes.txt"],
    ["--no-index= form", (a: string) => `git diff --no-index=${a} src/notes.txt`],
    // --ita-invisible-in-index implies --no-index in Git, so blocking only the
    // literal --no-index would leave an equivalent escape.
    ["--ita-invisible-in-index", (a: string) => `git diff --no-index --ita-invisible-in-index ${a} src/notes.txt`],
  ])("blocks the escape via %s", async (_label, build) => {
    const inside = join(root, "src", "notes.txt");
    const result = (await runCommand(build(outside, inside), true)) as Record<string, unknown>;

    expect(String(result.stdout ?? "")).not.toContain(MARKER);
    expect(String(result.stderr ?? "")).not.toContain(MARKER);
    expect(String(result.error ?? "")).toMatch(/--no-index/);
  });

  test("the message explains why", async () => {
    const result = (await runCommand(`git diff --no-index ${outside} ${join(root, "src", "notes.txt")}`, true)) as Record<string, unknown>;
    expect(String(result.error)).toContain("outside the project");
  });

  test("ordinary git diff is still allowed", async () => {
    // Commit first so the change is tracked and `git diff` has something to show.
    execFileSync("git", ["add", "-A"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "init"],
      { cwd: base, stdio: "ignore" });
    writeFileSync(join(root, "src", "notes.txt"), "project notes\nedited\n", "utf8");
    const result = (await runCommand("git diff", true)) as Record<string, unknown>;
    expect(String(result.error ?? "")).not.toMatch(/--no-index/);
    expect(String(result.stdout ?? "")).toContain("diff --git");
  });

  test("the allowlist also blocks flag-smuggled forms before the guard runs", async () => {
    // `git --no-pager diff --no-index ...` would make the subcommand check miss
    // tokens[1]; the command allowlist rejects it because it is not a prefix of
    // "git diff". Both layers are asserted here.
    const result = (await runCommand("git --no-pager diff --no-index ../salary_data.txt src/notes.txt", true)) as Record<string, unknown>;
    expect(String(result.stdout ?? "")).not.toContain(MARKER);
    expect(String(result.error ?? "")).toBeTruthy();
  });
});
