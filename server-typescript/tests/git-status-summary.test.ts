import { describe, expect, it } from "vitest";

import { summarizeGitStatus } from "../src/git-status-summary.ts";

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

  it("continues to count ordinary staged changes separately", () => {
    const result = summarizeGitStatus("## main\nM  staged.txt\nUU conflict.txt\n");

    expect(result).toMatchObject({
      changed: 2,
      staged: 1,
      conflicts: 1,
    });
    expect(result.summary).toContain("1 file is staged for the next commit.");
  });
});
