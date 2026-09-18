import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { captureConfirmationFileStates, confirmationFileStatesMatch, confirmationPathsForPending } from "../src/confirmation-state.ts";
import { setProjectRoot } from "../src/security.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

describe("Git index confirmation state", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-index-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    setProjectRoot(root);
    fs.writeFileSync(path.join(root, "file.txt"), "one\n");
    execFileSync("git", ["add", "file.txt"], { cwd: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("binds git_add and staged restore confirmations to the index", () => {
    expect(confirmationPathsForPending("git_add", { path: "file.txt" })).toEqual([
      "file.txt",
      "__git_index__",
    ]);
    expect(confirmationPathsForPending("git_restore", { path: "file.txt", staged: true })).toEqual([
      "file.txt",
      "__git_index__",
    ]);
  });

  it("binds git_commit pending actions to the index", () => {
    expect(confirmationPathsForPending("git_commit", { message: "commit" })).toEqual(["__git_index__"]);
    const states = captureConfirmationFileStates(["__git_index__"]);
    expect(states[0]?.kind).toBe("git_index");
    expect(states[0]?.status).toBe("present");

    fs.writeFileSync(path.join(root, "file.txt"), "two\n");
    execFileSync("git", ["add", "file.txt"], { cwd: root });

    expect(confirmationFileStatesMatch(states)).toBe(false);
  });
});
