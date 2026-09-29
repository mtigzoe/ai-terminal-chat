import { describe, it, expect } from "vitest";
import { isPathWithinRoot } from "../src/security.ts";

describe("isPathWithinRoot: filesystem-root project roots", () => {
  const ci = { caseInsensitive: true };

  // Regression: the comparison appended a separator to the root, so a root of
  // "C:\" produced "C:\\" and a root of "/" produced "//" -- prefixes that
  // nothing can start with. Every path under a root-rooted project was
  // therefore rejected, breaking the project completely. A drive root or "/"
  // is a legitimate project root (a container image that mounts the project at
  // "/", or `git init C:\`), and the Python backend accepted it because
  // pathlib.relative_to() has no such special case -- a cross-backend
  // divergence.
  it("accepts paths under a Windows drive root", () => {
    for (const candidate of ["C:\\", "C:\\foo", "C:\\foo\\bar.txt", "C:\\Users\\me\\file.txt"]) {
      expect(isPathWithinRoot("C:\\", candidate, ci)).toBe(true);
    }
  });

  it("accepts paths under a POSIX filesystem root", () => {
    for (const candidate of ["/", "/foo", "/foo/bar.txt", "/srv/app/src/index.js"]) {
      expect(isPathWithinRoot("/", candidate, { caseInsensitive: false })).toBe(true);
    }
  });

  it("accepts paths under a drive root with mixed casing", () => {
    expect(isPathWithinRoot("C:\\", "c:\\foo\\bar.txt", ci)).toBe(true);
  });

  it("still rejects other drives", () => {
    expect(isPathWithinRoot("C:\\", "D:\\other\\file.txt", ci)).toBe(false);
  });

  it("normalizes mixed separators only for Windows-style roots", () => {
    expect(isPathWithinRoot("C:\\", "C:/Users/me/file.txt", ci)).toBe(true);
    expect(isPathWithinRoot("/", "\\srv\\app\\x.txt", { caseInsensitive: false })).toBe(false);
  });
});

describe("isPathWithinRoot: ordinary roots are unchanged", () => {
  const ci = { caseInsensitive: true };

  it.each([
    ["C:\\work\\proj", "C:\\work\\proj", true],
    ["C:\\work\\proj", "C:\\work\\proj\\x.txt", true],
    ["C:\\work\\proj", "C:\\work\\proj\\a\\b\\c.txt", true],
    // prefix collision: "proj2" must not count as inside "proj"
    ["C:\\work\\proj", "C:\\work\\proj2\\x.txt", false],
    ["C:\\work\\proj", "C:\\work\\projX", false],
    ["C:\\work\\proj", "C:\\work\\other\\x.txt", false],
    ["C:\\work\\proj", "D:\\work\\proj\\x.txt", false],
  ])("root=%s candidate=%s -> %s", (root, candidate, expected) => {
    expect(isPathWithinRoot(root, candidate, ci)).toBe(expected);
  });

  it("matches the platform case-sensitivity default when not told", () => {
    const winLike = process.platform === "win32";
    expect(isPathWithinRoot("C:\\Work\\Proj", "c:\\work\\proj\\x")).toBe(winLike);
  });

  it("keeps POSIX case sensitivity when asked", () => {
    expect(
      isPathWithinRoot("/srv/App", "/srv/app/x.txt", { caseInsensitive: false }),
    ).toBe(false);
    expect(
      isPathWithinRoot("/srv/App", "/srv/App/x.txt", { caseInsensitive: false }),
    ).toBe(true);
  });

  it("does not treat a POSIX sibling containing a backslash as a child", () => {
    expect(
      isPathWithinRoot("/srv/app", "/srv/app\\\\secret.txt", { caseInsensitive: false }),
    ).toBe(false);
  });
});
