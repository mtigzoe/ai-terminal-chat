import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runCommand,
  __setAllowedCommandsForTests,
  DEFAULT_ALLOWED_COMMAND_PREFIXES,
} from "./terminal.ts";
import {
  __setProjectRootForTests,
  __resetProjectRootForTests,
} from "./security.ts";
import { isToolError } from "./types.ts";

let projectRoot: string;

test.beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "execution-path-security-"));
  __setProjectRootForTests(projectRoot);
});

test.afterEach(() => {
  __setAllowedCommandsForTests([...DEFAULT_ALLOWED_COMMAND_PREFIXES]);
  __resetProjectRootForTests();
  rmSync(projectRoot, { recursive: true, force: true });
});

test("pytest cannot target a path outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  const target = join(outside, "evil_test.py");
  writeFileSync(target, "def test_evil(): pass\n");

  try {
    const result = await runCommand(`pytest "${target}"`, true);

    assert.ok(isToolError(result));
    if (isToolError(result)) {
      assert.match(result.error, /outside the project root/i);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("python -m pytest cannot target a path outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  const target = join(outside, "evil_test.py");
  writeFileSync(target, "def test_evil(): pass\n");

  try {
    const result = await runCommand(`python -m pytest "${target}"`, true);

    assert.ok(isToolError(result));
    if (isToolError(result)) {
      assert.match(result.error, /outside the project root/i);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("npm --prefix cannot target a directory outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));

  try {
    const result = await runCommand(`npm test --prefix "${outside}"`, true);

    assert.ok(isToolError(result));
    if (isToolError(result)) {
      assert.match(result.error, /outside the project root/i);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("pip --requirement cannot target a file outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  const requirements = join(outside, "requirements.txt");
  writeFileSync(requirements, "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r "${requirements}"`,
      true,
    );

    assert.ok(isToolError(result));
    if (isToolError(result)) {
      assert.match(result.error, /outside the project root/i);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("pip --requirement inside project root still reaches confirmation", async () => {
  const requirements = join(projectRoot, "requirements.txt");
  writeFileSync(requirements, "example-package\n");

  const result = await runCommand("pip install -r requirements.txt");

  assert.equal("requires_confirmation" in result, true);
});

test("execution-risk command inside project root still reaches confirmation", async () => {
  const target = join(projectRoot, "test_example.py");
  writeFileSync(target, "def test_example(): pass\n");

  const result = await runCommand(`pytest "${target}"`);

  assert.equal("requires_confirmation" in result, true);
});
