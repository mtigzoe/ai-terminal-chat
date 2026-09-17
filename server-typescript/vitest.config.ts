import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/undici-fetch-test-compat.ts"],
    testTimeout: 10000,
    // The TypeScript security/tool tests share process-global project-root
    // state. Running test files in parallel can let one file replace and
    // clean up the root while another file is still using it, producing
    // nondeterministic "Project path does not exist" failures.
    fileParallelism: false,
  },
});
