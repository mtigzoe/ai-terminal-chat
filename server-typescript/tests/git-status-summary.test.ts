import { describe, expect, it } from "vitest";

import { summarizeGitStatus } from "../src/git-status-summary.ts";

// Regression coverage: unresolved merge conflicts are reported as conflicts,
// never as ordinary staged changes. server-python's git_status() already did
// this (GIT_CONFLICT_STATUS_CODES in tools.py) but the TypeScript summary
// counted "UU"/"AA"/"DD" as staged work, so the model could tell a user a
// conflicted file was ready to commit.
describe("summarizeGitStatus", () => {
  it.each(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])(
    "reports %s as an unresolved conflict instead of a staged file",
    (code) => {
      const result = summarizeGitStatus(`## main\n${code} file.txt\n`);

      expect(result).toMatchObject({
        clean: false,
        changed: 1,
        staged: 0,
        conflicts: 1,
      });
      expect(result.details).toEqual([
        "file.txt — unresolved merge conflict, must be resolved before this can be committed",
      ]);
      expect(result.summary).toContain(
        "1 file has an unresolved merge conflict and must be resolved before you can commit.",
      );
      expect(result.summary).not.toContain("staged for the next commit");
    },
  );

  it("pluralizes the conflict warning for multiple conflicted files", () => {
    const result = summarizeGitStatus("## main\nUU a.txt\nAA b.txt\n");

    expect(result).toMatchObject({ changed: 2, staged: 0, conflicts: 2 });
    expect(result.summary).toContain(
      "2 files have an unresolved merge conflict and must be resolved before you can commit.",
    );
  });

  it("continues to count ordinary staged changes separately", () => {
    const result = summarizeGitStatus("## main\nM  staged.txt\nUU conflict.txt\n");

    expect(result).toMatchObject({ changed: 2, staged: 1, conflicts: 1 });
    expect(result.summary).toContain("1 file is staged for the next commit.");
  });

  it("does not treat untracked files as conflicts", () => {
    const result = summarizeGitStatus("## main\n?? new.txt\n");

    expect(result).toMatchObject({
      clean: false,
      untracked: 1,
      changed: 0,
      conflicts: 0,
    });
    expect(result.details).toEqual(["new.txt — new file, not tracked by Git"]);
  });

  it("keeps reporting tracking state for a clean branch", () => {
    const result = summarizeGitStatus(
      "## main...origin/main [ahead 1, behind 2]\n",
    );

    expect(result).toMatchObject({
      branch: "main",
      clean: true,
      conflicts: 0,
      staged: 0,
      changed: 0,
      ahead: 1,
      behind: 2,
      hasRemote: true,
      synchronized: false,
    });
  });

  // Regression: on a repository with no commits yet, `git status
  // --short --branch` prints "## No commits yet on <branch>". The branch
  // regex captured the whole banner, so the branch name reported to the model
  // and the user was "No commits yet on main" instead of "main". The same
  // applied to "## Initial commit on <branch>" from `git init`.
  it.each([
    ["## No commits yet on main", "main"],
    ["## Initial commit on master", "master"],
    ["## No commits yet on feature/login", "feature/login"],
  ])("extracts the branch from the fresh-repository banner %s", (line, branch) => {
    const result = summarizeGitStatus(`${line}\n`);

    expect(result.branch).toBe(branch);
    expect(result.hasRemote).toBe(false);
    expect(result.summary).not.toContain("No commits yet");
    expect(result.summary).not.toContain("Initial commit");
  });

  it("does not report detached HEAD as a branch name", () => {
    const result = summarizeGitStatus("## HEAD (no branch)\n");

    expect(result.branch).toBeNull();
    expect(result.hasRemote).toBe(false);
    expect(result.summary).toContain("detached HEAD");
    expect(result.summary).not.toContain("not tracking a remote branch");
  });

  it("still extracts the branch from a normal banner", () => {
    expect(summarizeGitStatus("## main\n").branch).toBe("main");
    expect(summarizeGitStatus("## main...origin/main [ahead 1]\n").branch).toBe("main");
  });
});
