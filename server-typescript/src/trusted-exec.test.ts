/**
 * Project-root executable hijacking defenses.
 *
 * On Windows, CreateProcess searches cwd before PATH for bare names.
 * We resolve absolute trusted paths from PATH only and refuse any
 * candidate that lands inside the project root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { delimiter as pathDelimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  resolveTrustedExecutable,
  TrustedExecutableError,
  __looksLikePathForTests,
} from "./trusted-exec.ts";
import { __setProjectRootForTests, __resetProjectRootForTests } from "./security.ts";
import { runCommand, reloadAllowedCommands, persistAllowedCommands, DEFAULT_ALLOWED_COMMAND_PREFIXES } from "./terminal.ts";

test.afterEach(() => {
  persistAllowedCommands([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  reloadAllowedCommands();
  __resetProjectRootForTests();
});

test("looksLikePath rejects path-qualified names", () => {
  assert.equal(__looksLikePathForTests("npm"), false);
  assert.equal(__looksLikePathForTests("./npm"), true);
  assert.equal(__looksLikePathForTests("../npm"), true);
  assert.equal(__looksLikePathForTests("/usr/bin/npm"), true);
  assert.equal(__looksLikePathForTests("C:\\\\npm"), true);
});

test("resolveTrustedExecutable refuses path-qualified names", () => {
  assert.throws(
    () => resolveTrustedExecutable("./npm"),
    (err: unknown) => err instanceof TrustedExecutableError,
  );
  assert.throws(
    () => resolveTrustedExecutable("/usr/bin/git"),
    (err: unknown) => err instanceof TrustedExecutableError,
  );
});

test("resolveTrustedExecutable skips project-root shims", () => {
  const project = mkdtempSync(join(tmpdir(), "hijack-project-"));
  const marker = join(project, "HIJACKED");
  // Plant a malicious "node" shim in the project root. On Unix it is a
  // shell script; on Windows a .cmd — either would be a hijack candidate
  // if cwd were searched.
  if (process.platform === "win32") {
    writeFileSync(
      join(project, "node.cmd"),
      `@echo off\r\necho pwned > "${marker}"\r\n`,
      "utf8",
    );
  } else {
    const shim = join(project, "node");
    writeFileSync(shim, `#!/bin/sh\necho pwned > "${marker}"\n`, {
      encoding: "utf8",
      mode: 0o755,
    });
  }

  // Put the project directory first on PATH so a naive PATH search would
  // prefer the shim. The resolver must still refuse it because it is
  // inside projectRoot.
  const originalPath = process.env.PATH || process.env.Path || "";
  const originalPathWin = process.env.Path;
  try {
    process.env.PATH = `${project}${pathDelimiter}${originalPath}`;
    if (process.platform === "win32") {
      process.env.Path = process.env.PATH;
    }

    const resolved = resolveTrustedExecutable("node", { projectRoot: project });
    const projectReal = realpathSync(project);
    assert.ok(
      !resolved.startsWith(projectReal),
      `resolved path must not be under project: ${resolved}`,
    );
    assert.equal(
      existsSync(marker),
      false,
      "shim must not have been executed during resolution",
    );
  } finally {
    process.env.PATH = originalPath;
    if (process.platform === "win32" && originalPathWin !== undefined) {
      process.env.Path = originalPathWin;
    }
    rmSync(project, { recursive: true, force: true });
  }
});

test("runCommand does not execute a project-root npm shim", async () => {
  // Behavioral test: plant npm (or npm.cmd) in the project that writes a
  // marker, put project first on PATH, and ensure runCommand("npm --version")
  // never creates the marker.
  const project = mkdtempSync(join(tmpdir(), "npm-hijack-"));
  const marker = join(project, "NPM_HIJACKED");
  if (process.platform === "win32") {
    writeFileSync(
      join(project, "npm.cmd"),
      `@echo off\r\necho pwned > "${marker}"\r\nexit /b 0\r\n`,
      "utf8",
    );
  } else {
    writeFileSync(join(project, "npm"), `#!/bin/sh\necho pwned > "${marker}"\nexit 0\n`, {
      encoding: "utf8",
      mode: 0o755,
    });
  }

  const originalPath = process.env.PATH || "";
  try {
    process.env.PATH = `${project}${pathDelimiter}${originalPath}`;
    if (process.platform === "win32") process.env.Path = process.env.PATH;
    __setProjectRootForTests(project);

    // May succeed (real npm) or fail (not installed); either way the
    // project shim must not run.
    await runCommand("npm --version");
    assert.equal(
      existsSync(marker),
      false,
      "project-root npm shim must never execute",
    );
  } finally {
    process.env.PATH = originalPath;
    if (process.platform === "win32") process.env.Path = originalPath;
    __resetProjectRootForTests();
    rmSync(project, { recursive: true, force: true });
  }
});

test("runCommand does not execute a project-root git shim for allowlisted git status", async () => {
  const project = mkdtempSync(join(tmpdir(), "git-hijack-"));
  const marker = join(project, "GIT_HIJACKED");
  if (process.platform === "win32") {
    writeFileSync(
      join(project, "git.cmd"),
      `@echo off\r\necho pwned > "${marker}"\r\nexit /b 0\r\n`,
      "utf8",
    );
  } else {
    writeFileSync(join(project, "git"), `#!/bin/sh\necho pwned > "${marker}"\nexit 0\n`, {
      encoding: "utf8",
      mode: 0o755,
    });
  }

  // Init a real git repo only if system git is available; otherwise the
  // command may error — marker still must not appear.
  try {
    execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
  } catch {
    // system git missing — still run the hijack check
  }

  const originalPath = process.env.PATH || "";
  try {
    process.env.PATH = `${project}${pathDelimiter}${originalPath}`;
    if (process.platform === "win32") process.env.Path = process.env.PATH;
    __setProjectRootForTests(project);
    await runCommand("git status");
    assert.equal(
      existsSync(marker),
      false,
      "project-root git shim must never execute",
    );
  } finally {
    process.env.PATH = originalPath;
    if (process.platform === "win32") process.env.Path = originalPath;
    __resetProjectRootForTests();
    rmSync(project, { recursive: true, force: true });
  }
});
