import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

// --- Gate 2: pip options beyond -r/-e, and Flake8/Ruff write targets. ---
// These options were previously unchecked: a confirmed command could
// install/write/cache outside the project even though the command itself
// was allowlisted for in-project use.

test("pip --target cannot install outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r requirements.txt --target "${outside}"`,
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

test("pip --prefix cannot install outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r requirements.txt --prefix "${outside}"`,
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

test("pip --root cannot install outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r requirements.txt --root "${outside}"`,
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

test("pip --src cannot target a directory outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r requirements.txt --src "${outside}"`,
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

test("pip --find-links cannot read a local directory outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r requirements.txt --find-links "${outside}"`,
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

test("pip --constraint cannot read a file outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  const constraint = join(outside, "constraints.txt");
  writeFileSync(constraint, "example-package==1.0.0\n");
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r requirements.txt --constraint "${constraint}"`,
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

test("pip --log cannot write outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  const log = join(outside, "pip.log");
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  try {
    const result = await runCommand(
      `pip install -r requirements.txt --log "${log}"`,
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

test("pip --target inside the project root still reaches confirmation", async () => {
  writeFileSync(join(projectRoot, "requirements.txt"), "example-package\n");

  const result = await runCommand(
    "pip install -r requirements.txt --target vendor",
  );

  assert.equal("requires_confirmation" in result, true);
});

test("flake8 --output-file cannot write outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  const report = join(outside, "flake8-report.txt");

  try {
    const result = await runCommand(
      `flake8 --output-file "${report}"`,
      true,
    );

    assert.ok(isToolError(result));
    if (isToolError(result)) {
      assert.match(result.error, /outside the project root/i);
    }
    assert.equal(existsSync(report), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("flake8 --append-config cannot read a file outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));
  const config = join(outside, "extra.cfg");
  writeFileSync(config, "[flake8]\nmax-line-length = 200\n");

  try {
    const result = await runCommand(
      `flake8 --append-config "${config}"`,
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

test("flake8 --output-file inside the project root still reaches confirmation", async () => {
  const result = await runCommand("flake8 --output-file report.txt");

  assert.equal("requires_confirmation" in result, true);
});

test("ruff --cache-dir cannot write outside the project root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "execution-outside-"));

  try {
    const result = await runCommand(
      `ruff check --cache-dir "${outside}"`,
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
