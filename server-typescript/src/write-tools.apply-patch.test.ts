/**
 * apply_patch / write_file preview path-boundary tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  __setProjectRootForTests,
  __resetProjectRootForTests,
} from "./security.ts";
import { apply_patch, write_file } from "./write-tools.ts";

test.afterEach(() => {
  __resetProjectRootForTests();
});

function makeGitProject(): { project: string; outside: string } {
  const project = mkdtempSync(join(tmpdir(), "patch-project-"));
  const outside = mkdtempSync(join(tmpdir(), "patch-outside-"));
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE_SECRET\n", "utf8");
  execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], {
    cwd: project,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "T"], {
    cwd: project,
    stdio: "ignore",
  });
  writeFileSync(join(project, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: project, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: project,
    stdio: "ignore",
  });
  __setProjectRootForTests(project);
  return { project, outside };
}

test("apply_patch refuses target that is a symlink to an outside file", () => {
  const { project, outside } = makeGitProject();
  const secret = join(outside, "secret.txt");
  const link = join(project, "linked.txt");
  try {
    symlinkSync(secret, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    throw err;
  }

  const patch = [
    "diff --git a/linked.txt b/linked.txt",
    "--- a/linked.txt",
    "+++ b/linked.txt",
    "@@ -1 +1 @@",
    "-OUTSIDE_SECRET",
    "+PWNED",
    "",
  ].join("\n");

  const preview = apply_patch(patch, false);
  assert.ok("error" in preview, JSON.stringify(preview));
  assert.match(String(preview.error), /symlink|outside|Refusing/i);

  const applied = apply_patch(patch, true);
  assert.ok("error" in applied, JSON.stringify(applied));
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("apply_patch extracts diff --git paths for validation", () => {
  const { project, outside } = makeGitProject();
  // Path only appears on diff --git; headers use /dev/null style new file
  const patch = [
    "diff --git a/evil/../../outside.txt b/evil/../../outside.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/evil/../../outside.txt",
    "@@ -0,0 +1 @@",
    "+pwned",
    "",
  ].join("\n");

  const result = apply_patch(patch, false);
  assert.ok("error" in result, JSON.stringify(result));
  assert.equal(existsSync(join(outside, "secret.txt")), true);

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("write_file preview does not follow outside symlink for old content", () => {
  const { project, outside } = makeGitProject();
  const secret = join(outside, "secret.txt");
  const link = join(project, "w.txt");
  try {
    symlinkSync(secret, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    throw err;
  }

  const result = write_file("w.txt", "new\n", false);
  // Must not surface OUTSIDE_SECRET in the diff preview
  const blob = JSON.stringify(result);
  assert.equal(blob.includes("OUTSIDE_SECRET"), false, blob);
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("apply_patch applies a clean unified diff via secure I/O", () => {
  const { project } = makeGitProject();
  writeFileSync(join(project, "README.md"), "hello\n", "utf8");
  const patch = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-hello",
    "+hello world",
    "",
  ].join("\n");
  const preview = apply_patch(patch, false);
  assert.ok("requires_confirmation" in preview, JSON.stringify(preview));
  const applied = apply_patch(patch, true);
  assert.ok(!("error" in applied), JSON.stringify(applied));
  assert.equal(readFileSync(join(project, "README.md"), "utf8"), "hello world\n");
  rmSync(project, { recursive: true, force: true });
});

test("apply_patch does not use git apply path open for TOCTOU", () => {
  // If a symlink appears only after preview, confirm-time re-check must refuse.
  const { project, outside } = makeGitProject();
  const secret = join(outside, "secret.txt");
  writeFileSync(join(project, "target.txt"), "inside\n", "utf8");
  const patch = [
    "diff --git a/target.txt b/target.txt",
    "--- a/target.txt",
    "+++ b/target.txt",
    "@@ -1 +1 @@",
    "-inside",
    "+patched",
    "",
  ].join("\n");
  const preview = apply_patch(patch, false);
  assert.ok("requires_confirmation" in preview, JSON.stringify(preview));

  // Replace the file with a symlink to outside between preview and apply.
  rmSync(join(project, "target.txt"));
  try {
    symlinkSync(secret, join(project, "target.txt"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    throw err;
  }

  const applied = apply_patch(patch, true);
  assert.ok("error" in applied, JSON.stringify(applied));
  assert.match(String(applied.error), /symlink|outside|Refusing|Cannot read/i);
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
