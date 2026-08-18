import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  __resetProjectRootForTests,
  __setConfigDirForTests,
  __setProjectRootForTests,
  CHOOSE_PROJECT_ROOT,
  getProjectRoot,
  isAbsoluteOnAnyPlatform,
  isPathWithinRoot,
  isSensitiveFilename,
  isSensitivePath,
  resolveFollowingSymlinks,
  safePath,
  SecurityValidationError,
  setProjectRoot,
} from "./security.js";

// Every test gets its own throwaway project directory, mirroring the
// `project_root` pytest fixture in server-python/tests/test_tools.py:
// security.PROJECT_ROOT is patched directly for the duration of the test,
// then restored, instead of touching the real project root.
let projectRoot: string;
let originalProjectRoot: string;

beforeEach(() => {
  originalProjectRoot = getProjectRoot();
  projectRoot = mkdtempSync(join(tmpdir(), "ai-terminal-chat-security-test-"));
  __setProjectRootForTests(projectRoot);
});

afterEach(() => {
  __setProjectRootForTests(originalProjectRoot);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("safePath", () => {
  test("accepts a project-relative path", () => {
    const resolved = safePath("server-python");
    assert.equal(resolved, join(projectRoot, "server-python"));
  });

  // server-python/tests/test_tools.py: test_safe_path_rejects_windows_absolute_paths
  for (const path of [
    "C:\\Users\\test\\secret.txt",
    "C:\\Windows\\System32\\config\\SAM",
    "D:\\secrets.txt",
    "\\\\server\\share\\file.txt",
  ]) {
    test(`rejects Windows-style absolute path: ${path}`, () => {
      assert.throws(() => safePath(path), (err: unknown) => {
        assert.ok(err instanceof SecurityValidationError);
        assert.match(err.message, /Absolute paths/);
        return true;
      });
    });
  }

  // server-python/tests/test_tools.py: test_safe_path_rejects_posix_absolute_paths
  for (const path of ["/etc/passwd", "/root/.ssh/id_rsa", "/var/log/auth.log"]) {
    test(`rejects POSIX absolute path: ${path}`, () => {
      assert.throws(() => safePath(path), (err: unknown) => {
        assert.ok(err instanceof SecurityValidationError);
        assert.match(err.message, /Absolute paths/);
        return true;
      });
    });
  }

  // server-python/tests/test_tools.py: test_safe_path_rejects_traversal_variants
  for (const path of [
    "../outside.txt",
    "../../etc/passwd",
    "../../../../../../etc/passwd",
    "subdir/../../outside.txt",
    "a/b/../../../outside.txt",
  ]) {
    test(`rejects traversal variant: ${path}`, () => {
      assert.throws(() => safePath(path), (err: unknown) => {
        assert.ok(err instanceof SecurityValidationError);
        assert.match(err.message, /outside the project/);
        return true;
      });
    });
  }

  // server-python/tests/test_tools.py:
  // test_safe_path_rejects_dotdot_that_resolves_back_inside_is_still_fine
  test("allows a dotdot that resolves back inside the project", () => {
    mkdirSync(join(projectRoot, "sub"));
    const resolved = safePath("sub/../sub/file.txt");
    assert.equal(resolved, join(projectRoot, "sub", "file.txt"));
  });

  test("rejects an empty path", () => {
    assert.throws(() => safePath(""), SecurityValidationError);
    assert.throws(() => safePath("   "), SecurityValidationError);
  });

  // New regression test — not present in server-python's own pytest suite,
  // but verified directly against server-python's runtime behavior before
  // porting: a symlink inside the project pointing outside PROJECT_ROOT is
  // rejected, because Python's Path.resolve() follows symlinks. See the
  // module-level SECURITY NOTE in security.ts.
  test("rejects a symlink that escapes the project root", () => {
    const outside = mkdtempSync(join(tmpdir(), "ai-terminal-chat-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "sensitive-data");
      symlinkSync(outside, join(projectRoot, "escape_link"), "dir");

      assert.throws(() => safePath("escape_link/secret.txt"), (err: unknown) => {
        assert.ok(err instanceof SecurityValidationError);
        assert.match(err.message, /outside the project/);
        return true;
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("allows a symlink that resolves back inside the project", () => {
    mkdirSync(join(projectRoot, "real_sub"));
    symlinkSync(join(projectRoot, "real_sub"), join(projectRoot, "link_sub"), "dir");

    const resolved = safePath("link_sub/not_yet_created.txt");
    assert.equal(resolved, join(projectRoot, "real_sub", "not_yet_created.txt"));
  });

  test("allows a path that does not exist yet (about to be created)", () => {
    const resolved = safePath("brand/new/file.txt");
    assert.equal(resolved, join(projectRoot, "brand", "new", "file.txt"));
  });
});

describe("isAbsoluteOnAnyPlatform", () => {
  test("flags POSIX and Windows absolute forms regardless of host OS", () => {
    for (const path of [
      "/etc/passwd",
      "C:\\Users\\test\\secret.txt",
      "D:\\secrets.txt",
      "\\\\server\\share\\file.txt",
    ]) {
      assert.equal(isAbsoluteOnAnyPlatform(path), true, path);
    }
  });

  test("does not flag relative paths", () => {
    for (const path of ["relative/path.txt", "../outside.txt", "file.txt"]) {
      assert.equal(isAbsoluteOnAnyPlatform(path), false, path);
    }
  });
});

describe("isPathWithinRoot", () => {
  test("case-sensitive mode (POSIX default)", () => {
    const root = `${sep}root`;
    assert.equal(isPathWithinRoot(root, `${root}${sep}sub`, { caseInsensitive: false }), true);
    assert.equal(
      isPathWithinRoot(root, `${sep}ROOT${sep}sub`, { caseInsensitive: false }),
      false,
    );
    assert.equal(
      isPathWithinRoot(root, `${root}other${sep}sub`, { caseInsensitive: false }),
      false,
    );
  });

  test("case-insensitive mode (Windows default)", () => {
    const root = `${sep}root`;
    assert.equal(
      isPathWithinRoot(root, `${sep}ROOT${sep}sub`, { caseInsensitive: true }),
      true,
    );
  });

  test("the root path itself is within itself", () => {
    assert.equal(isPathWithinRoot("/root", "/root"), true);
  });
});

describe("resolveFollowingSymlinks", () => {
  test("resolves a non-existent path lexically without throwing", () => {
    const resolved = resolveFollowingSymlinks(join(projectRoot, "brand", "new", "file.txt"));
    assert.equal(resolved, join(projectRoot, "brand", "new", "file.txt"));
  });

  test("follows an existing symlink", () => {
    const target = join(projectRoot, "target");
    mkdirSync(target);
    const link = join(projectRoot, "link");
    symlinkSync(target, link, "dir");

    const resolved = resolveFollowingSymlinks(join(link, "inner.txt"));
    assert.equal(resolved, join(target, "inner.txt"));
  });
});

describe("isSensitiveFilename", () => {
  // server-python/tests/test_tools.py: test_sensitive_filenames_are_blocked
  for (const filename of [".env", ".env.local", "credentials.json", "private.key", "server.pem"]) {
    test(`blocks: ${filename}`, () => {
      assert.equal(isSensitiveFilename(filename), true);
    });
  }

  for (const filename of ["id_rsa", "id_ed25519", "id_ecdsa", "secrets.json", ".git-credentials"]) {
    test(`blocks exact sensitive name: ${filename}`, () => {
      assert.equal(isSensitiveFilename(filename), true);
    });
  }

  for (const filename of ["my_secret_config.yaml", "db_credential_store.txt"]) {
    test(`blocks filename containing 'secret'/'credential': ${filename}`, () => {
      assert.equal(isSensitiveFilename(filename), true);
    });
  }

  for (const filename of ["app.ts", "README.md", "package.json", "index.html"]) {
    test(`allows ordinary filename: ${filename}`, () => {
      assert.equal(isSensitiveFilename(filename), false);
    });
  }
});

describe("isSensitivePath", () => {
  // server-python/tests/test_tools.py: test_is_sensitive_path_blocks_anything_under_dot_git
  test("blocks anything under .git", () => {
    mkdirSync(join(projectRoot, ".git"));
    assert.equal(isSensitivePath(join(projectRoot, ".git", "config")), true);
    assert.equal(isSensitivePath(join(projectRoot, ".git", "hooks", "pre-commit")), true);
  });

  // server-python/tests/test_tools.py: test_is_sensitive_path_blocks_env_and_credential_files
  test("blocks env and credential files", () => {
    for (const name of [".env", ".env.production", "credentials.json", "id_rsa", "server.pem"]) {
      assert.equal(isSensitivePath(join(projectRoot, name)), true, name);
    }
  });

  test("allows an ordinary file", () => {
    assert.equal(isSensitivePath(join(projectRoot, "app.ts")), false);
  });

  test("treats a path outside the project root as sensitive (defense in depth)", () => {
    const outside = mkdtempSync(join(tmpdir(), "ai-terminal-chat-outside-"));
    try {
      assert.equal(isSensitivePath(join(outside, "notes.txt")), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("project root persistence", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ai-terminal-chat-config-test-"));
    __setConfigDirForTests(configDir);
  });

  afterEach(() => {
    __setConfigDirForTests(null);
    rmSync(configDir, { recursive: true, force: true });
  });

  // server-python/tests/test_project_root.py: test_set_project_root_persists_and_updates_proxy
  test("persists and updates the in-memory root", () => {
    const target = mkdtempSync(join(tmpdir(), "ai-terminal-chat-target-"));
    try {
      const selected = setProjectRoot(target);

      assert.equal(selected, target);
      assert.equal(getProjectRoot(), target);
      assert.equal(safePath("example.txt"), join(target, "example.txt"));

      const configFile = join(configDir, "config.json");
      const config = JSON.parse(readFileSync(configFile, "utf8")) as { project_root: string };
      assert.equal(config.project_root, target);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // Regression test for the config-persistence parity gap found during
  // Phase 2 review: security.py's `_persist_project_root()` was changed
  // (by the Allowed Commands feature) to load/merge/persist the whole
  // config object instead of overwriting it with only `{ project_root }`,
  // so that keys like `allowed_commands` (set via /allowed-commands and
  // read by tools.ts in Phase 3) survive a project-root change. Verified
  // empirically against the current server-python before this fix: seeding
  // config.json with `{"allowed_commands": ["echo", "wsl"]}` and then
  // calling `security._persist_project_root()` there preserves
  // `allowed_commands`; the un-fixed TypeScript implementation silently
  // deleted it.
  test("preserves unrelated existing config keys (e.g. allowed_commands) when the project root changes", () => {
    const target = mkdtempSync(join(tmpdir(), "ai-terminal-chat-target-"));
    try {
      const configFile = join(configDir, "config.json");
      writeFileSync(
        configFile,
        JSON.stringify({ allowed_commands: ["echo", "wsl"] }),
      );

      setProjectRoot(target);

      const config = JSON.parse(readFileSync(configFile, "utf8")) as {
        project_root: string;
        allowed_commands: string[];
      };
      assert.deepEqual(config.allowed_commands, ["echo", "wsl"]);
      assert.equal(config.project_root, target);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // Companion case for requirement 5: a config file that does not exist
  // yet must still work exactly as before — persistProjectRoot() creates
  // it from scratch rather than requiring a pre-existing file to merge into.
  test("creates a new config file from scratch when none exists yet", () => {
    const target = mkdtempSync(join(tmpdir(), "ai-terminal-chat-target-"));
    try {
      const configFile = join(configDir, "config.json");
      assert.equal(existsSync(configFile), false);

      setProjectRoot(target);

      const config = JSON.parse(readFileSync(configFile, "utf8")) as { project_root: string };
      assert.deepEqual(Object.keys(config), ["project_root"]);
      assert.equal(config.project_root, target);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("rejects a path that does not exist", () => {
    assert.throws(
      () => setProjectRoot(join(configDir, "does-not-exist")),
      SecurityValidationError,
    );
  });

  test("rejects a path that is not a directory", () => {
    const file = join(configDir, "a-file.txt");
    writeFileSync(file, "hello");
    assert.throws(() => setProjectRoot(file), SecurityValidationError);
  });

  test("rejects an empty path", () => {
    assert.throws(() => setProjectRoot(""), SecurityValidationError);
    assert.throws(() => setProjectRoot("   "), SecurityValidationError);
  });

  // Intentional behavioral difference from server-python (documented in the
  // Phase 2 report): the native-folder-picker sentinel is rejected with a
  // clear error instead of opening a server-side Tkinter dialog, since
  // client-react never sends this sentinel in practice (it uses its own
  // Electron/browser folder picker).
  test("rejects the CHOOSE_PROJECT_ROOT sentinel with a clear error", () => {
    assert.throws(() => setProjectRoot(CHOOSE_PROJECT_ROOT), (err: unknown) => {
      assert.ok(err instanceof SecurityValidationError);
      assert.match(err.message, /native folder picker/);
      return true;
    });
  });
});

describe("getProjectRoot loading", () => {
  let configDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ai-terminal-chat-config-test-"));
    __setConfigDirForTests(configDir);
    __resetProjectRootForTests();
    originalEnv = process.env.AI_TERMINAL_PROJECT_ROOT;
    delete process.env.AI_TERMINAL_PROJECT_ROOT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_TERMINAL_PROJECT_ROOT;
    } else {
      process.env.AI_TERMINAL_PROJECT_ROOT = originalEnv;
    }
    __setConfigDirForTests(null);
    __setProjectRootForTests(originalProjectRoot);
    rmSync(configDir, { recursive: true, force: true });
  });

  test("honors AI_TERMINAL_PROJECT_ROOT over the config file", () => {
    const envRoot = mkdtempSync(join(tmpdir(), "ai-terminal-chat-env-root-"));
    const configuredRoot = mkdtempSync(join(tmpdir(), "ai-terminal-chat-config-root-"));
    try {
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ project_root: configuredRoot }),
      );
      process.env.AI_TERMINAL_PROJECT_ROOT = envRoot;

      assert.equal(getProjectRoot(), resolveFollowingSymlinks(envRoot));
    } finally {
      rmSync(envRoot, { recursive: true, force: true });
      rmSync(configuredRoot, { recursive: true, force: true });
    }
  });

  test("falls back to cwd when nothing is configured", () => {
    assert.equal(getProjectRoot(), resolveFollowingSymlinks(process.cwd()));
  });

  test("ignores a config file pointing at a non-existent directory", () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ project_root: join(configDir, "does-not-exist") }),
    );
    assert.equal(getProjectRoot(), resolveFollowingSymlinks(process.cwd()));
  });
});
