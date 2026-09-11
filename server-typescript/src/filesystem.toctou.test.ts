/**
 * TOCTOU / final-component symlink races after safePath().
 *
 * safePath validates, then a concurrent swap of the final component to a
 * symlink must not allow reading or writing outside the project. We use
 * O_NOFOLLOW open + fd I/O so the final component cannot be followed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  __setProjectRootForTests,
  __resetProjectRootForTests,
  readFileWithinProject,
  writeFileWithinProject,
  unlinkWithinProject,
  SecurityValidationError,
} from "./security.ts";
import { readFile } from "./filesystem.ts";
import {
  create_file,
  write_file,
  delete_file,
} from "./write-tools.ts";

test.afterEach(() => {
  __resetProjectRootForTests();
});

function makeProject(): { project: string; outside: string } {
  const project = mkdtempSync(join(tmpdir(), "toctou-project-"));
  const outside = mkdtempSync(join(tmpdir(), "toctou-outside-"));
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE_SECRET\n", "utf8");
  __setProjectRootForTests(project);
  return { project, outside };
}

test("readFileWithinProject refuses final-component symlink to outside file", () => {
  const { project, outside } = makeProject();
  const secret = join(outside, "secret.txt");
  const link = join(project, "link.txt");
  try {
    symlinkSync(secret, link);
  } catch (err) {
    // Windows may require elevated privileges for file symlinks.
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    throw err;
  }

  assert.throws(
    () => readFileWithinProject("link.txt", 100_000),
    (e: unknown) =>
      e instanceof SecurityValidationError ||
      (e as NodeJS.ErrnoException).code === "ELOOP",
  );

  const toolResult = readFile("link.txt");
  assert.ok("error" in toolResult);
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("writeFileWithinProject refuses final-component symlink (no outside overwrite)", () => {
  const { project, outside } = makeProject();
  const secret = join(outside, "secret.txt");
  const link = join(project, "out.txt");
  try {
    symlinkSync(secret, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    throw err;
  }

  assert.throws(
    () => writeFileWithinProject("out.txt", "PWNED\n", { exclusive: false }),
    (e: unknown) =>
      e instanceof SecurityValidationError ||
      (e as NodeJS.ErrnoException).code === "ELOOP",
  );
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("create_file exclusive refuses existing final-component symlink", () => {
  const { project, outside } = makeProject();
  const secret = join(outside, "secret.txt");
  const link = join(project, "new.txt");
  try {
    symlinkSync(secret, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    throw err;
  }

  const result = create_file("new.txt", "PWNED\n", true);
  assert.ok("error" in result, `expected error, got ${JSON.stringify(result)}`);
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("write_file confirm path refuses final-component symlink", () => {
  const { project, outside } = makeProject();
  const secret = join(outside, "secret.txt");
  const link = join(project, "w.txt");
  try {
    symlinkSync(secret, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    throw err;
  }

  const result = write_file("w.txt", "PWNED\n", true);
  assert.ok("error" in result);
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("unlinkWithinProject refuses final-component symlink", () => {
  const { project, outside } = makeProject();
  const secret = join(outside, "secret.txt");
  const link = join(project, "d.txt");
  try {
    symlinkSync(secret, link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    throw err;
  }

  assert.throws(
    () => unlinkWithinProject("d.txt"),
    (e: unknown) =>
      e instanceof SecurityValidationError ||
      (e as NodeJS.ErrnoException).code === "ELOOP",
  );
  assert.equal(existsSync(secret), true);
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE_SECRET\n");

  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("writeFileWithinProject creates a normal in-project file", () => {
  const { project, outside } = makeProject();
  const { resolvedPath, bytesWritten } = writeFileWithinProject(
    "ok.txt",
    "hello\n",
    { exclusive: true },
  );
  assert.ok(resolvedPath.includes(project) || existsSync(join(project, "ok.txt")));
  assert.equal(readFileSync(join(project, "ok.txt"), "utf8"), "hello\n");
  assert.equal(bytesWritten, Buffer.byteLength("hello\n"));
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "OUTSIDE_SECRET\n");
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
