import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runChildProcess } from "./child-process.ts";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("runChildProcess terminates a running process when the signal is aborted", async () => {
  const controller = new AbortController();
  const promise = runChildProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    timeout: 5000,
    signal: controller.signal,
    maxBuffer: 10000,
    env: process.env,
  });

  setTimeout(() => controller.abort(), 50);

  await assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, "ABORT_ERR");
    return true;
  });
});

test("runChildProcess reports timeout after the child has closed", async () => {
  const promise = runChildProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    timeout: 50,
    maxBuffer: 10000,
    env: process.env,
  });

  await assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, "ETIMEDOUT");
    return true;
  });
});

test("runChildProcess preserves signal termination as a failure", { skip: process.platform === "win32" }, async () => {
  const promise = runChildProcess(
    process.execPath,
    ["-e", "process.kill(process.pid, 'SIGTERM')"],
    {
      cwd: process.cwd(),
      timeout: 5000,
      maxBuffer: 10000,
      env: process.env,
    },
  );

  await assert.rejects(promise, (error: Error & { code?: string; signal?: string }) => {
    assert.equal(error.code, "SIGTERM");
    assert.equal(error.signal, "SIGTERM");
    return true;
  });
});

test("Windows cancellation terminates descendants, not just the direct child", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terminal-child-tree-"));
  const pidFile = join(dir, "child.pid");

  try {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(" + JSON.stringify(pidFile) + ", String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("");

    const controller = new AbortController();
    const promise = runChildProcess(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeout: 5000,
      signal: controller.signal,
      maxBuffer: 10000,
      env: process.env,
    });

    await waitForFile(pidFile);
    assert.ok(existsSync(pidFile), "descendant PID file was not created");

    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

    controller.abort();

    await assert.rejects(promise, (error: Error & { code?: string }) => {
      assert.equal(error.code, "ABORT_ERR");
      return true;
    });

    const deadline = Date.now() + 2000;
    while (isProcessAlive(descendantPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(isProcessAlive(descendantPid), false, "descendant process survived cancellation");
  } finally {
    if (process.platform === "win32" && existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});