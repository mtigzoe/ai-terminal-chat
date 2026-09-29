import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // NOTE: only add specific file paths here for vitest-style tests that
    // live outside tests/**. A blanket "src/**/*.test.ts" glob would also
    // match the node:test-style files under src/, which use a different
    // test-runner API and would break under vitest.
    include: [
      "tests/**/*.test.ts",
      "src/git.ssh-isolation.test.ts",
      "src/cancellation.test.ts",
    ],
    setupFiles: ["tests/undici-fetch-test-compat.ts"],
    testTimeout: 10000,
    // The TypeScript security/tool tests share process-global project-root
    // state. Running test files in parallel can let one file replace and
    // clean up the root while another file is still using it, producing
    // nondeterministic "Project path does not exist" failures.
    fileParallelism: false,
  },
});
