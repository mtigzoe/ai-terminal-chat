import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { create_file, write_file, delete_file, apply_patch } from "../src/write-tools.ts";
import { setProjectRoot, getProjectRoot } from "../src/security.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { execSync } from "node:child_process";

function makeRepoDir(): string {
  const dir = path.join(os.tmpdir(), `write-tools-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    execSync("git init -q", { cwd: dir, stdio: "ignore" });
  } catch {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  }
  return dir;
}

describe("create_file", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepoDir();
    setProjectRoot(root);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("preview does not create anything", () => {
    const result = create_file("new.txt", "hello world", false);
    expect((result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
    expect((result as { preview: string }).preview).toBe("hello world");
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  it("confirm=true writes the file", () => {
    const result = create_file("new.txt", "hello world", true);
    expect((result as { created: boolean }).created).toBe(true);
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf-8")).toBe("hello world");
  });

  it("refuses to overwrite existing file", () => {
    fs.writeFileSync(path.join(root, "existing.txt"), "original");
    const result = create_file("existing.txt", "clobbered", true);
    expect((result as { error: string }).error).toBeDefined();
    expect(fs.readFileSync(path.join(root, "existing.txt"), "utf-8")).toBe("original");
  });

  it("rejects path outside project", () => {
    const result = create_file("../outside.txt", "x", true);
    expect((result as { error: string }).error).toBeDefined();
    expect(fs.existsSync(path.join(root, "..", "outside.txt"))).toBe(false);
  });
});

describe("write_file", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepoDir();
    setProjectRoot(root);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("preview reports diff without writing", () => {
    fs.writeFileSync(path.join(root, "doc.txt"), "line one\n");
    const result = write_file("doc.txt", "line one\nline two\n", false);
    expect((result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
    expect((result as { action: string }).action).toBe("overwrite");
    expect((result as { diff: string }).diff).toContain("+line two");
    expect(fs.readFileSync(path.join(root, "doc.txt"), "utf-8")).toBe("line one\n");
  });

  it("preview reports create for new file", () => {
    const result = write_file("brand-new.txt", "content", false);
    expect((result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
    expect((result as { action: string }).action).toBe("create");
    expect(fs.existsSync(path.join(root, "brand-new.txt"))).toBe(false);
  });

  it("confirm=true overwrites existing file", () => {
    fs.writeFileSync(path.join(root, "doc.txt"), "old");
    const result = write_file("doc.txt", "new", true);
    expect((result as { overwritten: boolean }).overwritten).toBe(true);
    expect(fs.readFileSync(path.join(root, "doc.txt"), "utf-8")).toBe("new");
  });

  it("confirm=true creates missing file", () => {
    const result = write_file("missing.txt", "created via write_file", true);
    expect((result as { overwritten: boolean }).overwritten).toBe(false);
    expect(fs.readFileSync(path.join(root, "missing.txt"), "utf-8")).toBe("created via write_file");
  });

  it("refuses to target a directory", () => {
    fs.mkdirSync(path.join(root, "adir"));
    const result = write_file("adir", "x", true);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("directory");
  });
});

describe("delete_file", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepoDir();
    setProjectRoot(root);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("preview does not delete", () => {
    fs.writeFileSync(path.join(root, "gone.txt"), "bye");
    const result = delete_file("gone.txt", false);
    expect((result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
    expect(fs.existsSync(path.join(root, "gone.txt"))).toBe(true);
  });

  it("confirm=true deletes the file", () => {
    fs.writeFileSync(path.join(root, "gone.txt"), "bye");
    const result = delete_file("gone.txt", true);
    expect((result as { deleted: boolean }).deleted).toBe(true);
    expect(fs.existsSync(path.join(root, "gone.txt"))).toBe(false);
  });

  it("reports missing file", () => {
    const result = delete_file("does-not-exist.txt", true);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("does not exist");
  });

  it("refuses a directory", () => {
    fs.mkdirSync(path.join(root, "adir"));
    const result = delete_file("adir", true);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("directory");
  });

  it("refuses the project root itself", () => {
    const result = delete_file(".", true);
    expect((result as { error: string }).error).toBeDefined();
    expect(fs.existsSync(root)).toBe(true);
  });
});

describe("apply_patch", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepoDir();
    setProjectRoot(root);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const SAMPLE_PATCH = `--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-hello
+hello world
`;

  it("requires a git repository", () => {
    const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
    fs.mkdirSync(nonGitDir, { recursive: true });
    const originalRoot = getProjectRoot();
    setProjectRoot(nonGitDir);
    fs.writeFileSync(path.join(nonGitDir, "greeting.txt"), "hello\n");

    const result = apply_patch(SAMPLE_PATCH, false);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("git repository");

    setProjectRoot(originalRoot);
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  it("rejects empty patch", () => {
    const result = apply_patch("", false);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("no patch");
  });

  it("rejects patch without headers", () => {
    const result = apply_patch("not a real diff", false);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("headers");
  });

  it("preview validates without changing the file", () => {
    fs.writeFileSync(path.join(root, "greeting.txt"), "hello\n");

    const result = apply_patch(SAMPLE_PATCH, false);
    expect((result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
    expect((result as { files: string[] }).files).toEqual(["greeting.txt"]);
    expect(fs.readFileSync(path.join(root, "greeting.txt"), "utf-8")).toBe("hello\n");
  });

  it("confirm=true applies the change", () => {
    fs.writeFileSync(path.join(root, "greeting.txt"), "hello\n");

    const result = apply_patch(SAMPLE_PATCH, true);
    expect((result as { applied: boolean }).applied).toBe(true);
    const applied = fs.readFileSync(path.join(root, "greeting.txt"), "utf-8");
    expect(applied.replace(/\r\n/g, "\n")).toBe("hello world\n");
  });

  it("reports failure when patch does not apply cleanly", () => {
    fs.writeFileSync(path.join(root, "greeting.txt"), "something completely different\n");

    const result = apply_patch(SAMPLE_PATCH, false);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("does not apply cleanly");
  });

  it("rejects sensitive target files", () => {
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");

    const sensitivePatch = `--- a/.env
+++ b/.env
@@ -1 +1 @@
-SECRET=1
+SECRET=2
`;

    const result = apply_patch(sensitivePatch, false);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("sensitive");
  });

  it("rejects target path outside project", () => {
    const escapingPatch = `--- a/../outside.txt
+++ b/../outside.txt
@@ -1 +1 @@
-a
+b
`;

    const result = apply_patch(escapingPatch, false);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("invalid path");
  });

  it("rejects oversized patches", () => {
    const oversized = SAMPLE_PATCH + "x".repeat(200_100);
    const result = apply_patch(oversized, false);
    expect((result as { error: string }).error).toBeDefined();
    expect((result as { error: string }).error.toLowerCase()).toContain("too large");
  });
});
