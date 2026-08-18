import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { listFiles, readFile, searchFiles } from "./filesystem.js";
import { __setProjectRootForTests, getProjectRoot } from "./security.js";
import { isToolError } from "./types.js";

let projectRoot: string;
let originalProjectRoot: string;

beforeEach(() => {
  originalProjectRoot = getProjectRoot();
  projectRoot = mkdtempSync(join(tmpdir(), "ai-terminal-chat-filesystem-test-"));
  __setProjectRootForTests(projectRoot);
});

afterEach(() => {
  __setProjectRootForTests(originalProjectRoot);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("listFiles", () => {
  test("lists files and directories, sorted case-insensitively", () => {
    writeFileSync(join(projectRoot, "banana.txt"), "");
    writeFileSync(join(projectRoot, "Apple.txt"), "");
    mkdirSync(join(projectRoot, "zeta"));
    mkdirSync(join(projectRoot, "Beta"));

    const result = listFiles(".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;

    assert.equal(result.path, ".");
    assert.deepEqual(
      result.entries.map((e) => e.name),
      ["Apple.txt", "banana.txt", "Beta", "zeta"],
    );
    assert.deepEqual(
      result.entries.map((e) => e.type),
      ["file", "file", "directory", "directory"],
    );
  });

  test("reports a symlinked directory as a directory (follows symlinks like Python's is_dir())", () => {
    mkdirSync(join(projectRoot, "real"));
    symlinkSync(join(projectRoot, "real"), join(projectRoot, "link"), "dir");

    const result = listFiles(".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;

    const link = result.entries.find((e) => e.name === "link");
    assert.equal(link?.type, "directory");
  });

  test("errors on a non-existent path", () => {
    const result = listFiles("does-not-exist");
    assert.ok(isToolError(result));
  });

  test("errors when the path is a file, not a directory", () => {
    writeFileSync(join(projectRoot, "file.txt"), "hi");
    const result = listFiles("file.txt");
    assert.ok(isToolError(result));
  });

  test("errors on path traversal (delegates to safePath)", () => {
    const result = listFiles("../outside");
    assert.ok(isToolError(result));
  });

  test("errors on an absolute path (delegates to safePath)", () => {
    const result = listFiles("/etc");
    assert.ok(isToolError(result));
  });
});

describe("readFile", () => {
  test("reads a UTF-8 text file", () => {
    writeFileSync(join(projectRoot, "notes.txt"), "hello world");
    const result = readFile("notes.txt");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.path, "notes.txt");
    assert.equal(result.contents, "hello world");
  });

  test("refuses a .env file's contents (sensitive-file protection)", () => {
    writeFileSync(join(projectRoot, ".env"), "GOOGLE_API_KEY=super-secret");
    const result = readFile(".env");
    assert.ok(isToolError(result));
    assert.ok(!("contents" in result));
  });

  test("refuses .git internals", () => {
    mkdirSync(join(projectRoot, ".git"));
    writeFileSync(join(projectRoot, ".git", "config"), "[core]\n");
    const result = readFile(".git/config");
    assert.ok(isToolError(result));
    assert.ok(!("contents" in result));
  });

  test("errors on a non-existent file", () => {
    const result = readFile("missing.txt");
    assert.ok(isToolError(result));
  });

  test("errors when the target is a directory", () => {
    mkdirSync(join(projectRoot, "adir"));
    const result = readFile("adir");
    assert.ok(isToolError(result));
  });

  test("errors on a file over the 200,000-byte limit", () => {
    writeFileSync(join(projectRoot, "big.txt"), "x".repeat(200_001));
    const result = readFile("big.txt");
    assert.ok(isToolError(result));
    if (isToolError(result)) {
      assert.match(result.error, /too large/);
    }
  });

  test("allows a file exactly at the byte limit", () => {
    writeFileSync(join(projectRoot, "exact.txt"), "x".repeat(200_000));
    const result = readFile("exact.txt");
    assert.ok(!isToolError(result));
  });

  test("errors on a non-UTF-8 file instead of substituting replacement characters", () => {
    // 0xFF is never valid as a standalone UTF-8 byte.
    writeFileSync(join(projectRoot, "binary.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const result = readFile("binary.dat");
    assert.ok(isToolError(result));
    if (isToolError(result)) {
      assert.match(result.error, /not a UTF-8 text file/);
    }
  });

  test("errors on path traversal (delegates to safePath)", () => {
    const result = readFile("../outside.txt");
    assert.ok(isToolError(result));
  });
});

describe("searchFiles", () => {
  test("finds matching lines with line numbers", () => {
    writeFileSync(join(projectRoot, "a.txt"), "line one\nfind me here\nline three\n");
    const result = searchFiles("find me", ".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.path, "a.txt");
    assert.equal(result.matches[0]?.line, 2);
    assert.equal(result.truncated, false);
  });

  test("is case-insensitive", () => {
    writeFileSync(join(projectRoot, "a.txt"), "Needle in a haystack\n");
    const result = searchFiles("NEEDLE", ".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.matches.length, 1);
  });

  test("rejects an empty query", () => {
    const result = searchFiles("", ".");
    assert.ok(isToolError(result));
  });

  test("rejects a whitespace-only query", () => {
    const result = searchFiles("   ", ".");
    assert.ok(isToolError(result));
  });

  test("skips sensitive filenames entirely", () => {
    writeFileSync(join(projectRoot, ".env"), "SECRET_TOKEN=findme");
    const result = searchFiles("findme", ".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.matches.length, 0);
  });

  test("excludes conventional build/dependency/VCS directories", () => {
    for (const dir of ["node_modules", ".git", "__pycache__", "dist", ".venv"]) {
      mkdirSync(join(projectRoot, dir));
      writeFileSync(join(projectRoot, dir, "hit.txt"), "findme");
    }
    writeFileSync(join(projectRoot, "hit.txt"), "findme");

    const result = searchFiles("findme", ".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.path, "hit.txt");
  });

  test("skips binary files without erroring", () => {
    writeFileSync(join(projectRoot, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    writeFileSync(join(projectRoot, "text.txt"), "findme");

    const result = searchFiles("findme", ".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.path, "text.txt");
  });

  test("skips files over the 500,000-byte search limit", () => {
    writeFileSync(join(projectRoot, "huge.txt"), `${"x".repeat(500_001)}findme`);
    const result = searchFiles("findme", ".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.matches.length, 0);
  });

  test("truncates at 200 matches", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `findme line ${i}`).join("\n");
    writeFileSync(join(projectRoot, "many.txt"), lines);

    const result = searchFiles("findme", ".");
    assert.ok(!isToolError(result));
    if (isToolError(result)) return;
    assert.equal(result.matches.length, 200);
    assert.equal(result.truncated, true);
  });

  test("errors on path traversal (delegates to safePath)", () => {
    const result = searchFiles("x", "../outside");
    assert.ok(isToolError(result));
  });

  // Verified empirically against server-python before porting: os.walk's
  // followlinks=False default means a symlinked directory's contents are
  // never searched, even though the symlink itself would be classified as
  // a directory. See planWalk()'s doc comment in filesystem.ts.
  test("does not descend into a symlinked directory (matches os.walk's followlinks=False default)", () => {
    const outside = mkdtempSync(join(tmpdir(), "ai-terminal-chat-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "findme-XYZZY");
      symlinkSync(outside, join(projectRoot, "escape_link"), "dir");

      const result = searchFiles("findme-XYZZY", ".");
      assert.ok(!isToolError(result));
      if (isToolError(result)) return;
      assert.equal(result.matches.length, 0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("reads through a symlink to a file (matches Python's read_text() following it)", () => {
    const outside = mkdtempSync(join(tmpdir(), "ai-terminal-chat-outside-"));
    try {
      writeFileSync(join(outside, "target.txt"), "findme-via-symlink");
      symlinkSync(join(outside, "target.txt"), join(projectRoot, "link.txt"));

      const result = searchFiles("findme-via-symlink", ".");
      assert.ok(!isToolError(result));
      if (isToolError(result)) return;
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0]?.path, "link.txt");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
