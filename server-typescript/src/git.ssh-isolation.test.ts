import { describe, expect, test } from "vitest";
import { getGitSshCommand } from "./git.ts";

describe("Git SSH isolation", () => {
  test("does not load the user's SSH config or proxy commands", () => {
    const command = getGitSshCommand();
    const expectedConfig = process.platform === "win32" ? "NUL" : "/dev/null";

    expect(command).toBe(
      `ssh -F ${expectedConfig} -o ProxyCommand=none -o ProxyJump=none`,
    );
  });
});
