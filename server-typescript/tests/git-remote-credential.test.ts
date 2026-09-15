import { describe, expect, test } from "vitest";
import { sanitizeGitRemoteOutput } from "../src/git.ts";

describe("Git remote output credential sanitization", () => {
  test("removes HTTPS username and password while preserving host and path", () => {
    const output = "origin\thttps://username:secret-token@example.com/owner/repo.git (fetch)";
    const sanitized = sanitizeGitRemoteOutput(output);

    expect(sanitized).toBe("origin\thttps://example.com/owner/repo.git (fetch)");
    expect(sanitized).not.toContain("username");
    expect(sanitized).not.toContain("secret-token");
  });

  test("removes credentials when the password contains an at-sign", () => {
    const output = "origin\thttps://user:p%40ssword@example.com/repo.git (push)";

    expect(sanitizeGitRemoteOutput(output)).toBe(
      "origin\thttps://example.com/repo.git (push)",
    );
  });

  test("sanitizes SSH URLs with URL userinfo but leaves scp-style remotes alone", () => {
    const output = [
      "origin\tssh://user:token@example.com/owner/repo.git (fetch)",
      "upstream\tgit@github.com:owner/repo.git (fetch)",
    ].join("\n");

    const sanitized = sanitizeGitRemoteOutput(output);

    expect(sanitized).toContain("origin\tssh://example.com/owner/repo.git (fetch)");
    expect(sanitized).toContain("upstream\tgit@github.com:owner/repo.git (fetch)");
    expect(sanitized).not.toContain("token");
  });

  test("does not change URLs without embedded credentials", () => {
    const output = "origin\thttps://github.com/owner/repo.git (fetch)";
    expect(sanitizeGitRemoteOutput(output)).toBe(output);
  });
});
