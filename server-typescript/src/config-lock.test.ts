import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  acquireConfigLock,
  releaseConfigLock,
  holdConfigLock,
  configLockPath,
  isProcessAlive,
  isLockOwnerDead,
  parseLockOwner,
  processStartToken,
  CONFIG_LOCK_TIMEOUT_MS,
  __ownStartTokenForTests,
} from "./config-lock.ts";

describe("config-lock", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-lock-test-"));
    target = join(dir, "config.json");
    writeFileSync(target, "{}\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquire/release normally", () => {
    const handle = acquireConfigLock(target, { timeoutMs: 1000 });
    assert.ok(existsSync(handle.lockPath));
    const raw = readFileSync(handle.lockPath, "utf8");
    const owner = parseLockOwner(raw);
    assert.ok(owner);
    assert.equal(owner!.pid, process.pid);
    assert.equal(owner!.v, 1);
    assert.ok(typeof owner!.createdAt === "number");
    releaseConfigLock(handle.lockFd, handle.lockPath);
    assert.ok(!existsSync(handle.lockPath));
  });

  test("holdConfigLock runs and cleans up", () => {
    const lockPath = configLockPath(target);
    const result = holdConfigLock(target, () => 42, { timeoutMs: 1000 });
    assert.equal(result, 42);
    assert.ok(!existsSync(lockPath));
  });

  test("active owner cannot be reclaimed", () => {
    const handle = acquireConfigLock(target, { timeoutMs: 500 });
    assert.throws(
      () => acquireConfigLock(target, { timeoutMs: 300 }),
      /Could not acquire config lock/,
    );
    assert.ok(existsSync(handle.lockPath));
    releaseConfigLock(handle.lockFd, handle.lockPath);
  });

  test("dead PID is reclaimed", () => {
    const lockPath = configLockPath(target);
    const deadPid = 2147483646;
    assert.equal(isProcessAlive(deadPid), false);
    writeFileSync(
      lockPath,
      JSON.stringify({
        v: 1,
        pid: deadPid,
        startToken: "dead-token",
        createdAt: Date.now() - 10000,
      }),
    );
    const handle = acquireConfigLock(target, { timeoutMs: 1000 });
    assert.ok(existsSync(handle.lockPath));
    releaseConfigLock(handle.lockFd, handle.lockPath);
  });

  test("PID reuse / start-token mismatch is reclaimed", () => {
    const lockPath = configLockPath(target);
    writeFileSync(
      lockPath,
      JSON.stringify({
        v: 1,
        pid: process.pid,
        startToken: "not-the-real-token",
        createdAt: Date.now() - 10000,
      }),
    );
    const owner = parseLockOwner(readFileSync(lockPath, "utf8"))!;
    if (processStartToken(process.pid)) {
      assert.equal(isLockOwnerDead(owner), true);
    }
    const handle = acquireConfigLock(target, { timeoutMs: 1000 });
    releaseConfigLock(handle.lockFd, handle.lockPath);
  });

  test("malformed lock is not reclaimed while fresh", () => {
    const lockPath = configLockPath(target);
    writeFileSync(lockPath, "not-json{{{");
    assert.throws(
      () => acquireConfigLock(target, { timeoutMs: 200 }),
      /Could not acquire config lock/,
    );
    assert.ok(existsSync(lockPath));
  });

  test("malformed lock is reclaimed after timeout age", () => {
    const lockPath = configLockPath(target);
    writeFileSync(lockPath, "not-json{{{");
    const old = (Date.now() - CONFIG_LOCK_TIMEOUT_MS - 1000) / 1000;
    utimesSync(lockPath, old, old);
    const handle = acquireConfigLock(target, { timeoutMs: 1000 });
    assert.ok(existsSync(handle.lockPath));
    releaseConfigLock(handle.lockFd, handle.lockPath);
  });

  test("legacy empty lock is reclaimed after timeout age", () => {
    const lockPath = configLockPath(target);
    writeFileSync(lockPath, "");
    const old = (Date.now() - CONFIG_LOCK_TIMEOUT_MS - 1000) / 1000;
    utimesSync(lockPath, old, old);
    const handle = acquireConfigLock(target, { timeoutMs: 1000 });
    assert.ok(existsSync(handle.lockPath));
    releaseConfigLock(handle.lockFd, handle.lockPath);
  });

  test("lock metadata is written correctly", () => {
    const handle = acquireConfigLock(target, { timeoutMs: 1000 });
    const raw = readFileSync(handle.lockPath, "utf8");
    const owner = parseLockOwner(raw)!;
    assert.equal(owner.v, 1);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.startToken, __ownStartTokenForTests());
    assert.ok(owner.createdAt <= Date.now());
    releaseConfigLock(handle.lockFd, handle.lockPath);
  });

  test("failed acquisition preserves the existing lock", () => {
    const handle = acquireConfigLock(target, { timeoutMs: 1000 });
    const original = readFileSync(handle.lockPath, "utf8");

    assert.throws(
      () => acquireConfigLock(target, { timeoutMs: 200 }),
      /Could not acquire config lock/,
    );

    assert.ok(existsSync(handle.lockPath));
    assert.equal(readFileSync(handle.lockPath, "utf8"), original);
    releaseConfigLock(handle.lockFd, handle.lockPath);
  });

  test("isProcessAlive: current process", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  test("isProcessAlive: dead PID", () => {
    assert.equal(isProcessAlive(2147483646), false);
  });

  test("processStartToken returns non-empty for self when available", () => {
    const token = processStartToken(process.pid);
    if (token !== null) {
      assert.ok(token.length > 0);
    }
  });

  test("Windows process-start detection path is loadable", () => {
    assert.doesNotThrow(() => processStartToken(process.pid));
  });
});
