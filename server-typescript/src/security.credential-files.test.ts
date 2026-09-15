import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  __setProjectRootForTests,
  getProjectRoot,
  isSensitiveFilename,
  isSensitivePath,
} from "./security.js";

let projectRoot: string;
let originalProjectRoot: string;

beforeEach(() => {
  originalProjectRoot = getProjectRoot();
  projectRoot = mkdtempSync(join(tmpdir(), "ai-terminal-chat-sensitive-files-test-"));
  __setProjectRootForTests(projectRoot);
});

afterEach(() => {
  __setProjectRootForTests(originalProjectRoot);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("credential-bearing configuration filenames", () => {
  for (const filename of [".npmrc", ".pypirc", ".netrc"]) {
    test(`blocks ${filename} as a sensitive filename`, () => {
      assert.equal(isSensitiveFilename(filename), true);
    });

    test(`blocks ${filename} as a sensitive project path`, () => {
      assert.equal(isSensitivePath(join(projectRoot, filename)), true);
    });
  }
});
